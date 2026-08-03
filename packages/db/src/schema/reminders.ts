import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const reminderRecurrence = pgEnum('reminder_recurrence', [
  'interval',
  'daily',
  'weekly',
]);

export type ReminderRecurrence = (typeof reminderRecurrence.enumValues)[number];

// What a reminder actually does each time it fires:
// 'message': posts `text` verbatim (the original, and still the default).
// 'script':  fetches `url` and posts its content, optionally prefixed by `text`.
// 'bash':    runs `command` in the sandbox of the thread it was created in
//            (`thread_id`) and posts its exact stdout/stderr. Because thread
//            sandboxes persist, this can use files the model wrote earlier.
// 'agent':   runs a headless kyto with `text` as its instructions, on the cheap
//            pinned model, and posts whatever it decides to say.
// Label order matches the live `reminder_kind` type, which predates this code
// (an earlier branch created it). Drizzle matches on label, not ordinal.
export const reminderKind = pgEnum('reminder_kind', [
  'message',
  'script',
  'agent',
  'bash',
]);

export type ReminderKind = (typeof reminderKind.enumValues)[number];

export const reminders = pgTable(
  'reminders',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id').notNull(),
    // Slack user ids allowed to edit/pause/cancel this reminder alongside its
    // creator. Empty = creator only. The bot owner may always edit anything.
    editorUserIds: jsonb('editor_user_ids').$type<string[]>(),
    text: text('text').notNull(),
    kind: reminderKind('kind').notNull().default('message'),
    // 'bash': the shell command to run each fire.
    command: text('command'),
    // 'script': the URL to fetch each fire.
    url: text('url'),
    // 'bash'/'agent': the thread this reminder was created in. A bash reminder
    // reuses that thread's persistent sandbox; an agent reminder posts into it
    // when no channel is set.
    threadId: text('thread_id'),
    // Where the reminder fires: a channel id (raw C…/G…) or null = DM the user.
    channelId: text('channel_id'),
    // Optional cap: stop (deactivate) after this many fires. Null = forever.
    maxRuns: integer('max_runs'),
    runCount: integer('run_count').notNull().default(0),
    recurrence: reminderRecurrence('recurrence').notNull(),
    // 'interval': how often to repeat, in seconds.
    intervalSeconds: integer('interval_seconds'),
    // 'daily' / 'weekly': minutes since UTC midnight the reminder fires at.
    timeOfDayMinutes: integer('time_of_day_minutes'),
    // 'weekly': 0 (Sunday) through 6 (Saturday), UTC.
    weekday: integer('weekday'),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('reminders_due_idx').on(table.active, table.nextRunAt),
    index('reminders_user_idx').on(table.userId),
  ]
);

export type Reminder = typeof reminders.$inferSelect;
export type NewReminder = typeof reminders.$inferInsert;
