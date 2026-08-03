// Static analysis of a shell command for "which GitHub repos does this WRITE
// to?", so the ownership gate can run before the command does. It is a
// guardrail, not a sandbox boundary: it reads the command text, which is enough
// for how kyto actually reaches GitHub (`gh`, `git push`, and curl against the
// REST API), and errs toward calling something mutating when it can't tell.

const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REPO_URL =
  /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/#?\s"']|$)/g;
const API_REPO_PATH =
  /(?:^|[/\s"'=])repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/g;
const TOKENS = /"([^"]*)"|'([^']*)'|(\S+)/g;
// A gh/git invocation anywhere in the text, up to the next shell separator.
const INVOCATION = /(?:^|[\s;&|"'`($])((?:gh|git)\s+[^;&|\n]*)/g;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRITE_METHOD = /\b(?:POST|PUT|PATCH|DELETE)\b/i;

// gh subcommands that only READ. Anything outside this map — including a
// subcommand we've never heard of — counts as mutating.
const READ_ONLY_VERBS: Record<string, Set<string>> = {
  cache: new Set(['list']),
  extension: new Set(['list', 'search']),
  gist: new Set(['list', 'view', 'clone']),
  issue: new Set(['list', 'view', 'status']),
  label: new Set(['list', 'clone']),
  org: new Set(['list']),
  pr: new Set(['list', 'view', 'status', 'diff', 'checks', 'checkout']),
  project: new Set(['list', 'view']),
  release: new Set(['list', 'view', 'download']),
  repo: new Set(['list', 'view', 'clone', 'fork', 'license', 'gitignore']),
  ruleset: new Set(['list', 'view', 'check']),
  run: new Set(['list', 'view', 'watch', 'download']),
  secret: new Set(['list']),
  variable: new Set(['list']),
  workflow: new Set(['list', 'view']),
};

// gh command groups that never write to a repo, whatever the subcommand.
const READ_ONLY_GROUPS = new Set([
  'alias',
  'browse',
  'completion',
  'config',
  'help',
  'search',
  'status',
  'version',
]);

// git subcommands that push to a remote. Everything else git does is local.
const MUTATING_GIT = new Set(['push', 'send-pack']);

export interface ParsedGithubCommand {
  /** Repos this command would CREATE (claimed on success, never gated). */
  creates: string[];
  /** True when some part of the command writes to GitHub. */
  mutating: boolean;
  /**
   * True when a push names no explicit repo, so the target can only be resolved
   * from the checkout's remote (the caller does that against the sandbox).
   */
  needsRemote: boolean;
  /** Every repo the command names, lowercased "owner/name". */
  repos: string[];
}

function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  for (const match of segment.matchAll(TOKENS)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return tokens;
}

function reposInText(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(REPO_URL)) {
    found.push(`${match[1]}/${match[2]}`);
  }
  for (const match of text.matchAll(API_REPO_PATH)) {
    found.push(`${match[1]}/${match[2]}`);
  }
  return found;
}

/** Repos named by gh's own flags and bare `owner/name` arguments. */
function reposInGhTokens(tokens: string[]): string[] {
  const found: string[] = [];
  for (const [index, token] of tokens.entries()) {
    if (token === '--repo' || token === '-R') {
      const next = tokens[index + 1];
      if (next && SLUG.test(next)) {
        found.push(next);
      }
      continue;
    }
    const flagValue = /^(?:--repo|-R)=(.+)$/.exec(token);
    if (flagValue?.[1] && SLUG.test(flagValue[1])) {
      found.push(flagValue[1]);
      continue;
    }
    if (index > 0 && !token.startsWith('-') && SLUG.test(token)) {
      found.push(token);
    }
  }
  return found;
}

function isReadOnlyGh(tokens: string[]): boolean {
  const args = tokens.slice(1).filter((token) => !token.startsWith('-'));
  const group = args.at(0);
  if (!group) {
    // Bare `gh` prints help.
    return true;
  }
  if (READ_ONLY_GROUPS.has(group)) {
    return true;
  }
  if (group === 'api') {
    const text = tokens.join(' ');
    const hasWriteMethod =
      /(?:-X|--method)[\s=]*(?:POST|PUT|PATCH|DELETE)/i.test(text);
    const hasFields = tokens.some((token) =>
      ['-f', '-F', '--field', '--raw-field', '--input'].includes(token)
    );
    const isGraphqlMutation =
      args.includes('graphql') && /\bmutation\b/i.test(text);
    return !(hasWriteMethod || hasFields || isGraphqlMutation);
  }
  const verbs = READ_ONLY_VERBS[group];
  const verb = args.at(1);
  return Boolean(verb && verbs?.has(verb));
}

/** `gh repo create <slug>` — the one gh command that brings a repo into being. */
function createdRepos(tokens: string[]): string[] {
  const args = tokens.slice(1).filter((token) => !token.startsWith('-'));
  if (args[0] !== 'repo' || args[1] !== 'create') {
    return [];
  }
  const slug = args[2];
  return slug && SLUG.test(slug) ? [slug] : [];
}

/**
 * Which repos a command writes to. `gh`/`git` invocations are found wherever
 * they appear, not just at the start of a segment, so quoting or wrapping them
 * (`sh -c "gh pr close …"`, or a Code Mode script calling `sh('gh …')`) doesn't
 * slip past the gate. The cost is the odd false positive on text that merely
 * looks like a command, which only ever means a refusal on a repo someone else
 * owns — the safe direction.
 */
export function parseGithubCommand(command: string): ParsedGithubCommand {
  const repos = new Set<string>();
  const creates = new Set<string>();
  let mutating = false;
  let needsRemote = false;

  for (const match of command.matchAll(INVOCATION)) {
    const invocation = (match[1] ?? '').replace(/["'`)\\]+$/, '');
    const tokens = tokenize(invocation).filter(
      (token) => !ENV_ASSIGNMENT.test(token)
    );
    const name = tokens.at(0);
    const named = reposInText(invocation);

    if (name === 'gh') {
      if (isReadOnlyGh(tokens)) {
        continue;
      }
      mutating = true;
      for (const repo of [...named, ...reposInGhTokens(tokens)]) {
        repos.add(repo.toLowerCase());
      }
      for (const repo of createdRepos(tokens)) {
        creates.add(repo.toLowerCase());
      }
      continue;
    }

    const verb = tokens.slice(1).find((token) => !token.startsWith('-'));
    if (!(verb && MUTATING_GIT.has(verb))) {
      continue;
    }
    mutating = true;
    if (named.length === 0) {
      needsRemote = true;
    }
    for (const repo of named) {
      repos.add(repo.toLowerCase());
    }
  }

  // curl/wget straight at the REST API is the other way to write to GitHub.
  for (const segment of command.split(/[;\n]|&&|\|\||\|/)) {
    const named = reposInText(segment);
    if (
      named.length > 0 &&
      /\b(?:curl|wget|http)\b/.test(segment) &&
      /api\.github\.com|github\.com/.test(segment) &&
      (WRITE_METHOD.test(segment) || /\s(?:-d|--data|--json)\b/.test(segment))
    ) {
      mutating = true;
      for (const repo of named) {
        repos.add(repo.toLowerCase());
      }
    }
  }

  return {
    creates: [...creates],
    mutating,
    needsRemote,
    repos: [...repos],
  };
}
