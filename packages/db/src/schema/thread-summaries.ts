import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// A compacted summary of the part of a Slack thread that no longer fits in the
// prompt. buildPrompt replays the thread as kyto's only memory of it, capped at
// the most recent N messages — past that the oldest simply vanished, with the
// model never told anything was missing. This row is what those messages became.
//
// Written incrementally: each turn folds only the messages that have newly
// fallen out of the replay window into the existing summary, so a long thread
// costs one small call occasionally rather than re-summarizing itself forever.
// Reaped on the same ~month retention as thread_thinking — it is derived text
// about a conversation, held for the same reason and for no longer.
export const threadSummaries = pgTable('thread_summaries', {
  // How many messages the summary accounts for, so the prompt can say so.
  coveredCount: integer('covered_count').notNull(),
  summary: text('summary').notNull(),
  threadId: text('thread_id').primaryKey(),
  // Id of the newest message folded in. Everything after it is either still
  // replayed verbatim or waiting to be compacted on a later turn.
  throughMessageId: text('through_message_id').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type ThreadSummary = typeof threadSummaries.$inferSelect;
