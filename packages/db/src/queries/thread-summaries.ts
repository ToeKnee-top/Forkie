import { eq, lt } from 'drizzle-orm';
import { db } from '../client';
import { threadSummaries } from '../schema';
import { threadsInChannel } from './thread-ids';

export type { ThreadSummary } from '../schema';

/**
 * A thread's compacted history, or undefined if there is none or the row has
 * aged past the retention window (a stale summary is worse context than none —
 * it would describe a conversation the thread has since moved on from).
 */
export async function getThreadSummary(
  threadId: string,
  maxAgeMs: number
): Promise<
  | { coveredCount: number; summary: string; throughMessageId: string }
  | undefined
> {
  const [row] = await db
    .select()
    .from(threadSummaries)
    .where(eq(threadSummaries.threadId, threadId))
    .limit(1);
  if (!row) {
    return;
  }
  if (Date.now() - row.updatedAt.getTime() > maxAgeMs) {
    return;
  }
  return {
    coveredCount: row.coveredCount,
    summary: row.summary,
    throughMessageId: row.throughMessageId,
  };
}

export async function saveThreadSummary({
  coveredCount,
  summary,
  threadId,
  throughMessageId,
}: {
  coveredCount: number;
  summary: string;
  threadId: string;
  throughMessageId: string;
}): Promise<void> {
  await db
    .insert(threadSummaries)
    .values({ coveredCount, summary, threadId, throughMessageId })
    .onConflictDoUpdate({
      set: {
        coveredCount,
        summary,
        throughMessageId,
        updatedAt: new Date(),
      },
      target: threadSummaries.threadId,
    });
}

export async function clearThreadSummary(threadId: string): Promise<void> {
  await db
    .delete(threadSummaries)
    .where(eq(threadSummaries.threadId, threadId));
}

/**
 * Count, then delete, the compacted history of every thread rooted in one
 * channel. Same contract and same reasoning as `deleteThinkingForChannel`: this
 * is how a self-serve erase reaches a table keyed by THREAD rather than by user.
 * Pass the user's own DM channel. Deliberately NOT usable on a shared channel —
 * that summary is derived from everyone in the room.
 */
export async function deleteSummariesForChannel(
  channelId: string
): Promise<number> {
  const removed = await db
    .delete(threadSummaries)
    .where(threadsInChannel(threadSummaries.threadId, channelId))
    .returning({ threadId: threadSummaries.threadId });
  return removed.length;
}

/** Reap summaries older than the retention window. */
export async function pruneThreadSummaries(olderThan: Date): Promise<void> {
  await db
    .delete(threadSummaries)
    .where(lt(threadSummaries.updatedAt, olderThan));
}
