import type { SandboxContext } from '@repo/ai';
import { tool } from 'ai';
import { z } from 'zod';

// A mid-turn pause: the model calls this to be "alerted back" after a delay
// (e.g. to space out a sequence of checks, or wait out an external process)
// instead of ending the turn. A wait can now run up to an hour — it tells the
// attempt watchdog (agent/index.ts, ATTEMPT_TIMEOUT_MS) to hold off for the
// duration, so a long wait is never mistaken for a stalled attempt.
const MAX_WAIT_SECONDS = 3600;
// Below this, pausing the sandbox costs more (a resume is ~0.5s plus the risk of
// losing a running process) than the compute it saves.
const PAUSE_WORTHWHILE_SECONDS = 120;

export function waitTool({
  extendAttemptDeadline,
  getSandboxContext,
}: {
  /** Push the attempt watchdog out by this many ms, so a long wait can't trip it. */
  extendAttemptDeadline?: (extraMs: number) => void;
  getSandboxContext?: () => SandboxContext;
}) {
  return tool({
    description:
      'Pause for a duration, then continue the turn. Use to space out steps or wait out an external delay (a build, a deploy, a rate-limit window). Up to 1 hour per call. Set pauseSandbox to suspend your sandbox while you wait — it costs nothing while paused and the next sandbox command transparently resumes it with the same filesystem. Do NOT pause the sandbox if a background process must keep running during the wait (pausing suspends it).',
    inputSchema: z.object({
      seconds: z
        .number()
        .int()
        .min(1)
        .max(MAX_WAIT_SECONDS)
        .describe(
          `How long to wait, in seconds (max ${MAX_WAIT_SECONDS} = 1 hour).`
        ),
      pauseSandbox: z
        .boolean()
        .optional()
        .describe(
          'Suspend the sandbox for the duration to save cost. Only for a long wait with nothing running in the sandbox — it suspends any background process too. Default false.'
        ),
    }),
    execute: async ({ seconds, pauseSandbox }, { abortSignal }) => {
      const ms = seconds * 1000;
      // The attempt watchdog would otherwise abort a wait longer than its own
      // timeout as a stall. Tell it this pause is deliberate.
      extendAttemptDeadline?.(ms);

      const shouldPause =
        pauseSandbox === true && seconds >= PAUSE_WORTHWHILE_SECONDS;
      let paused = false;
      if (shouldPause && getSandboxContext) {
        // destroy() PAUSES a persistent (per-thread) sandbox — its filesystem
        // survives and the next command auto-resumes it. It's a no-op if the
        // sandbox was never materialized this turn.
        paused = await Promise.resolve(getSandboxContext().session.destroy())
          .then(() => true)
          .catch(() => false);
      }

      const start = Date.now();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        abortSignal?.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      const waitedSeconds = Math.round((Date.now() - start) / 1000);

      return {
        interrupted: Boolean(abortSignal?.aborted),
        sandboxPaused: paused,
        summary: paused
          ? `Waited ${waitedSeconds}s with the sandbox paused. Your next sandbox command resumes it with the same filesystem.`
          : `Waited ${waitedSeconds}s.`,
        waitedSeconds,
      };
    },
  });
}
