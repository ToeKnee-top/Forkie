import { and, eq, lte, or, sql } from 'drizzle-orm';
import { db } from '../client';
import {
  type NewReminder,
  type Reminder,
  type ReminderKind,
  reminders,
} from '../schema';

export type { Reminder, ReminderKind, ReminderRecurrence } from '../schema';

const MINUTES_PER_DAY = 24 * 60;
const DAYS_PER_WEEK = 7;
const MS_PER_SECOND = 1000;

export type ReminderSchedule =
  | { recurrence: 'interval'; intervalSeconds: number }
  | { recurrence: 'daily'; timeOfDayMinutes: number }
  | { recurrence: 'weekly'; timeOfDayMinutes: number; weekday: number };

/** Compute the next fire time for a schedule, strictly after `from`. */
export function computeNextRun(schedule: ReminderSchedule, from: Date): Date {
  if (schedule.recurrence === 'interval') {
    return new Date(from.getTime() + schedule.intervalSeconds * MS_PER_SECOND);
  }

  const next = new Date(from);
  next.setUTCHours(0, 0, 0, 0);
  next.setUTCMinutes(schedule.timeOfDayMinutes);

  if (schedule.recurrence === 'daily') {
    if (next <= from) {
      next.setUTCDate(next.getUTCDate() + 1);
    }
    return next;
  }

  // weekly
  let dayDelta =
    (schedule.weekday - next.getUTCDay() + DAYS_PER_WEEK) % DAYS_PER_WEEK;
  next.setUTCDate(next.getUTCDate() + dayDelta);
  if (next <= from) {
    dayDelta = DAYS_PER_WEEK;
    next.setUTCDate(next.getUTCDate() + dayDelta);
  }
  return next;
}

export async function createReminder(input: {
  userId: string;
  text: string;
  schedule: ReminderSchedule;
  channelId?: string | null;
  editorUserIds?: string[] | null;
  maxRuns?: number | null;
  kind?: ReminderKind;
  command?: string | null;
  url?: string | null;
  threadId?: string | null;
}): Promise<Reminder> {
  const nextRunAt = computeNextRun(input.schedule, new Date());
  const values: NewReminder = {
    userId: input.userId,
    editorUserIds: input.editorUserIds ?? null,
    text: input.text,
    channelId: input.channelId ?? null,
    maxRuns: input.maxRuns ?? null,
    kind: input.kind ?? 'message',
    command: input.command ?? null,
    url: input.url ?? null,
    threadId: input.threadId ?? null,
    recurrence: input.schedule.recurrence,
    nextRunAt,
    ...(input.schedule.recurrence === 'interval'
      ? { intervalSeconds: input.schedule.intervalSeconds }
      : { timeOfDayMinutes: input.schedule.timeOfDayMinutes }),
    ...(input.schedule.recurrence === 'weekly'
      ? { weekday: input.schedule.weekday }
      : {}),
  };
  const [row] = await db.insert(reminders).values(values).returning();
  if (!row) {
    throw new Error('Failed to create reminder.');
  }
  return row;
}

/** Who a reminder is editable by: its creator, its listed editors, the owner. */
export function isReminderEditableBy(
  reminder: Reminder,
  userId: string,
  isOwner = false
): boolean {
  return (
    isOwner ||
    reminder.userId === userId ||
    (reminder.editorUserIds ?? []).includes(userId)
  );
}

/**
 * SQL form of `isReminderEditableBy`, for scoping a query. The owner may act on
 * anything, so they get no restriction at all.
 */
function editableBy(userId: string, isOwner: boolean) {
  if (isOwner) {
    return;
  }
  return or(
    eq(reminders.userId, userId),
    sql`${reminders.editorUserIds} @> ${JSON.stringify([userId])}::jsonb`
  );
}

export async function getReminder(id: string): Promise<Reminder | null> {
  const [row] = await db
    .select()
    .from(reminders)
    .where(eq(reminders.id, id))
    .limit(1);
  return row ?? null;
}

/** The active reminders a user may act on: their own, plus ones they can edit. */
export async function listActiveReminders(
  userId: string,
  isOwner = false
): Promise<Reminder[]> {
  return await db
    .select()
    .from(reminders)
    .where(and(eq(reminders.active, true), editableBy(userId, isOwner)));
}

/** Every reminder a user may act on, active and paused (for the management UI). */
export async function listUserReminders(
  userId: string,
  isOwner = false
): Promise<Reminder[]> {
  return await db.select().from(reminders).where(editableBy(userId, isOwner));
}

/** Change a reminder in place. Only the given fields are touched. */
export async function updateReminder(input: {
  id: string;
  text?: string;
  kind?: ReminderKind;
  command?: string | null;
  url?: string | null;
  channelId?: string | null;
  editorUserIds?: string[] | null;
  maxRuns?: number | null;
  schedule?: ReminderSchedule;
}): Promise<Reminder | null> {
  const { id, schedule, ...rest } = input;
  const patch: Partial<NewReminder> = { ...rest };
  if (schedule) {
    patch.recurrence = schedule.recurrence;
    patch.intervalSeconds =
      schedule.recurrence === 'interval' ? schedule.intervalSeconds : null;
    patch.timeOfDayMinutes =
      schedule.recurrence === 'interval' ? null : schedule.timeOfDayMinutes;
    patch.weekday = schedule.recurrence === 'weekly' ? schedule.weekday : null;
    // A new schedule takes effect from now, not from the old next-run instant.
    patch.nextRunAt = computeNextRun(schedule, new Date());
  }
  const [row] = await db
    .update(reminders)
    .set(patch)
    .where(eq(reminders.id, id))
    .returning();
  return row ?? null;
}

export async function cancelReminder({
  id,
  isOwner = false,
  userId,
}: {
  id: string;
  isOwner?: boolean;
  userId: string;
}): Promise<boolean> {
  const deleted = await db
    .delete(reminders)
    .where(and(eq(reminders.id, id), editableBy(userId, isOwner)))
    .returning({ id: reminders.id });
  return deleted.length > 0;
}

/** Pause a reminder (keeps it, just stops it firing). */
export async function pauseReminder({
  id,
  isOwner = false,
  userId,
}: {
  id: string;
  isOwner?: boolean;
  userId: string;
}): Promise<boolean> {
  const updated = await db
    .update(reminders)
    .set({ active: false })
    .where(and(eq(reminders.id, id), editableBy(userId, isOwner)))
    .returning({ id: reminders.id });
  return updated.length > 0;
}

/** Resume a paused reminder, snapping its next run to the future. */
export async function resumeReminder({
  id,
  isOwner = false,
  userId,
}: {
  id: string;
  isOwner?: boolean;
  userId: string;
}): Promise<boolean> {
  const [row] = await db
    .select()
    .from(reminders)
    .where(and(eq(reminders.id, id), editableBy(userId, isOwner)))
    .limit(1);
  if (!row) {
    return false;
  }
  const now = new Date();
  const nextRunAt =
    row.nextRunAt > now ? row.nextRunAt : computeNextRun(scheduleOf(row), now);
  await db
    .update(reminders)
    .set({ active: true, nextRunAt })
    .where(eq(reminders.id, row.id));
  return true;
}

export async function getDueReminders(now: Date): Promise<Reminder[]> {
  return await db
    .select()
    .from(reminders)
    .where(and(eq(reminders.active, true), lte(reminders.nextRunAt, now)));
}

/**
 * Advance a fired reminder to its next occurrence, incrementing its run count.
 * When a run cap is set and reached, the reminder is deactivated instead.
 *
 * The next run is computed from `nextRunAt` or from now, whichever is later. If
 * the scheduler was down (or a fire took a long time), a schedule left in the
 * past would otherwise fire again on every 30s poll until it caught up — a
 * harmless repeat for a 'message' reminder, but a burst of sandbox boots or
 * model calls for a 'bash'/'agent' one.
 */
export async function advanceReminder(reminder: Reminder): Promise<void> {
  const runCount = (reminder.runCount ?? 0) + 1;
  const capReached = reminder.maxRuns !== null && runCount >= reminder.maxRuns;
  if (capReached) {
    await db
      .update(reminders)
      .set({ active: false, runCount })
      .where(eq(reminders.id, reminder.id));
    return;
  }
  const now = new Date();
  const base = reminder.nextRunAt > now ? reminder.nextRunAt : now;
  const nextRunAt = computeNextRun(scheduleOf(reminder), base);
  await db
    .update(reminders)
    .set({ nextRunAt, runCount })
    .where(eq(reminders.id, reminder.id));
}

function scheduleOf(reminder: Reminder): ReminderSchedule {
  if (reminder.recurrence === 'interval') {
    return {
      recurrence: 'interval',
      intervalSeconds: reminder.intervalSeconds ?? MINUTES_PER_DAY * 60,
    };
  }
  if (reminder.recurrence === 'weekly') {
    return {
      recurrence: 'weekly',
      timeOfDayMinutes: reminder.timeOfDayMinutes ?? 0,
      weekday: reminder.weekday ?? 0,
    };
  }
  return {
    recurrence: 'daily',
    timeOfDayMinutes: reminder.timeOfDayMinutes ?? 0,
  };
}
