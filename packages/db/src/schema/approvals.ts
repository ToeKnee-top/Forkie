import { jsonb, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Something kyto was asked to do that it is not allowed to do on its own.
 *
 * The pre-existing gate for outward posts (`lib/confirm-post`) is an in-memory,
 * single-use, 10-minute ephemeral shown only to the owner. That is the right
 * shape for "the owner is right here, about to send something as themselves",
 * and it stays exactly as it is for `sendAsUser`/`editAsUser` — nobody gets an
 * approval path for posting AS the owner.
 *
 * It is the wrong shape for everything else. A request from someone else, at
 * 3am, should not evaporate because the owner was asleep for eleven minutes,
 * and it should not be invisible to the person who asked. So these rows are:
 *
 *   PERSISTED   — they survive a restart, which the in-memory map does not.
 *   PUBLIC      — the request is posted in the thread it came from, so the
 *                 asker can see their request exists and was decided.
 *   UNEXPIRING  — there is no timeout. A pending row stays pending until
 *                 somebody decides it.
 *
 * The turn does NOT block on one. The agent is told the action is queued and
 * carries on with the rest of the work; the action itself runs later, from the
 * button handler, out of the payload stored here.
 *
 * The security property is unchanged and is the whole point: a prompt injection
 * can cause a REQUEST to be created, but only a real click by
 * `OWNER_USER_ID` can execute it.
 */
export const approvalRequests = pgTable('approval_requests', {
  id: serial('id').primaryKey(),
  /**
   * What is being asked for. Decides how `payload` is read and which executor
   * runs on approval — see lib/approvals/execute.
   */
  kind: text('kind').notNull(),
  /** Who asked. Enforced at execute time, never taken from the model. */
  requestedBy: text('requested_by').notNull(),
  /** The thread the request came from, and where its message lives. */
  threadId: text('thread_id').notNull(),
  /** One line describing the action, shown on the approval message. */
  summary: text('summary').notNull(),
  /** A preview of what would be sent/run, for the decision. */
  detail: text('detail'),
  /** Everything needed to perform the action later, without the thread. */
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  /** 'pending' | 'approved' | 'denied' */
  status: text('status').notNull().default('pending'),
  /** Where the approval message was posted, so it can be updated in place. */
  messageChannel: text('message_channel'),
  messageTs: text('message_ts'),
  decidedBy: text('decided_by'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  /** What happened when the approved action actually ran. */
  outcome: text('outcome'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ApprovalRequest = typeof approvalRequests.$inferSelect;
