import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// Who a GitHub repository belongs to, from kyto's point of view. kyto acts on
// GitHub as ONE account (`kyto-agent`), so without this every user who can talk
// to kyto inherits kyto's write access to every repo it has ever touched: person
// A has kyto create a repo, person B then asks kyto to close A's PR, force-push,
// or delete it, and kyto happily obliges because the token is the same.
//
// A repo is claimed by the person kyto created it for (and by the first person a
// mutating command is run for, when the repo lives in kyto's own namespace).
// After that only that person, anyone they named as an editor, and the bot owner
// can get kyto to change it — read-only commands stay open to everyone.
export const githubRepos = pgTable('github_repos', {
  // Lowercased "owner/name".
  repo: text('repo').primaryKey(),
  ownerUserId: text('owner_user_id').notNull(),
  // Slack user ids allowed to change it alongside the claimant.
  editorUserIds: jsonb('editor_user_ids').$type<string[]>(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type GithubRepo = typeof githubRepos.$inferSelect;
