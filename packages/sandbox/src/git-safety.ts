/**
 * Git repositories that arrive in the sandbox as DATA — a tarball, a zip, a
 * clone, a Slack attachment — carry executable configuration with them:
 * `.git/hooks/*` scripts, and `.git/config` keys that name a command to run
 * (`core.hooksPath`, `core.fsmonitor`, `core.sshCommand`, `filter.*.clean`,
 * `diff.*.external`, aliases, …). The next ordinary git command then executes
 * whatever the archive's author put there.
 *
 * kyto neutralizes that in CODE, not by telling the model to remember to do it:
 *  - `GIT_HARDEN_COMMAND` runs every time a sandbox materializes and points the
 *    global hook path at /dev/null, so no hook ever runs by default;
 *  - `sanitizeGitRepos` runs right after any tool call that could have brought a
 *    repo in (see `mayHaveFetchedRepo`) and physically removes hook scripts and
 *    the command-executing keys from every repo config it finds — which also
 *    covers a repo-local `core.hooksPath` that would otherwise override the
 *    global setting.
 */

/** Minimal view of a sandbox session (LazySandbox satisfies it). */
export interface GitSafetyRunner {
  run(input: {
    abortSignal?: AbortSignal;
    command: string;
    workingDirectory?: string;
  }): PromiseLike<{ exitCode: number; stderr: string; stdout: string }>;
}

/**
 * Global git hardening, applied on every materialization (fresh or resumed), so
 * it is idempotent by construction. `core.hooksPath=/dev/null` is the blanket
 * off-switch: git looks for `/dev/null/<hook>`, never finds one, and runs
 * nothing. `protocol.ext.allow=never` blocks `ext::<command>` transport URLs
 * (an RCE vector via a submodule or a crafted remote).
 */
export const GIT_HARDEN_COMMAND = [
  'git config --global core.hooksPath /dev/null',
  'git config --global core.fsmonitor false',
  'git config --global protocol.ext.allow never',
].join(' && ');

// Commands that can put a repository on disk: archive extraction, downloads,
// clones, and the archive APIs of the scripting languages we have installed.
const REPO_SOURCE = new RegExp(
  [
    '\\b(?:tar|bsdtar|unzip|zipinfo|7z|7za|unar|unrar|gunzip|zcat|xz|unxz|zstd)\\b',
    '\\b(?:git|gh)\\s+(?:repo\\s+)?clone\\b',
    '\\bgh\\s+release\\s+download\\b',
    '\\b(?:curl|wget|aria2c|scp|rsync|degit|git-archive)\\b',
    '\\b(?:unpack_archive|zipfile|tarfile|extractall)\\b',
  ].join('|'),
  'i'
);

/** Whether a command could have brought a git repo into the sandbox. */
export function mayHaveFetchedRepo(command: string): boolean {
  return REPO_SOURCE.test(command);
}

// Config keys whose value is a COMMAND git will execute. Removed from every
// repo-local config we find. Sub-sectioned drivers (`[filter "x"]`, …) are
// dropped wholesale further down.
const EXEC_KEYS = [
  'core.hookspath',
  'core.fsmonitor',
  'core.sshcommand',
  'core.gitproxy',
  'core.askpass',
  'core.pager',
  'core.editor',
  'core.alternaterefscommand',
  'diff.external',
  'sequence.editor',
  'gpg.program',
  'web.browser',
  'init.templatedir',
  'protocol.ext.allow',
  'include.path',
];

// Whole sections that exist to name commands (or to pull in another config).
const EXEC_SECTIONS = [
  'filter',
  'difftool',
  'mergetool',
  'alias',
  'pager',
  'browser',
  'credential',
  'includeif',
];

// Sub-sectioned forms of otherwise ordinary sections: `[diff "poison"]` and
// `[merge "poison"]` hold textconv/driver commands, while plain `[diff]` /
// `[merge]` are mostly harmless (their exec keys are in EXEC_KEYS).
const EXEC_SUBSECTIONS = ['diff', 'merge'];

const SANITIZER = `
import json, os, sys

EXEC_KEYS = set(${JSON.stringify(EXEC_KEYS)})
EXEC_SECTIONS = set(${JSON.stringify(EXEC_SECTIONS)})
EXEC_SUBSECTIONS = set(${JSON.stringify(EXEC_SUBSECTIONS)})
MAX_DIRS = 50000

removed_hooks = 0
removed_keys = []
repos = []

def clean_config(path):
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as handle:
            lines = handle.readlines()
    except OSError:
        return
    out = []
    section = ''
    subsection = False
    drop_section = False
    changed = False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith('['):
            head = stripped[1:].split(']')[0].strip()
            parts = head.split(None, 1)
            section = parts[0].strip('"').lower()
            subsection = len(parts) > 1
            drop_section = section in EXEC_SECTIONS or (
                subsection and section in EXEC_SUBSECTIONS
            )
            if drop_section:
                removed_keys.append(head)
                changed = True
                continue
            out.append(line)
            continue
        if drop_section:
            changed = True
            continue
        if '=' in stripped and not stripped.startswith('#') and not stripped.startswith(';'):
            key = stripped.split('=', 1)[0].strip().lower()
            if section + '.' + key in EXEC_KEYS:
                removed_keys.append(section + '.' + key)
                changed = True
                continue
        out.append(line)
    if changed:
        try:
            with open(path, 'w', encoding='utf-8') as handle:
                handle.writelines(out)
        except OSError:
            pass

def clean_gitdir(gitdir):
    global removed_hooks
    if gitdir in repos:
        return
    repos.append(gitdir)
    hooks = os.path.join(gitdir, 'hooks')
    if os.path.isdir(hooks):
        for name in os.listdir(hooks):
            target = os.path.join(hooks, name)
            try:
                if os.path.isfile(target) or os.path.islink(target):
                    os.remove(target)
                    removed_hooks += 1
            except OSError:
                pass
    config = os.path.join(gitdir, 'config')
    if os.path.isfile(config):
        clean_config(config)

def resolve_gitfile(path):
    # A worktree/submodule '.git' FILE points at the real git dir.
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as handle:
            head = handle.read(4096).strip()
    except OSError:
        return None
    if not head.startswith('gitdir:'):
        return None
    target = head.split(':', 1)[1].strip()
    if not os.path.isabs(target):
        target = os.path.join(os.path.dirname(path), target)
    return os.path.normpath(target)

visited = 0
for root in sys.argv[1:]:
    if not os.path.isdir(root):
        continue
    for dirpath, dirnames, filenames in os.walk(root):
        visited += 1
        if visited > MAX_DIRS:
            break
        if os.path.basename(dirpath) == '.git' or (
            'HEAD' in filenames and 'config' in filenames and 'objects' in dirnames
        ):
            clean_gitdir(dirpath)
            # Keep descending: submodule git dirs live under .git/modules/*.
            continue
        if '.git' in filenames:
            target = resolve_gitfile(os.path.join(dirpath, '.git'))
            if target and os.path.isdir(target):
                clean_gitdir(target)

print(json.dumps({
    'repos': len(repos),
    'hooks': removed_hooks,
    'keys': sorted(set(removed_keys)),
}))
`;

export interface GitSanitizeResult {
  /** Hook scripts deleted. */
  hooks: number;
  /** Config keys/sections stripped, like \`core.hooksPath\`. */
  keys: string[];
  /** Repositories inspected. */
  repos: number;
}

/**
 * Strip hooks and command-executing config from every git repo under `dirs`.
 * Best effort: a failure here must never fail the tool call that triggered it,
 * so it resolves to null instead of throwing.
 */
export async function sanitizeGitRepos({
  abortSignal,
  dirs,
  runner,
}: {
  abortSignal?: AbortSignal;
  /** Directories to scan (absolute paths). */
  dirs: string[];
  runner: GitSafetyRunner;
}): Promise<GitSanitizeResult | null> {
  if (dirs.length === 0) {
    return null;
  }
  const args = dirs.map((dir) => `'${dir.replaceAll("'", "'\\''")}'`).join(' ');
  const command = `python3 - ${args} <<'KYTO_GIT_SAFETY'\n${SANITIZER}\nKYTO_GIT_SAFETY`;
  try {
    const result = await runner.run({ abortSignal, command });
    if (result.exitCode !== 0) {
      return null;
    }
    const parsed = JSON.parse(result.stdout.trim()) as GitSanitizeResult;
    return parsed;
  } catch {
    return null;
  }
}
