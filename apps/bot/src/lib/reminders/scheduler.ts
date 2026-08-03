import {
  advanceReminder,
  getDueReminders,
  type Reminder,
} from '@repo/db/queries';
import type { KytoBot as Chat } from '@/harness';
import { fetchUrlText } from '@/lib/ai/tools/url';
import { resolveIdentity } from '@/lib/identity';
import logger from '@/lib/logger';
import { runReminderAgent } from '@/lib/reminders/agent';
import { runReminderBash } from '@/lib/reminders/bash';
import { errorMessage } from '@/lib/utils/error';

// Recurring reminders are Kyto's own durable side effect — same precedent as
// static site hosting and the opt-in allowlist. A single setInterval loop on
// the always-on systemd process is sufficient; Slack's own chat.scheduleMessage
// API (used by the one-time `scheduleReminder` tool) only supports a single
// future timestamp, not recurrence, so recurring reminders are driven here.
const POLL_INTERVAL_MS = 30_000;

// A reminder is only advanced to its next run AFTER it fires, and a 'bash' or
// 'agent' fire can take minutes (it may queue on its thread's sandbox lock, or
// run a whole tool loop). Every 30s poll in that window would see the same row
// still due and start it again. So a reminder already in flight is skipped.
const inFlight = new Set<string>();

/** What this reminder posts on this fire, by kind. */
async function buildReminderMessage(reminder: Reminder): Promise<string> {
  if (reminder.kind === 'script') {
    if (!reminder.url) {
      throw new Error("Script reminder is missing a 'url'.");
    }
    const { content } = await fetchUrlText(reminder.url);
    return reminder.text ? `${reminder.text}\n\n${content}` : content;
  }
  if (reminder.kind === 'bash') {
    const output = await runReminderBash(reminder);
    const fenced = `\`\`\`\n${output}\n\`\`\``;
    return reminder.text ? `${reminder.text}\n\n${fenced}` : fenced;
  }
  if (reminder.kind === 'agent') {
    return await runReminderAgent(reminder);
  }
  return reminder.text;
}

// How much of the standing instruction to echo back. Enough to recognise which
// job this is; the full text lives in `listReminders`.
const JOB_HEADER_MAX = 160;

/**
 * The line that says which standing instruction produced this post.
 *
 * An agent job's output is just… prose, arriving in a DM out of nowhere, and
 * the reader has no idea which of their recurring jobs wrote it or that it was
 * automated at all. This is what a "you asked me to check X" line buys, without
 * kyto posting AS the person — impersonating the owner is exactly what the
 * confirm gate exists to prevent, and it must not become automatic just because
 * a scheduler triggered it.
 *
 * Only for `agent` jobs: a plain text reminder IS the message, and a bash or
 * script reminder already carries its own command output.
 */
function jobHeader(reminder: Reminder): string {
  if (reminder.kind !== 'agent') {
    return '';
  }
  const instruction = reminder.text.trim().replace(/\s+/g, ' ');
  const shown =
    instruction.length > JOB_HEADER_MAX
      ? `${instruction.slice(0, JOB_HEADER_MAX)}…`
      : instruction;
  return shown ? `_recurring job — you asked me to: ${shown}_\n\n` : '';
}

async function fireReminder(bot: Chat, reminder: Reminder): Promise<void> {
  let markdown: string;
  try {
    markdown = await buildReminderMessage(reminder);
  } catch (error) {
    // A failed run still posts, so a broken command/script/job is visible to
    // its owner rather than silently doing nothing on every interval.
    logger.warn(
      {
        err: errorMessage(error),
        kind: reminder.kind,
        reminderId: reminder.id,
      },
      '[reminders] failed to build reminder content'
    );
    markdown = `Reminder: ${reminder.text}\n\n_(Couldn't complete this run: ${errorMessage(error)})_`;
  }

  try {
    const identity = await resolveIdentity('reminder');
    // A channel target posts into that channel; otherwise DM the user.
    const target = reminder.channelId
      ? bot.channel(reminder.channelId)
      : await bot.openDM(reminder.userId);
    const mention = reminder.channelId ? `<@${reminder.userId}> ` : '';
    await target.post({
      iconEmoji: identity.iconEmoji,
      iconUrl: identity.iconUrl,
      markdown: `${mention}${jobHeader(reminder)}${markdown}`,
    });
  } catch (error) {
    logger.warn(
      { err: errorMessage(error), reminderId: reminder.id },
      '[reminders] failed to post reminder'
    );
  }
  await advanceReminder(reminder).catch((error: unknown) => {
    logger.error(
      { err: errorMessage(error), reminderId: reminder.id },
      '[reminders] failed to advance reminder to its next run'
    );
  });
}

async function pollOnce(bot: Chat): Promise<void> {
  const due = await getDueReminders(new Date());
  const ready = due.filter((reminder) => !inFlight.has(reminder.id));
  // Fire concurrently: a slow 'bash'/'agent' reminder must not delay the rest.
  await Promise.all(
    ready.map(async (reminder) => {
      inFlight.add(reminder.id);
      try {
        await fireReminder(bot, reminder);
      } finally {
        inFlight.delete(reminder.id);
      }
    })
  );
}

export function startReminderScheduler(bot: Chat): void {
  const tick = (): void => {
    pollOnce(bot).catch((error: unknown) => {
      logger.error({ err: errorMessage(error) }, '[reminders] poll failed');
    });
  };
  setInterval(tick, POLL_INTERVAL_MS);
  tick();
  logger.info(
    { intervalMs: POLL_INTERVAL_MS },
    '[reminders] scheduler started'
  );
}
