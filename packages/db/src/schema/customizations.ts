import { boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const userCustomizations = pgTable('user_customizations', {
  userId: text('user_id').primaryKey(),
  prompt: text('prompt').notNull(),
  // Whether to append the per-turn usage footer (token count · tok/s) under
  // Kyto's replies for this user. Opt-out toggle from the App Home tab.
  showUsageFooter: boolean('show_usage_footer').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type UserCustomization = Pick<
  typeof userCustomizations.$inferSelect,
  'prompt' | 'showUsageFooter'
>;
