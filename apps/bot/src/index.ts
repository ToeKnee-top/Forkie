import { bot } from '@/bot';
import { stopAllTurns } from '@/lib/agent';
import { startSummaryReaper } from '@/lib/agent/compaction';
import { startThinkingReaper } from '@/lib/agent/thinking';
import { buildAllowlist } from '@/lib/allowed-users';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { startReminderScheduler } from '@/lib/reminders/scheduler';
import { startSandboxReaper } from '@/lib/sandbox/store';
import { startSitesServer } from '@/lib/sites/server';

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  stopAllTurns();
  logger.info({ signal }, '[bot] shutting down');
  await bot.shutdown().catch((error: unknown) => {
    logger.error({ err: error }, '[bot] error during shutdown');
  });
  process.exit(0);
}

try {
  await bot.initialize();
  await buildAllowlist();
  await startSitesServer();
  startReminderScheduler(bot);
  // Paused thread sandboxes keep costing storage; collect the idle ones.
  startSandboxReaper();
  // Reap thread reasoning older than the retention window.
  startThinkingReaper();
  // Same window, same reason, for compacted thread history.
  startSummaryReaper();
  const botProfile = slack.botUserId
    ? await slack.webClient.users
        .info({ user: slack.botUserId })
        .catch(() => null)
    : null;
  logger.info(
    `[bot] ${botProfile?.user?.profile?.display_name || botProfile?.user?.profile?.real_name || botProfile?.user?.name || 'forkie'} (${slack.botUserId ?? 'unknown id'}) is online`
  );
} catch (error) {
  logger.error({ err: error }, '[bot] failed to start');
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    shutdown(signal).catch((error: unknown) => {
      logger.error({ err: error }, '[bot] shutdown failed');
      process.exit(1);
    });
  });
}
