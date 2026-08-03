import { eq, lt } from 'drizzle-orm';
import { db } from '../client';
import { threadThinking } from '../schema';
import { threadsInChannel } from './thread-ids';

export type { ThreadThinking } from '../schema';

/**
 * The stored reasoning turns for a thread, or [] if none or the row is older
 * than maxAgeMs (a stale train of thought is worse context than none).
 */
export async function getThreadThinking(
  threadId: string,
  maxAgeMs: number
): Promise<string[]> {
  const [row] = await db
    .select()
    .from(threadThinking)
    .where(eq(threadThinking.threadId, threadId))
    .limit(1);
  if (!row) {
    return [];
  }
  if (Date.now() - row.updatedAt.getTime() > maxAgeMs) {
    return [];
  }
  return row.turns;
}

export async function saveThreadThinking(
  threadId: string,
  turns: string[]
): Promise<void> {
  await db
    .insert(threadThinking)
    .values({ threadId, turns })
    .onConflictDoUpdate({
      set: { turns, updatedAt: new Date() },
      target: threadThinking.threadId,
    });
}

export async function clearThreadThinking(threadId: string): Promise<void> {
  await db.delete(threadThinking).where(eq(threadThinking.threadId, threadId));
}

/**
 * Count, then delete, the reasoning stored for every thread rooted in one
 * channel. Thread ids are `slack:CHANNEL[:TS]`, so a channel's threads share the
 * `slack:CHANNEL` prefix.
 *
 * This is how a self-serve erase reaches `thread_thinking`, which is keyed by
 * THREAD and has no user column: pass the user's own DM channel and only their
 * private conversations with kyto are affected. Deliberately NOT usable to wipe a
 * shared channel's reasoning — that text is derived from everyone in the room,
 * and one member asking to be forgotten must not delete the rest of it.
 */
export async function deleteThinkingForChannel(
  channelId: string
): Promise<number> {
  const removed = await db
    .delete(threadThinking)
    .where(threadsInChannel(threadThinking.threadId, channelId))
    .returning({ threadId: threadThinking.threadId });
  return removed.length;
}

/** Reap rows whose reasoning is older than the retention window. */
export async function pruneThreadThinking(olderThan: Date): Promise<void> {
  await db
    .delete(threadThinking)
    .where(lt(threadThinking.updatedAt, olderThan));
}
