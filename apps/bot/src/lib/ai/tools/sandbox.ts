import nodePath from 'node:path/posix';
import type { SandboxContext } from '@repo/ai';
import { tool } from 'ai';
import { z } from 'zod';
import { githubAuthHint } from '@/lib/github/diagnose';
import { guardGithubCommand } from '@/lib/github/guard';
import { fileDiagnostics } from '@/lib/sandbox/diagnostics';
import { disarmFetchedRepos } from '@/lib/sandbox/git-safety';
import { clipOutput, fullOutputPath } from '@/lib/sandbox/output-clip';
import { clamp } from '@/lib/utils/text';
import type { BackgroundProcessTools } from './background';

// The model's workspace tools (replacing Pi's builtin bash/file tools). Every
// tool runs in the lazy E2B sandbox: the first call materializes it, chat-only
// turns never create one.

// A foreground bash command that runs longer than this is auto-moved to the
// background so it can't freeze the whole turn (a turn blocks until bash
// returns; a slow benchmark or a runaway script would otherwise leave the user
// staring at an empty message until the watchdog kills it). The command keeps
// running detached and the model gets a handle to poll.
const AUTO_BACKGROUND_MS = 60_000;

function resolvePath(context: SandboxContext, path: string): string {
  return nodePath.normalize(
    path.startsWith('/') ? path : nodePath.join(context.sessionWorkDir, path)
  );
}

/**
 * Clip one stream of command output, keeping a full copy in the sandbox so the
 * model can filter what it wasn't shown (see lib/sandbox/output-clip). Saving
 * is best-effort: if the write fails the clip still happens and the notice says
 * the copy is missing, because losing the output entirely is the worse outcome.
 */
async function clipStream(
  text: string,
  context: SandboxContext,
  label: string
): Promise<string> {
  const preview = clipOutput(text);
  if (!preview.truncated) {
    return preview.text;
  }
  const path = fullOutputPath(label);
  try {
    await context.session.writeBinaryFile({
      content: new TextEncoder().encode(text),
      path,
    });
  } catch {
    return preview.text;
  }
  return clipOutput(text, path).text;
}

export function bashTool({
  background,
  getSandboxContext,
  github,
}: {
  // Shared with the background-process trio, so an auto-backgrounded command is
  // pollable via getProcessOutput. Optional so a caller can opt out of
  // auto-backgrounding (then a long command blocks as before).
  background?: BackgroundProcessTools;
  getSandboxContext: () => SandboxContext;
  /**
   * Who this turn runs for, so a `gh`/`git push` typed into bash goes through
   * the same repo-ownership gate as the `gh` tool — otherwise the gate would be
   * one `bash("gh pr close …")` away from irrelevant. Omit for callers with no
   * requesting user (reminders, subagents inherit their parent's check).
   */
  github?: { isOwner: boolean; threadId?: string; userId: string };
}) {
  return tool({
    description:
      'Run a bash command in your isolated Linux sandbox (network access, common CLIs, bun/node/python preinstalled). The workspace PERSISTS across turns in this thread — files you write and packages you install are still there next time. A command still running after ~1 minute is automatically moved to the background and you get a handle to poll with getProcessOutput — so for anything you expect to be slow, bound it with `timeout` or start it with runBackgroundProcess yourself rather than relying on the auto-move.',
    inputSchema: z.object({
      command: z.string().describe('The bash command to run.'),
      workingDirectory: z
        .string()
        .optional()
        .describe('Working directory (defaults to the workspace).'),
    }),
    execute: async ({ command, workingDirectory }, { abortSignal }) => {
      const context = getSandboxContext();
      const resolvedDir = workingDirectory
        ? resolvePath(context, workingDirectory)
        : undefined;
      const guard = github
        ? await guardGithubCommand({
            command,
            context,
            isOwner: github.isOwner,
            threadId: github.threadId,
            userId: github.userId,
            workingDirectory: resolvedDir,
          })
        : null;
      if (guard?.allowed === false) {
        return { error: guard.reason, exitCode: 1 };
      }
      if (background) {
        const backgrounded = await runWithAutoBackground({
          abortSignal,
          background,
          command,
          context,
          workingDirectory: resolvedDir,
        });
        // Only once it has actually finished — a still-running extraction gets
        // disarmed when getProcessOutput reports it done.
        if (!backgrounded.running) {
          if (backgrounded.exitCode === 0) {
            await guard?.claim();
          }
          await disarmFetchedRepos({
            abortSignal,
            command,
            context,
            workingDirectory: resolvedDir,
          });
        }
        return backgrounded;
      }
      const result = await context.session.run({
        abortSignal,
        command,
        workingDirectory: resolvedDir,
      });
      if (result.exitCode === 0) {
        await guard?.claim();
      }
      await disarmFetchedRepos({
        abortSignal,
        command,
        context,
        workingDirectory: resolvedDir,
      });
      return {
        exitCode: result.exitCode,
        // git/gh reject a revoked brokered token in ways that look like a
        // private repo or a broken environment; name the real cause.
        hint: githubAuthHint({
          command,
          exitCode: result.exitCode,
          stderr: result.stderr,
        }),
        stderr: await clipStream(result.stderr, context, 'stderr'),
        stdout: await clipStream(result.stdout, context, 'stdout'),
      };
    },
  });
}

async function runWithAutoBackground({
  abortSignal,
  background,
  command,
  context,
  workingDirectory,
}: {
  abortSignal?: AbortSignal;
  background: BackgroundProcessTools;
  command: string;
  context: SandboxContext;
  workingDirectory?: string;
}): Promise<
  Record<string, unknown> & { exitCode?: number; running?: boolean }
> {
  const started = await background.startManaged(command, workingDirectory);
  if ('error' in started) {
    return { error: started.error, exitCode: 1 };
  }
  const result = await background.waitManaged(
    started.id,
    AUTO_BACKGROUND_MS,
    abortSignal
  );
  if (result.finished) {
    return {
      exitCode: result.exitCode,
      stderr: await clipStream(result.stderr, context, 'stderr'),
      stdout: await clipStream(result.stdout, context, 'stdout'),
    };
  }
  return {
    backgrounded: true,
    id: started.id,
    note: `This command was still running after 60s, so it was moved to the background (handle "${started.id}") to keep the turn responsive — it is STILL RUNNING. Poll it with getProcessOutput("${started.id}") and stop it with killProcess("${started.id}"). Don't just re-run it. If you need its result before replying, keep working on other things and check back, or use the wait tool.`,
    running: true,
    stderr: await clipStream(result.stderr, context, 'stderr'),
    stdout: await clipStream(result.stdout, context, 'stdout'),
  };
}

export function readFileTool({
  getSandboxContext,
}: {
  getSandboxContext: () => SandboxContext;
}) {
  return tool({
    description:
      'Read a text file from the sandbox workspace. Returns null if the file does not exist.',
    inputSchema: z.object({
      endLine: z.number().int().min(1).optional(),
      path: z.string(),
      startLine: z.number().int().min(1).optional(),
    }),
    execute: async ({ endLine, path, startLine }) => {
      const context = getSandboxContext();
      const bytes = await context.session.readBinaryFile({
        path: resolvePath(context, path),
      });
      if (!bytes) {
        return { content: null, found: false };
      }
      let text = new TextDecoder().decode(bytes);
      if (startLine !== undefined || endLine !== undefined) {
        text = text
          .split('\n')
          .slice(Math.max((startLine ?? 1) - 1, 0), endLine)
          .join('\n');
      }
      // The complete file is already on disk — the notice points back at it
      // (with startLine/endLine) instead of saving a second copy.
      return {
        content: clipOutput(text, resolvePath(context, path)).text,
        found: true,
      };
    },
  });
}

export function writeFileTool({
  getSandboxContext,
}: {
  getSandboxContext: () => SandboxContext;
}) {
  return tool({
    description:
      'Write a text file in the sandbox workspace (creates parent directories, overwrites existing content). Your reply — including this tool call — is capped at a few thousand tokens, so a single call CANNOT carry a very large file: content over roughly 400 lines gets cut off mid-argument. Write a big file in successive chunks instead — the first call with append:false, each following call with append:true. A whole-file write is checked afterwards (parse, and tsc for TypeScript) and any errors come back in `diagnostics` — fix them before moving on. Chunked appends are NOT checked, because the file is incomplete until the last one; check those yourself with bash.',
    inputSchema: z.object({
      append: z
        .boolean()
        .optional()
        .describe(
          'Append to the file instead of overwriting it. Use this to build a large file across several calls.'
        ),
      content: z.string(),
      path: z.string(),
    }),
    execute: async ({ append, content, path }, { abortSignal }) => {
      const context = getSandboxContext();
      const resolved = resolvePath(context, path);
      const existing = append
        ? await context.session.readBinaryFile({ path: resolved })
        : null;
      const next = existing
        ? `${new TextDecoder().decode(existing)}${content}`
        : content;
      await context.session.writeBinaryFile({
        content: new TextEncoder().encode(next),
        path: resolved,
      });
      // An append is a PARTIAL file by construction — checking it would report
      // "unexpected end of file" on every chunk but the last, which trains the
      // model to ignore diagnostics. Only whole-file writes are checked.
      const diagnostics = append
        ? undefined
        : await fileDiagnostics({ abortSignal, context, path: resolved });
      return {
        appended: Boolean(append),
        bytes: next.length,
        ...(diagnostics ? { diagnostics } : {}),
        path: resolved,
        written: true,
      };
    },
  });
}

/** Collapse every run of whitespace so two texts differing only in indentation
 * or wrapping compare equal. */
function squashWhitespace(value: string): string {
  return value.replaceAll(/\s+/g, ' ').trim();
}

/**
 * Why an exact match failed, in terms the model can act on. "not found" alone
 * sends it into a guess-and-retry loop; nearly every real miss is one of three
 * things, and naming which one turns a retry into a fix.
 */
function noMatchReason(text: string, oldString: string): string {
  const base = 'oldString was not found in the file, so nothing was changed.';
  if (text.includes('\r\n') && !oldString.includes('\r\n')) {
    return `${base} The file uses CRLF line endings and your oldString uses LF — copy the text out of readFile instead of retyping it.`;
  }
  if (squashWhitespace(text).includes(squashWhitespace(oldString))) {
    return `${base} The text IS there but the whitespace differs (indentation, tabs vs spaces, or a line break). Read the file and copy the region exactly as it appears.`;
  }
  const [firstLine] = oldString.split('\n');
  if (firstLine && firstLine.trim().length > 0 && text.includes(firstLine)) {
    return `${base} Its first line ("${clamp(firstLine.trim(), 80)}") does appear, so the mismatch is somewhere after it — re-read that region and copy it exactly.`;
  }
  return `${base} Read the file first and copy the exact region you mean to replace.`;
}

export function editFileTool({
  getSandboxContext,
}: {
  getSandboxContext: () => SandboxContext;
}) {
  return tool({
    description:
      'Edit a text file in the sandbox by exact string replacement. oldString must match the file contents exactly (including whitespace) and, unless replaceAll is true, exactly once — a miss or an ambiguous match FAILS rather than guessing. After a successful edit the file is checked (parse, and tsc for TypeScript) and any errors come back in `diagnostics`; fix them before moving on.',
    inputSchema: z.object({
      newString: z.string(),
      oldString: z.string(),
      path: z.string(),
      replaceAll: z.boolean().optional(),
    }),
    execute: async (
      { newString, oldString, path, replaceAll },
      { abortSignal }
    ) => {
      const context = getSandboxContext();
      const resolved = resolvePath(context, path);
      const bytes = await context.session.readBinaryFile({ path: resolved });
      if (!bytes) {
        throw new Error(`File not found: ${resolved}`);
      }
      const text = new TextDecoder().decode(bytes);
      const occurrences = text.split(oldString).length - 1;
      if (occurrences === 0) {
        throw new Error(noMatchReason(text, oldString));
      }
      if (occurrences > 1 && !replaceAll) {
        throw new Error(
          `oldString matches ${occurrences} times in ${resolved}, so this edit is ambiguous and was NOT applied. Include more surrounding lines to make it unique, or set replaceAll:true if you really mean all ${occurrences}.`
        );
      }
      const updated = replaceAll
        ? text.replaceAll(oldString, newString)
        : text.replace(oldString, newString);
      await context.session.writeBinaryFile({
        content: new TextEncoder().encode(updated),
        path: resolved,
      });
      const diagnostics = await fileDiagnostics({
        abortSignal,
        context,
        path: resolved,
      });
      return {
        ...(diagnostics ? { diagnostics } : {}),
        path: resolved,
        replaced: occurrences,
      };
    },
  });
}
