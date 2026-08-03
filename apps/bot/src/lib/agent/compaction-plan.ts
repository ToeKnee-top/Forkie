// The decision half of compaction, kept free of the DB and the logger (and so of
// the validated env) so it can be tested directly. lib/agent/compaction does the
// IO — read the stored summary, call a model, write it back — and asks this
// module what to do.

// How many messages must have newly fallen out of the replay window before the
// summary is refreshed. Without this, every turn in a thread past the cap pushes
// exactly one more message into overflow and pays for a whole summarization pass
// to absorb it. Below the threshold the block still reports the true count, so
// nothing is hidden — the gap is described rather than digested. A thread
// crossing the cap for the FIRST time is summarized immediately regardless.
export const COMPACT_BATCH = 25;
// Messages fed into one compaction pass. A long-idle thread can dump a lot of
// overflow at once; clamp so a single call stays small and cheap.
export const MAX_MESSAGES_PER_PASS = 200;

/** One overflowed message, already rendered by buildPrompt. */
export interface CompactableMessage {
  id: string;
  rendered: string;
}

export interface StoredSummary {
  summary: string;
  /** Id of the newest message the stored summary already accounts for. */
  throughMessageId: string;
}

export type CompactionPlan =
  | {
      /** Messages to fold in, oldest first. */
      batch: CompactableMessage[];
      /** The summary they extend, if this is an incremental pass. */
      previous?: string;
      /** Newest message the resulting summary will account for. */
      throughMessageId: string;
      kind: 'summarize';
    }
  | { kind: 'reuse'; summary: string };

/**
 * What to do with the messages that fell out of the replay window.
 *
 * `overflow` is oldest-first. A stored summary whose `throughMessageId` is no
 * longer in `overflow` is treated as covering NOTHING — that happens when the
 * row aged out or the thread was edited underneath us, and folding new messages
 * into a summary whose starting point we can't locate would quietly double-count
 * or skip a stretch of conversation.
 */
export function planCompaction({
  overflow,
  stored,
}: {
  overflow: CompactableMessage[];
  stored?: StoredSummary;
}): CompactionPlan | undefined {
  const newest = overflow.at(-1);
  if (!newest) {
    return;
  }
  const coveredIndex = stored
    ? overflow.findIndex((message) => message.id === stored.throughMessageId)
    : -1;
  const pending = overflow.slice(coveredIndex + 1);
  if (stored && pending.length < COMPACT_BATCH) {
    return { kind: 'reuse', summary: stored.summary };
  }
  return {
    // Keep the messages nearest the live conversation when a huge backlog
    // arrives at once — those are the ones the next turn is likely to need.
    batch: pending.slice(-MAX_MESSAGES_PER_PASS),
    kind: 'summarize',
    ...(coveredIndex >= 0 && stored ? { previous: stored.summary } : {}),
    throughMessageId: newest.id,
  };
}

/**
 * The prompt block. It ALWAYS states the count, with or without a summary —
 * that is the whole point of this feature. Silent truncation is what it
 * replaces, so a failed summary must still leave the model knowing the
 * conversation has a beginning it cannot see.
 */
export function renderCompactedBlock({
  count,
  summary,
}: {
  count: number;
  summary?: string;
}): string {
  const header = `<earlier_in_this_thread>\nThis thread has ${count} earlier message(s) that no longer fit in the replay below. They are part of the SAME conversation — do not treat the replayed history as its beginning.`;
  if (!summary) {
    return `${header}\n\nThey could not be summarized this turn, so you are seeing only the count. If anything below seems to reference something you cannot see, it is probably in there — read it with the Slack history tools rather than guessing or asking the user to repeat themselves.\n</earlier_in_this_thread>`;
  }
  return `${header}\n\n${summary}\n\nThis is a compacted digest, not a transcript. If you need something it does not cover, read the thread with the Slack history tools.\n</earlier_in_this_thread>`;
}
