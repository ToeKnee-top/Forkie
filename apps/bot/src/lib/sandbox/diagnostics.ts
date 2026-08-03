import nodePath from 'node:path/posix';
import type { SandboxContext } from '@repo/ai';
import { clamp } from '@/lib/utils/text';

// Post-edit diagnostics: after kyto writes or edits a file in the sandbox, run a
// cheap check on it and hand the result straight back in the tool result, so the
// model SEES what it just broke instead of only finding out if it happens to
// think of running something.
//
// Two rules keep this from doing more harm than good:
//   1. A check that cannot run reports NOTHING. A missing interpreter, a timeout
//      or an unknown file type must never surface as "your code is broken" — a
//      fabricated error in the tool result is worse than no error at all.
//   2. It is advisory. The write already happened and still counts as a success;
//      diagnostics ride along beside it.

// Per-file syntax checks are sub-second; this only bounds a pathological file.
const SYNTAX_TIMEOUT_SECONDS = 20;
// A project-wide `tsc --noEmit` is the expensive one (2-3s on a small repo, far
// more on a large one). Bounded hard, and skipped entirely on a timeout.
const TYPECHECK_TIMEOUT_SECONDS = 60;
// `timeout` reports this when it kills the command.
const TIMEOUT_EXIT_CODE = 124;
// POSIX shells use this for "command not found".
const NOT_FOUND_EXIT_CODE = 127;
const DIAGNOSTICS_MAX_CHARS = 2000;
// A burst of edits to one project should not pay for a full typecheck each time.
// Short enough that a model that edits, reads and thinks still gets fresh types.
const TYPECHECK_MIN_INTERVAL_MS = 10_000;
// Enough to show the failure without pasting a whole broken build log.
const MAX_DIAGNOSTIC_LINES = 20;

export interface FileDiagnostics {
  /** What produced the output, so the model knows how much to trust it. */
  checker: string;
  /** The checker's own message, clipped. Never synthesized by us. */
  output: string;
}

/** Single-quote a path for the shell (the only metacharacter left is `'`). */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

// Cheap per-file parse checks, by extension. Every command here is either
// preinstalled in the sandbox image or absent — and absent is handled as "no
// diagnostics", never as an error. `%s` is the shell-quoted file path.
const SYNTAX_CHECKS: Record<string, { checker: string; command: string }> = {
  '.bash': { checker: 'bash -n', command: 'bash -n %s' },
  '.cjs': { checker: 'node --check', command: 'node --check %s' },
  '.cts': {
    checker: 'bun (parse)',
    command: 'bun build %s --outfile=/dev/null',
  },
  '.js': { checker: 'node --check', command: 'node --check %s' },
  '.json': {
    checker: 'json.load',
    command: 'python3 -c "import json,sys;json.load(open(sys.argv[1]))" %s',
  },
  '.jsx': {
    checker: 'bun (parse)',
    command: 'bun build %s --outfile=/dev/null',
  },
  '.mjs': { checker: 'node --check', command: 'node --check %s' },
  '.mts': {
    checker: 'bun (parse)',
    command: 'bun build %s --outfile=/dev/null',
  },
  '.py': { checker: 'py_compile', command: 'python3 -m py_compile %s' },
  '.sh': { checker: 'bash -n', command: 'bash -n %s' },
  '.ts': {
    checker: 'bun (parse)',
    command: 'bun build %s --outfile=/dev/null',
  },
  '.tsx': {
    checker: 'bun (parse)',
    command: 'bun build %s --outfile=/dev/null',
  },
};

// Extensions worth a real type check on top of the parse check above.
const TYPECHECKED = new Set(['.cts', '.js', '.jsx', '.mts', '.ts', '.tsx']);

// Last project typecheck per sandbox+project, for TYPECHECK_MIN_INTERVAL_MS.
const lastTypecheck = new Map<string, number>();

/**
 * Find the nearest tsconfig.json at or above the file, find a `tsc` binary at or
 * above THAT (node_modules may live at a monorepo root), and run it. Bails with
 * exit 0 — i.e. "nothing to report" — when either is missing, so a project with
 * no TypeScript setup costs one shell round trip and says nothing.
 *
 * Done as one script rather than a walk of `readFile` calls: each round trip to
 * the sandbox costs more than the whole check does.
 */
function typecheckScript(file: string): string {
  const quoted = shellQuote(file);
  return [
    `f=${quoted}`,
    'd=$(dirname "$f")',
    'cfg=',
    'while [ "$d" != "/" ] && [ "$d" != "." ]; do',
    '  if [ -f "$d/tsconfig.json" ]; then cfg="$d/tsconfig.json"; break; fi',
    '  d=$(dirname "$d")',
    'done',
    '[ -z "$cfg" ] && exit 0',
    'b=$(dirname "$cfg")',
    'tsc=',
    'while [ "$b" != "/" ] && [ "$b" != "." ]; do',
    '  if [ -x "$b/node_modules/.bin/tsc" ]; then tsc="$b/node_modules/.bin/tsc"; break; fi',
    '  b=$(dirname "$b")',
    'done',
    '[ -z "$tsc" ] && exit 0',
    // cd into the project so tsc prints paths relative to it, which is what the
    // model needs to act on them.
    'cd "$(dirname "$cfg")" || exit 0',
    `timeout ${TYPECHECK_TIMEOUT_SECONDS} "$tsc" --noEmit -p "$cfg" 2>&1`,
  ].join('\n');
}

/**
 * Keep the lines that name the file just edited; if none do, report that the
 * project has errors elsewhere rather than pasting someone else's backlog.
 * A pre-existing failure in an unrelated file is not this edit's diagnostic, and
 * presenting it as one sends the model off fixing things nobody asked about.
 */
function focusOnFile(output: string, file: string): string | undefined {
  const lines = output.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return;
  }
  const base = nodePath.basename(file);
  const mine = lines.filter((line) => line.includes(base));
  if (mine.length > 0) {
    return mine.slice(0, MAX_DIAGNOSTIC_LINES).join('\n');
  }
  return `No errors in ${base} itself, but the project does not typecheck (${lines.length} error line(s) in other files) — check whether your change caused them.`;
}

async function runCheck({
  abortSignal,
  command,
  context,
}: {
  abortSignal?: AbortSignal;
  command: string;
  context: SandboxContext;
}): Promise<{ exitCode: number; output: string } | undefined> {
  try {
    const result = await context.session.run({ abortSignal, command });
    return {
      exitCode: result.exitCode,
      output: `${result.stdout}\n${result.stderr}`.trim(),
    };
  } catch {
    // The sandbox itself failed us. Diagnostics are advisory — swallow it rather
    // than turning a successful write into a failed tool call. Deliberately not
    // logged: `@/lib/logger` pulls in the validated env, and keeping this module
    // env-free is what lets its tests run the REAL checkers anywhere. If the
    // sandbox is actually dead, the next real tool call says so loudly.
    return;
  }
}

/** True when the exit code means "the checker never got to judge the file". */
function isInconclusive(exitCode: number): boolean {
  return exitCode === TIMEOUT_EXIT_CODE || exitCode === NOT_FOUND_EXIT_CODE;
}

/**
 * Check one file after kyto wrote it. Returns undefined when the file is clean,
 * unknown to us, or the checker could not run — see the two rules at the top.
 */
export async function fileDiagnostics({
  abortSignal,
  context,
  path,
}: {
  abortSignal?: AbortSignal;
  context: SandboxContext;
  path: string;
}): Promise<FileDiagnostics | undefined> {
  const ext = nodePath.extname(path).toLowerCase();
  const syntax = SYNTAX_CHECKS[ext];
  if (!syntax) {
    return;
  }
  const quoted = shellQuote(path);
  const parsed = await runCheck({
    abortSignal,
    command: `timeout ${SYNTAX_TIMEOUT_SECONDS} ${syntax.command.replace('%s', quoted)} 2>&1`,
    context,
  });
  if (parsed && parsed.exitCode !== 0 && !isInconclusive(parsed.exitCode)) {
    // A file that does not even parse makes any type check downstream noise.
    return {
      checker: syntax.checker,
      output:
        clamp(parsed.output, DIAGNOSTICS_MAX_CHARS) ??
        `exit code ${parsed.exitCode}`,
    };
  }
  if (!TYPECHECKED.has(ext)) {
    return;
  }
  const projectKey = `${context.sessionWorkDir}:${nodePath.dirname(path)}`;
  const last = lastTypecheck.get(projectKey) ?? 0;
  if (Date.now() - last < TYPECHECK_MIN_INTERVAL_MS) {
    return;
  }
  lastTypecheck.set(projectKey, Date.now());
  const typed = await runCheck({
    abortSignal,
    command: typecheckScript(path),
    context,
  });
  if (!typed || typed.exitCode === 0 || isInconclusive(typed.exitCode)) {
    return;
  }
  const focused = focusOnFile(typed.output, path);
  if (!focused) {
    return;
  }
  return {
    checker: 'tsc --noEmit',
    output: clamp(focused, DIAGNOSTICS_MAX_CHARS) ?? focused,
  };
}
