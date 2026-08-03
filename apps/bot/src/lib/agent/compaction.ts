import { streamAttempt, subagentAttempt } from '@repo/ai';
import {
  getThreadSummary,
  pruneThreadSummaries,
  saveThreadSummary,
} from '@repo/db/queries';
import {
  type CompactableMessage,
  planCompaction,
  renderCompactedBlock,
} from '@/lib/agent/compaction-plan';
import logger from '@/lib/logger';
import { clamp } from '@/lib/utils/text';

// Compaction: what happens to a Slack thread once it outgrows the replay cap.
//
// buildPrompt replays the thread as kyto's only memory of the conversation, and
// only the most recent MAX_THREAD_MESSAGES fit. Past that the oldest messages
// were simply dropped, silently — the model was never told a conversation it was
// mid-way through had a beginning it could no longer see, so it confidently
// contradicted decisions made earlier in the same thread.
//
// Now the overflow is folded into a running summary instead. Three properties
// matter more here than the summary's prose quality:
//
//   * INCREMENTAL. Only messages that have NEWLY fallen out of the window get
//     summarized, folded into the previous summary. A thread that runs for
//     months costs one small call each time another block ages out, not a
//     re-read of its whole history every turn.
//   * OFF THE MAIN BUDGET. It runs on the subagent rung (the owner's own Gemini
//     key), not the shared HackClub daily cap the turn itself is spending.
//   * NEVER FATAL, NEVER SILENT. If summarizing fails, the block still says how
//     many earlier messages exist and how to go read them. Losing the summary
//     must not put us back to pretending the thread began where the window does
//     — that is the bug being fixed.
//
// The decision of what to summarize lives in compaction-plan.ts; this file is
// the IO around it.

// Same window as thread_thinking: this is derived text about a conversation,
// held for the same reason and no longer.
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
// A summary that grew without bound would eventually cost more context than the
// messages it replaced. The summarizer is told this, and it is enforced.
const SUMMARY_MAX_CHARS = 4000;
// Per message, inside the compaction prompt. Enough to carry a decision or a
// request; short enough that a couple of hundred stay a small call.
const MAX_MESSAGE_CHARS = 600;
// Summarizing is a side quest for the turn; it must not hold the reply up.
const SUMMARY_TIMEOUT_MS = 30_000;

const SUMMARY_SYSTEM = `You compact the older part of a Slack conversation so an assistant that can no longer see those messages still knows what happened in them.

Write a dense factual digest, not prose. Preserve, in this order of priority:
- decisions made and instructions given, and WHO gave them
- facts, names, ids, URLs, file paths, numbers and other specifics
- what was asked for, and whether it was delivered
- anything still open or promised

Drop pleasantries, acknowledgements, and anything a later message already superseded. Never invent detail. Refer to people by the @name shown. Do not address anyone: this is a note to the assistant's future self.`;

export type { CompactableMessage } from '@/lib/agent/compaction-plan';

async function summarize({
  messages,
  previous,
}: {
  messages: CompactableMessage[];
  previous?: string;
}): Promise<string | undefined> {
  if (!subagentAttempt) {
    return;
  }
  const transcript = messages
    .map((message) => clamp(message.rendered, MAX_MESSAGE_CHARS) ?? '')
    .filter(Boolean)
    .join('\n');
  if (!transcript) {
    return;
  }
  const prompt = [
    previous
      ? `Digest of this conversation so far:\n\n${previous}\n\nThese messages come immediately after it and must be folded in:`
      : 'Compact these messages:',
    '',
    transcript,
    '',
    `Return the updated digest only, under ${SUMMARY_MAX_CHARS} characters. Keep everything from the earlier digest that is still true and still matters.`,
  ].join('\n');
  try {
    const result = streamAttempt({
      abortSignal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
      attempt: subagentAttempt,
      // Nothing reads the resolved model back off a compaction pass.
      holder: {},
      prompt,
      system: SUMMARY_SYSTEM,
      tools: {},
    });
    const text = (await result.text).trim();
    return text ? (clamp(text, SUMMARY_MAX_CHARS) ?? text) : undefined;
  } catch (error) {
    logger.warn({ err: error }, '[compaction] summary failed');
    return;
  }
}

/**
 * Compact the messages that fell out of the replay window into a prompt block.
 * `overflow` is every message older than the ones replayed verbatim, oldest
 * first.
 *
 * Best-effort throughout: any failure degrades to the count-only block, which is
 * still strictly better than the silent truncation this replaces.
 */
export async function compactOverflow({
  overflow,
  threadId,
}: {
  overflow: CompactableMessage[];
  threadId: string;
}): Promise<string> {
  if (overflow.length === 0) {
    return '';
  }
  const stored = await getThreadSummary(threadId, RETENTION_MS).catch(
    () => undefined
  );
  const plan = planCompaction({ overflow, stored });
  if (!plan) {
    return '';
  }
  if (plan.kind === 'reuse') {
    return renderCompactedBlock({
      count: overflow.length,
      summary: plan.summary,
    });
  }
  const summary = await summarize({
    messages: plan.batch,
    previous: plan.previous,
  });
  if (summary) {
    await saveThreadSummary({
      coveredCount: overflow.length,
      summary,
      threadId,
      throughMessageId: plan.throughMessageId,
    }).catch((error: unknown) => {
      logger.warn({ err: error, threadId }, '[compaction] failed to persist');
    });
  }
  return renderCompactedBlock({
    count: overflow.length,
    // A failed pass still falls back to whatever was stored before: an older
    // digest beats no digest.
    summary: summary ?? stored?.summary,
  });
}

// Reap summaries past the retention window, on startup and daily after — same
// schedule and same reason as the thinking reaper.
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function startSummaryReaper(): void {
  const tick = (): void => {
    pruneThreadSummaries(new Date(Date.now() - RETENTION_MS)).catch(
      (error: unknown) => {
        logger.warn({ err: error }, '[compaction] prune failed');
      }
    );
  };
  setInterval(tick, PRUNE_INTERVAL_MS);
  tick();
}
