import { env } from '@/env';
import { KytoBot, SlackHarness } from '@/harness';
import logger from '@/lib/logger';

// kyto's custom Slack harness (replaces the chat-sdk + @chat-adapter/slack).
// `slack` is the Web API facade; `bot` owns the Socket Mode connection and
// event routing. Same export names as before so call-sites stay stable.
export const slack = new SlackHarness({
  botToken: env.SLACK_BOT_TOKEN,
  logger,
});

export const bot = new KytoBot({
  appToken: env.SLACK_APP_TOKEN,
  harness: slack,
  logger,
});
