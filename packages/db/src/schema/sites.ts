import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// Ownership of a published static site (the files themselves live on disk under
// SITES_ROOT). A site is claimed by whoever first deploys it; after that only
// that person, anyone they listed as an editor, and the bot owner may redeploy,
// change its editors, or take it down.
export const sites = pgTable('sites', {
  // The site name, i.e. the `/<name>/` path segment it is served at.
  name: text('name').primaryKey(),
  ownerUserId: text('owner_user_id').notNull(),
  // Slack user ids allowed to edit alongside the owner. Empty = owner only.
  editorUserIds: jsonb('editor_user_ids').$type<string[]>(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type Site = typeof sites.$inferSelect;
