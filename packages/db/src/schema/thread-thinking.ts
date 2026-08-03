import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// A thread's recent private reasoning, persisted so it survives a bot restart.
// Slack only records what kyto SAID; the reasoning behind it lived in the plan's
// Thinking cards and was otherwise gone, so a new turn re-derived the previous
// turn's conclusions and dead ends. Only the last few turns are kept (the module
// tail-clamps), and rows are reaped after ~a month so this stays a short-lived
// train of thought, not a permanent transcript.
export const threadThinking = pgTable('thread_thinking', {
  threadId: text('thread_id').primaryKey(),
  // The reasoning of the last few turns, oldest first (already tail-clamped).
  turns: jsonb('turns').$type<string[]>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type ThreadThinking = typeof threadThinking.$inferSelect;
