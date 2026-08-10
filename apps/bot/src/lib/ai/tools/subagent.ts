import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type ModelAttempt,
  type SandboxContext,
  streamAttempt,
  subagentAttempts,
  subagentSystemPrompt,
} from '@repo/ai';
import { tool } from 'ai';
import { z } from 'zod';
import type { KytoBot, Message, StreamChunk, ThreadHandle } from '@/harness';
import { requestHints } from '@/lib/ai/hints';
import { renderStream } from '@/lib/ai/stream';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';

// A subagent is a headless copy of kyto: it shares the PARENT THREAD's sandbox
// (so it sees the files/state the parent set up, and vice versa), the same full
// toolset, pinned to a cheap model (the owner's Gemini key, else a HackClub
// rung — see subagentAttempts). It runs the same multi-step tool loop as a turn
// (streamAttempt drives it) and returns its final text as a report to the parent.
//
// Its work is surfaced as ITS OWN streamed plan message, posted under kyto's bot
// but NAMED for the subagent ("kyto subagent", or "kyto subagent {name}"), so the
// run reads as a distinct agent doing distinct work. EVERYTHING lives inside that
// one collapsible plan — a Prompt card (FULL task, unclamped), a Model card per
// attempt, the same interleaved thinking/tool cards a real turn shows (shared
// renderStream, in stream order), then a Response card holding its full report.
// NOTHING goes in the message body, so the subagent never speaks: its report goes
// to the parent model as the tool result, and the parent is the only voice.
//
// This run was briefly folded into the PARENT's plan block instead (a ChunkRelay,
// cards prefixed with the label), to stop the subagent's answer reading as kyto
// answering twice. Owner's call, 2026-07-30: the distinct card is what they want
// back — keeping the report out of the body is what stops the double voice, not
// merging the cards. The LABEL rule stays fixed (nothing configurable decorates
// it) and the subagent still has no icon of its own.
//
// Recursion is capped via AsyncLocalStorage. Only ONE level deep: a subagent may
// NOT spawn a further subagent (a runaway recursive spawn is a real cost/time
// risk with no natural backstop, and one level is all that's actually useful).
const MAX_SUBAGENT_DEPTH = 1;

const depthStore = new AsyncLocalStorage<number>();

// A BACKGROUND subagent almost always outlives the turn that started it — that
// is the point of backgrounding it — and `jobs` below lives in the turn's tool
// closure. So kyto would say "launched 5, I'll let you know", the turn would end,
// and kyto itself would never learn any of it happened. Nobody could ask it to
// act on what its own subagents found — and now that a subagent posts nothing of
// its own, the findings would reach nobody at all.
//
// So a finished background job WAKES the thread: it starts a fresh turn whose
// input is the report. kyto reads the findings and responds to them, the way a
// reminder firing does.
const WAKE_MESSAGE_PREFIX = 'subagent-report-';
// The wake must not abort the parent: runTurn's "a turn is already active" path
// interrupts the running one, which for a subagent finishing mid-turn would
// kill the very work that spawned it. Wait for the thread to go quiet instead.
const WAKE_POLL_MS = 4000;
const WAKE_MAX_WAIT_MS = 15 * 60 * 1000;

// The result a subagent run resolves to (also what a foreground call returns).
type SubagentResult =
  | { report: string; success: true }
  | { error: string; success: false };

// A background subagent, tracked in-turn so `checkSubagent` can collect it later
// (same lifetime model as the bash background-process trio: the handle map lives
// for this turn's tool closure only).
interface SubagentJob {
  // Set once checkSubagent has handed this job's finished report back to the
  // model IN the live turn. wakeThread checks it right before posting, so a
  // report the model already collected and used isn't delivered a SECOND time as
  // a fresh "background subagent finished" turn (the job.then wake fires
  // independently of checkSubagent — nothing coordinated them before this flag).
  collected?: boolean;
  id: string;
  name?: string;
  promise: Promise<SubagentResult>;
  result?: SubagentResult;
  startedAt: number;
  status: 'running' | 'done' | 'failed';
}

export function runSubagentTool({
  bot,
  getSandboxContext,
  message,
  thread,
}: {
  bot: KytoBot;
  // The PARENT turn's sandbox context — the subagent runs in the SAME sandbox,
  // so it shares the parent's files/workspace rather than booting its own.
  getSandboxContext: () => SandboxContext;
  message: Message;
  thread: ThreadHandle;
}) {
  // Background subagents started this turn, keyed by id (sub-1, sub-2, …). Shared
  // between runSubagent (which registers) and checkSubagent (which collects).
  const jobs = new Map<string, SubagentJob>();
  let counter = 0;

  const runSubagent = tool({
    description:
      'Delegate a task to a subagent — a headless copy of Forkie (shares your sandbox, same tools) that runs on a cheaper pinned model and returns a written report to you. Its run shows up inside your own plan/thinking block as it works; it does NOT post a message of its own, so YOU are the only voice in the thread and its findings only reach the user if you say them. Use it for open-ended investigation or self-contained work that would otherwise clutter your own context. It has NO access to this conversation beyond what you put in the task. By default it runs FOREGROUND (you wait for its report, then use it). Set background:true to fire it off and keep working immediately — you get a job id back instead of the report, and later call checkSubagent with that id to collect it.',
    inputSchema: z.object({
      task: z
        .string()
        .min(1)
        .describe(
          'The task to delegate, with as much detail/context as the subagent will need.'
        ),
      name: z
        .string()
        .optional()
        .describe(
          'Optional short name for this subagent (e.g. "researcher"), used to label its cards in your plan as "forkie subagent {name}".'
        ),
      background: z
        .boolean()
        .optional()
        .describe(
          'If true, spawn the subagent and return IMMEDIATELY without waiting — it runs independently and you get no report back on this call. Use it to run a side-task in parallel while you continue your own work; collect it later with checkSubagent, or let its report come back as a follow-up turn. Default false (wait for and receive the report).'
        ),
    }),
    execute: async ({ task, name, background }, { abortSignal }) => {
      if (subagentAttempts.length === 0) {
        return {
          error:
            'No subagent model is configured (the subagent roster is empty).',
          success: false,
        };
      }
      const depth = depthStore.getStore() ?? 0;
      if (depth >= MAX_SUBAGENT_DEPTH) {
        return {
          error: `Subagent nesting limit (${MAX_SUBAGENT_DEPTH}) reached — cannot delegate further.`,
          success: false,
        };
      }
      // depthStore.run STARTS the job and returns its promise. Foreground
      // (default): await it and hand the report back to the parent model as this
      // tool call's RESULT — the next step sees the report and answers from it.
      // Background: don't await — the parent model gets control back this step and
      // keeps working while the subagent runs. It's tied to the parent turn's
      // abort signal (a user interrupt stops it).
      // Because the subagent shares the PARENT's sandbox, a foreground subagent is
      // always safe (the parent is paused mid-tool-call, still holding the sandbox
      // lock); a background one is best for quick side-tasks — if it runs long
      // after the parent turn ends, the sandbox is paused and its next sandbox
      // command transparently resumes it.
      const job: Promise<SubagentResult> = depthStore.run(
        depth + 1,
        async (): Promise<SubagentResult> => {
          // Share the PARENT turn's sandbox — the subagent works in the same
          // filesystem the parent set up (and leaves its own work there for the
          // parent to pick up). The parent owns this sandbox's lifecycle (it pauses
          // it at turn end), so the subagent must NOT create or destroy it.
          const sandboxContext = getSandboxContext();
          // Lazy import breaks the cycle: toolset.ts registers this tool, and
          // this tool needs toolset.ts's buildTools to give the subagent its own
          // full set (recursion is bounded by the depth cap above).
          const { buildTools } = await import('@/lib/ai/toolset');
          // The subagent's label: the display name on its own streamed message,
          // so its work is never mistaken for the main agent's. Fixed on
          // purpose (owner's call): the name is only ever "kyto",
          // "kyto subagent", or "kyto subagent {name}" — nothing configurable
          // decorates it, and there is no icon override.
          const label = name ? `forkie subagent ${name}` : 'forkie subagent';

          let close: (() => Promise<void>) | undefined;
          let ranTools = false;
          let report = '';
          let lastError: unknown;

          try {
            const hints = await requestHints({ message, thread });
            const system = subagentSystemPrompt({ hints });
            const built = await buildTools({
              bot,
              getSandboxContext: () => sandboxContext,
              message,
              thread,
            });
            close = built.close;
            const knownTools = new Set(Object.keys(built.tools));

            // The cards of the subagent's OWN plan message. Its ids live in that
            // message alone, so they need no namespacing — a concurrent subagent
            // (or the parent) is streaming into a different message entirely.
            const card = (
              id: string,
              title: string,
              status: 'complete' | 'error' | 'in_progress',
              output?: string
            ): StreamChunk => ({
              id,
              output: status === 'in_progress' ? '' : (output ?? ''),
              status,
              title,
              type: 'task_update',
            });

            // Yielded into the subagent's own `slack.stream`, so a card lands as
            // it happens rather than in one lump at the end.
            async function* subagentChunks(): AsyncGenerator<
              string | StreamChunk
            > {
              yield card('prompt', 'Prompt', 'in_progress');
              yield card('prompt', 'Prompt', 'complete', task);
              // Walk the subagent roster. The cheap pinned tier returns an empty
              // completion often enough that a single model left a whole "herd"
              // of subagents reporting nothing back, so an attempt that produces
              // NO report (empty stream, or a thrown provider error) falls through
              // to the next model instead of failing the delegation.
              for (const [index, attempt] of subagentAttempts.entries()) {
                const modelTaskId = `model-${index}`;
                const modelTitle = index > 0 ? 'Model · fallback' : 'Model';
                yield card(modelTaskId, modelTitle, 'in_progress');
                try {
                  const result = streamAttempt({
                    abortSignal,
                    activeTools: built.activeTools,
                    attempt,
                    getFreshImages: built.drainImages,
                    holder: {},
                    prompt: task,
                    system,
                    tools: built.tools,
                  });
                  // No emitText: the subagent's prose is NOT streamed into the
                  // message body — it stays inside the collapsible plan (the
                  // Response card below) and goes to the parent model, which is
                  // the only voice in the thread.
                  yield* renderStream({
                    knownTools,
                    onTextDelta: (text) => {
                      report += text;
                    },
                    onToolActivity: () => {
                      ranTools = true;
                    },
                    stream: result.fullStream,
                  });
                  yield card(
                    modelTaskId,
                    modelTitle,
                    'complete',
                    attempt.model
                  );
                } catch (error) {
                  lastError = error;
                  yield card(
                    modelTaskId,
                    modelTitle,
                    'error',
                    errorMessage(error)
                  );
                }
                // A model that ran tools but wrote nothing leaves the parent with
                // "(Completed actions…)" — technically a success, useless as a
                // report. Ask THIS model to write it up, with tools OFF so no side
                // effect can fire twice. Same nudge the main turn uses.
                if (!report.trim() && ranTools) {
                  report = await synthesizeReport({
                    abortSignal,
                    attempt,
                    system,
                    task,
                  }).catch(() => '');
                }
                if (report.trim()) {
                  break;
                }
                if (abortSignal?.aborted) {
                  break;
                }
              }
              const finalReport = report.trim();
              if (finalReport || ranTools) {
                yield card('response', 'Response', 'in_progress');
                yield card(
                  'response',
                  'Response',
                  'complete',
                  finalReport ||
                    '(Completed actions with no additional message.)'
                );
              }
            }

            // The subagent's own message: named for it, plan-mode, and nothing in
            // the body. Streamed live, so the cards fill in as it works.
            await slack.stream(thread.id, subagentChunks(), {
              recipientTeamId: slack.teamId ?? '',
              recipientUserId: message.author.userId,
              taskDisplayMode: 'plan',
              username: label,
            });

            report = report.trim();
            if (report) {
              return { report, success: true };
            }
            if (ranTools) {
              return {
                report: '(Completed actions with no additional message.)',
                success: true,
              };
            }
            return {
              error: lastError
                ? `Subagent failed on every model. Last error: ${errorMessage(lastError)}`
                : 'Subagent produced an empty report.',
              success: false,
            };
          } catch (error) {
            return { error: errorMessage(error), success: false };
          } finally {
            // Only tear down the per-turn MCP/tool connections. The sandbox is the
            // parent's — the parent pauses it at turn end, so don't destroy it here.
            await close?.().catch(() => undefined);
          }
        }
      );

      if (background) {
        // Register the job so checkSubagent can collect it later, and keep its
        // status current as it resolves. Then hand control back to the parent.
        counter += 1;
        const id = `sub-${counter}`;
        const record: SubagentJob = {
          id,
          name,
          promise: job,
          startedAt: Date.now(),
          status: 'running',
        };
        jobs.set(id, record);
        // A turn started BY a wake doesn't get to schedule another one, or five
        // subagents reporting back could each spawn a turn that spawns more.
        const mayWake = !message.id.startsWith(WAKE_MESSAGE_PREFIX);
        job.then(
          (result) => {
            record.status = result.success ? 'done' : 'failed';
            record.result = result;
            if (mayWake) {
              wakeThread({ job: record, message, thread }).catch(
                () => undefined
              );
            }
          },
          (error: unknown) => {
            record.status = 'failed';
            record.result = { error: errorMessage(error), success: false };
            logger.error(
              { err: error, thread: thread.id },
              '[subagent] background run failed'
            );
            if (mayWake) {
              wakeThread({ job: record, message, thread }).catch(
                () => undefined
              );
            }
          }
        );
        const jobLabel = name ? `"${name}"` : 'it';
        return {
          background: true,
          id,
          note: `Subagent ${jobLabel} started in the background as ${id}. Keep working; when you need its findings call checkSubagent with id "${id}". If your turn ends before it finishes, that's fine — its report comes back to you as a new turn in this thread, so you don't have to wait for it. It does NOT post anything itself, so nothing reaches the user until you say it.`,
          success: true,
        };
      }
      return await job;
    },
  });

  const checkSubagent = tool({
    description:
      "Check on background subagents you started with runSubagent (background:true). With no id, lists every background subagent this turn and its status. With an id, returns that subagent's status and — once finished — its full report. Set wait:true to block until it finishes before returning (use this to collect a background subagent's result before you answer).",
    inputSchema: z.object({
      id: z
        .string()
        .optional()
        .describe(
          'The background subagent id (e.g. "sub-1"). Omit to list all.'
        ),
      wait: z
        .boolean()
        .optional()
        .describe(
          'If true and the subagent is still running, block until it finishes, then return its report.'
        ),
    }),
    execute: async ({ id, wait }) => {
      if (!id) {
        return {
          jobs: [...jobs.values()].map((job) => ({
            id: job.id,
            name: job.name,
            running: job.status === 'running',
            status: job.status,
          })),
          success: true,
        };
      }
      const job = jobs.get(id);
      if (!job) {
        return {
          error: `Unknown background subagent id: ${id}`,
          success: false,
        };
      }
      if (wait && job.status === 'running') {
        // Bounded by the subagent's own run (and the turn's attempt watchdog): it
        // shares the turn abort signal, so a turn abort resolves this too.
        await job.promise.catch(() => undefined);
      }
      if (job.status === 'running') {
        return {
          id,
          running: true,
          status: 'running',
          summary: `Subagent ${id} is still running.`,
          success: true,
        };
      }
      // The model is collecting this finished report in-turn, so it will use it
      // in its reply — don't also deliver it later as a background wake.
      job.collected = true;
      return {
        error: job.result?.success === false ? job.result.error : undefined,
        id,
        report: job.result?.success ? job.result.report : undefined,
        running: false,
        status: job.status,
        success: job.status === 'done',
      };
    },
  });

  return { checkSubagent, runSubagent };
}

/**
 * Hand a finished background subagent's report back to the thread as a new turn,
 * once the thread is quiet. Best effort throughout — a wake that fails must never
 * surface as an error mid-thread. Note the report IS lost to the user if this
 * fails, now that the subagent posts nothing itself: the journal line below is
 * the only trace, which is the right trade against derailing a live thread.
 */
async function wakeThread({
  job,
  message,
  thread,
}: {
  job: SubagentJob;
  message: Message;
  thread: ThreadHandle;
}): Promise<void> {
  try {
    const { getTurn } = await import('@/lib/agent/turns');
    const deadline = Date.now() + WAKE_MAX_WAIT_MS;
    while (getTurn({ threadId: thread.id })) {
      if (Date.now() > deadline) {
        logger.warn(
          { id: job.id, threadId: thread.id },
          '[subagent] gave up waiting for the thread to go quiet'
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, WAKE_POLL_MS));
    }
    // The thread went quiet — but if the model already collected this report via
    // checkSubagent during that turn, it's been used in the reply, so waking with
    // it again would post a duplicate. Re-check the claim right before acting
    // (not at attach time — checkSubagent usually runs while we're still polling).
    if (job.collected) {
      logger.info(
        { id: job.id, threadId: thread.id },
        '[subagent] report already collected in-turn; skipping background wake'
      );
      return;
    }
    const { runTurn } = await import('@/lib/agent');
    logger.info(
      { id: job.id, status: job.status, threadId: thread.id },
      '[subagent] waking the thread with a background report'
    );
    await runTurn({ message: reportMessage({ job, message, thread }), thread });
  } catch (error) {
    logger.warn(
      { err: errorMessage(error), id: job.id, threadId: thread.id },
      '[subagent] failed to wake the thread'
    );
  }
}

/**
 * The synthetic message a wake turn runs on. Authored by whoever asked for the
 * subagent, so the turn is gated exactly as their own message would be — a
 * background job must not become a way to act with someone else's permissions.
 */
function reportMessage({
  job,
  message,
  thread,
}: {
  job: SubagentJob;
  message: Message;
  thread: ThreadHandle;
}): Message {
  const label = job.name ? `${job.id} ("${job.name}")` : job.id;
  const body =
    job.result?.success === true
      ? `It reported:\n\n${job.result.report}`
      : `It failed: ${job.result?.success === false ? job.result.error : 'unknown error'}`;
  return {
    attachments: [],
    author: message.author,
    id: `${WAKE_MESSAGE_PREFIX}${job.id}-${Date.now()}`,
    isMention: false,
    metadata: { dateSent: new Date() },
    raw: {},
    text: `[Automatic note, not written by a person: the background subagent ${label} you started earlier in this thread has finished. ${body}

Nobody in the thread has seen any of this — the subagent posts nothing of its own, so you are the only way these findings reach anyone. Reply with what actually matters from them for the task that was being worked on, in your own words and at whatever length it deserves. Don't thank anyone and don't explain that you were woken up. If the findings genuinely need nothing said, call the skip TOOL — do not write the word "skip" as your reply.]`,
    threadId: thread.id,
  };
}

// A subagent that ran its tools and then stopped without writing anything gives
// the parent nothing to work with. Re-ask the SAME model, once, with tools OFF:
// it can only produce prose, so no side effect can happen twice, and the parent
// gets the findings instead of "(Completed actions…)".
async function synthesizeReport({
  abortSignal,
  attempt,
  system,
  task,
}: {
  abortSignal?: AbortSignal;
  attempt: ModelAttempt;
  system: string;
  task: string;
}): Promise<string> {
  const result = streamAttempt({
    abortSignal,
    attempt,
    holder: {},
    prompt: `${task}\n\nYou already did the work above. Write your final report now — the findings, in full. Do not call any tools.`,
    system,
    tools: {},
  });
  let text = '';
  for await (const delta of result.textStream) {
    text += delta;
  }
  return text.trim();
}
