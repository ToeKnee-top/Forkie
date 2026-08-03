import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * The E2B sandbox a thread reuses across turns. A turn pauses its sandbox
 * instead of killing it, and the next turn in the same thread reconnects here,
 * so files the model wrote are still there.
 *
 * Deliberately separate from the orphaned `sandbox_sessions` table, whose
 * columns (`session_id`, `resume_state`, `session`) belong to an abandoned
 * Pi-transcript-mirroring design and were never written by any live code path.
 *
 * `last_used_at` drives the reaper: a sandbox untouched for longer than the TTL
 * is killed, since a paused sandbox still costs storage.
 */
export const threadSandboxes = pgTable(
  'thread_sandboxes',
  {
    threadId: text('thread_id').primaryKey(),
    sandboxId: text('sandbox_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('thread_sandboxes_last_used_idx').on(table.lastUsedAt)]
);

export type ThreadSandbox = typeof threadSandboxes.$inferSelect;
export type NewThreadSandbox = typeof threadSandboxes.$inferInsert;
