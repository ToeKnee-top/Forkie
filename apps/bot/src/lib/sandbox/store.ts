import {
  clearThreadSandbox,
  getStaleThreadSandboxes,
  getThreadSandbox,
  saveThreadSandbox,
  touchThreadSandbox,
} from '@repo/db/queries';
import { killSandbox, type SandboxStore } from '@repo/sandbox';
import { env } from '@/env';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';

// A paused sandbox keeps its filesystem (and so its cost) indefinitely. Threads
// go quiet forever, so anything untouched for this long is killed and forgotten;
// the next turn in that thread just starts from a fresh sandbox. Held for ~a
// month (the E2B plan allows long pauses) so a thread picked back up weeks later
// still has its files; override with SANDBOX_TTL_DAYS.
const SANDBOX_TTL_MS =
  (Number(process.env.SANDBOX_TTL_DAYS) || 30) * 24 * 60 * 60 * 1000;
const REAP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Makes a thread's E2B sandbox persist across its turns: the turn pauses the
 * sandbox instead of killing it, and the next turn reconnects to the same
 * filesystem. This is what lets a bash reminder run the script kyto wrote for
 * it in an earlier turn.
 */
export const threadSandboxStore: SandboxStore = {
  async clear(threadId) {
    await clearThreadSandbox(threadId);
  },
  async load(threadId) {
    const row = await getThreadSandbox(threadId);
    if (!row) {
      return null;
    }
    // Keep the row alive so the reaper doesn't collect a thread still in use.
    await touchThreadSandbox(threadId).catch(() => undefined);
    return row.sandboxId;
  },
  async save(threadId, sandboxId) {
    await saveThreadSandbox(threadId, sandboxId);
  },
};

// A thread's sandbox is a single mutable machine, and two things now reach for
// it: a live turn, and a bash reminder firing on the scheduler. Pausing one out
// from under the other would fail its in-flight command, so all sandbox use for
// a thread is serialized through this chain of promises.
//
// Waiting is bounded in practice: a turn holds the lock for at most its
// watchdog timeout (AGENT_ATTEMPT_TIMEOUT_MS), and reminders fire concurrently
// with each other, so a queued reminder never blocks unrelated ones.
const locks = new Map<string, Promise<unknown>>();

/**
 * Take this thread's sandbox lock. Resolves to the release function, which the
 * caller MUST invoke (in a `finally`) or the thread's sandbox is wedged until
 * the process restarts.
 */
export function acquireThreadSandbox(threadId: string): Promise<() => void> {
  const previous = locks.get(threadId) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Queue behind the previous holder whether it succeeded or failed — one
  // turn's error must not wedge the thread's sandbox for every turn after it.
  const tail: Promise<void> = previous
    .then(
      () => held,
      () => held
    )
    .finally(() => {
      // Only the last waiter clears the entry, so the map doesn't grow with
      // every thread ever seen.
      if (locks.get(threadId) === tail) {
        locks.delete(threadId);
      }
    });
  locks.set(threadId, tail);
  return previous.then(
    () => release,
    () => release
  );
}

/** Run `fn` holding this thread's sandbox lock. */
export async function withThreadSandbox<T>(
  threadId: string,
  fn: () => Promise<T>
): Promise<T> {
  const release = await acquireThreadSandbox(threadId);
  try {
    return await fn();
  } finally {
    release();
  }
}

async function reapOnce(): Promise<void> {
  const stale = await getStaleThreadSandboxes(
    new Date(Date.now() - SANDBOX_TTL_MS)
  );
  for (const row of stale) {
    // Killing is E2B-only: local/ssh providers have no sandbox ids to kill. The
    // store row is cleared either way.
    if (env.E2B_API_KEY) {
      await killSandbox(row.sandboxId, env.E2B_API_KEY).catch(
        (error: unknown) => {
          // Already gone is the common case; forget it either way.
          logger.info(
            { err: errorMessage(error), sandboxId: row.sandboxId },
            '[sandbox] reaper could not kill sandbox'
          );
        }
      );
    }
    await clearThreadSandbox(row.threadId).catch(() => undefined);
  }
  if (stale.length > 0) {
    logger.info({ count: stale.length }, '[sandbox] reaped idle sandboxes');
  }
}

export function startSandboxReaper(): void {
  const tick = (): void => {
    reapOnce().catch((error: unknown) => {
      logger.error({ err: errorMessage(error) }, '[sandbox] reaper failed');
    });
  };
  setInterval(tick, REAP_INTERVAL_MS);
  tick();
}
