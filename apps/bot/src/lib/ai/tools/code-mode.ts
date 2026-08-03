import nodePath from 'node:path/posix';
import type { SandboxContext } from '@repo/ai';
import { tool } from 'ai';
import { z } from 'zod';
import { guardGithubCommand } from '@/lib/github/guard';
import { clamp } from '@/lib/utils/text';

// Code Mode (the Cloudflare pattern): instead of calling one host tool per step
// and paying a full model round-trip each time, kyto writes ONE TypeScript
// program that orchestrates the whole job — loops, branches, filters
// intermediate data, and returns only the final result. It runs in the thread's
// persistent E2B sandbox via `bun` (native TS, no build step).
//
// This is the fix for the "50 browser round-trips" failure: a task that means
// "do X across N items" is one script here, not N tool calls that each risk a
// mid-stream fallback and burn the step budget.
//
// SECURITY BOUNDARY: the script reaches only what sandbox code already safely
// reaches — the shell, the network (fetch/cloakbrowser), and the READ-ONLY Slack
// proxy on PATH. It deliberately CANNOT invoke kyto's mutating/outward tools
// (postMessage, sendAsUser, …); those stay behind the confirm-post human gate,
// exactly so a prompt injection can't turn sandboxed code into an outward send.

const OUTPUT_MAX = 12_000;
const CODE_DIR = '.codemode';

// A small, always-refreshed helper module the script can import as
// `./kyto.ts`. Rewritten on every run so it survives a resumed sandbox (whose
// files persist, but a helper version bump would otherwise go stale). Exposes
// only the safe, read-only surface — see the boundary note above.
const HELPER_MODULE = `\
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

/** Run a shell command, returning its stdout (throws on non-zero exit). */
export async function sh(command: string): Promise<string> {
  const { stdout } = await execFile('bash', ['-lc', command], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Call the Slack Web API READ-ONLY through kyto's host proxy (the same
 * allowlisted methods the \`slack\` CLI exposes: users.*, conversations.*,
 * team.*, …). The bot token never enters the sandbox and posting is impossible.
 */
export async function slack(
  method: string,
  args: Record<string, unknown> = {}
): Promise<unknown> {
  const { stdout } = await execFile('slack', [method, JSON.stringify(args)], {
    maxBuffer: 64 * 1024 * 1024,
  });
  try {
    return JSON.parse(stdout);
  } catch {
    return stdout;
  }
}
`;

function resolveDir(context: SandboxContext): string {
  return nodePath.join(context.sessionWorkDir, CODE_DIR);
}

export function codeModeTool({
  getSandboxContext,
  github,
}: {
  getSandboxContext: () => SandboxContext;
  /**
   * The requesting user, so a script that shells out to `gh`/`git push` is held
   * to the same repo-ownership gate as the gh and bash tools (the `sh` helper is
   * a shell, and the gate has to cover every shell).
   */
  github?: { isOwner: boolean; threadId?: string; userId: string };
}) {
  return tool({
    description:
      'Run ONE TypeScript program in your sandbox (via bun — native TS, no build step) to do a whole multi-step job in a single execution instead of many tool round-trips. Use this whenever the task is "do X across N things", involves loops/branching over tool results, or would otherwise be a long series of browser/fetch/file calls (e.g. screenshot every slider position and pick the readable one — script it, don\'t click 50 times). Your code can `import { sh, slack } from "./kyto.ts"` (shell + READ-ONLY Slack), use `fetch`, and drive `cloakbrowser` (stealth Chromium — launch headful on the shared display, `export DISPLAY=$(kyto-display)`, for anti-bot pages). Print your result with console.log; that stdout is what you get back. It runs in the persistent thread sandbox, so files and installed packages carry over. It CANNOT post/DM/edit Slack — do outward actions with the real tools.',
    inputSchema: z.object({
      code: z
        .string()
        .describe(
          'The TypeScript program. Print results with console.log. May import ./kyto.ts.'
        ),
      install: z
        .array(z.string())
        .optional()
        .describe(
          'npm packages to install before running (e.g. ["cloakbrowser"]). Skips ones already present.'
        ),
    }),
    execute: async ({ code, install }, { abortSignal }) => {
      const context = getSandboxContext();
      const guard = github
        ? await guardGithubCommand({
            command: code,
            context,
            isOwner: github.isOwner,
            threadId: github.threadId,
            userId: github.userId,
          })
        : null;
      if (guard?.allowed === false) {
        return { exitCode: 1, stderr: guard.reason, stdout: '' };
      }
      const dir = resolveDir(context);
      const encoder = new TextEncoder();
      await context.session.writeBinaryFile({
        content: encoder.encode(HELPER_MODULE),
        path: nodePath.join(dir, 'kyto.ts'),
      });
      await context.session.writeBinaryFile({
        content: encoder.encode(code),
        path: nodePath.join(dir, 'run.ts'),
      });

      if (install && install.length > 0) {
        const installResult = await context.session.run({
          abortSignal,
          command: `bun add ${install.map((pkg) => `'${pkg.replaceAll("'", '')}'`).join(' ')}`,
          workingDirectory: dir,
        });
        if (installResult.exitCode !== 0) {
          return {
            exitCode: installResult.exitCode,
            stderr: clamp(installResult.stderr, OUTPUT_MAX),
            stdout: clamp(installResult.stdout, OUTPUT_MAX),
            summary: 'Dependency install failed; the program did not run.',
          };
        }
      }

      const result = await context.session.run({
        abortSignal,
        command: 'bun run run.ts',
        workingDirectory: dir,
      });
      if (result.exitCode === 0) {
        await guard?.claim();
      }
      return {
        exitCode: result.exitCode,
        stderr: clamp(result.stderr, OUTPUT_MAX),
        stdout: clamp(result.stdout, OUTPUT_MAX),
      };
    },
  });
}
