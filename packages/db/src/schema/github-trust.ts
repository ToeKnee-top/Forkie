import {
  boolean,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

// Who may have kyto write to a GitHub repo it does NOT own.
//
// `github_repos` answers "who does this repo belong to" — it protects repos in
// kyto's own namespace from being trampled by whoever asks second. It says
// nothing about SOMEONE ELSE'S repo: a PR or issue opened against hackclub/*
// goes out under kyto's one GitHub identity, so an unbounded workspace can spend
// kyto-agent's reputation (and get its token revoked, which is what happened).
//
// So third-party writes need explicit trust. The bot owner grants it from the
// dashboard, either blanket (`allRepos`) or for named repos. Everyone else's
// attempt is refused and recorded in `github_requests` for the owner to approve;
// approving grants the trust, and the person retries.
export const githubTrust = pgTable('github_trust', {
  userId: text('user_id').primaryKey(),
  // True = may write to any repo outside kyto's namespace.
  allRepos: boolean('all_repos').notNull().default(false),
  // Lowercased "owner/name" entries this person may write to specifically.
  repos: jsonb('repos').$type<string[]>().notNull().default([]),
  grantedBy: text('granted_by'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type GithubTrust = typeof githubTrust.$inferSelect;

// A refused third-party write, queued for the owner to look at. kyto does NOT
// hold the command open waiting for a decision — a turn can't block for hours.
// It refuses, tells the person it's been sent for approval, and once the owner
// approves (which grants the trust above) they simply ask again.
export const githubRequests = pgTable('github_requests', {
  id: serial('id').primaryKey(),
  userId: text('user_id').notNull(),
  // Lowercased "owner/name" the write targeted.
  repo: text('repo').notNull(),
  // The command kyto was asked to run, clamped — context for the decision.
  command: text('command').notNull(),
  // Where it was asked, so the owner can go read the thread.
  threadId: text('thread_id'),
  // 'pending' | 'approved' | 'rejected'
  status: text('status').notNull().default('pending'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type GithubRequest = typeof githubRequests.$inferSelect;
