import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// Per-message-type presentation for kyto: an optional icon (a Slack `:emoji:`
// code or an image URL). The name is always plain "kyto" — never renamed, never
// suffixed. Configured by the owner from the App Home tab and applied when kyto
// posts that kind of message (a normal reply, a reminder DM, etc.).
export const identityProfiles = pgTable('identity_profiles', {
  // 'normal' | 'subagent' | 'reminder'.
  messageType: text('message_type').primaryKey(),
  icon: text('icon'),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type IdentityProfile = typeof identityProfiles.$inferSelect;
