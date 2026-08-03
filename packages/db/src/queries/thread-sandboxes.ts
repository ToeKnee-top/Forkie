import { eq, lt } from 'drizzle-orm';
import { db } from '../client';
import { type ThreadSandbox, threadSandboxes } from '../schema';
import { threadsInChannel } from './thread-ids';

export type { ThreadSandbox } from '../schema';

export async function getThreadSandbox(
  threadId: string
): Promise<ThreadSandbox | null> {
  const rows = await db
    .select()
    .from(threadSandboxes)
    .where(eq(threadSandboxes.threadId, threadId))
    .limit(1);
  return rows[0] ?? null;
}

/** Remember (or re-point) the sandbox this thread reuses. */
export async function saveThreadSandbox(
  threadId: string,
  sandboxId: string
): Promise<void> {
  const now = new Date();
  await db
    .insert(threadSandboxes)
    .values({ lastUsedAt: now, sandboxId, threadId })
    .onConflictDoUpdate({
      set: { lastUsedAt: now, sandboxId },
      target: threadSandboxes.threadId,
    });
}

export async function touchThreadSandbox(threadId: string): Promise<void> {
  await db
    .update(threadSandboxes)
    .set({ lastUsedAt: new Date() })
    .where(eq(threadSandboxes.threadId, threadId));
}

export async function clearThreadSandbox(threadId: string): Promise<void> {
  await db
    .delete(threadSandboxes)
    .where(eq(threadSandboxes.threadId, threadId));
}

/**
 * Every remembered sandbox for threads rooted in one channel (thread ids are
 * `slack:CHANNEL[:TS]`). Used by a self-serve erase, which must KILL the E2B
 * sandboxes before forgetting their ids — dropping the rows alone would leave
 * paused sandboxes holding the user's files with nothing left pointing at them.
 */
export async function listThreadSandboxesForChannel(
  channelId: string
): Promise<ThreadSandbox[]> {
  return await db
    .select()
    .from(threadSandboxes)
    .where(threadsInChannel(threadSandboxes.threadId, channelId));
}

/** Rows untouched since `before` — their sandboxes are due to be reaped. */
export async function getStaleThreadSandboxes(
  before: Date
): Promise<ThreadSandbox[]> {
  return await db
    .select()
    .from(threadSandboxes)
    .where(lt(threadSandboxes.lastUsedAt, before));
}
