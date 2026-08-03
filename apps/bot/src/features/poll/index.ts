import { bot, slack } from '@/lib/chat';
import logger from '@/lib/logger';
import {
  buildPollBlocks,
  buildPollMetadata,
  POLL_VOTE_ACTIONS,
  parsePollStateFromRaw,
} from '@/lib/slack/poll';
import { toLogError } from '@/lib/utils/error';

bot.onAction(POLL_VOTE_ACTIONS, async (event) => {
  const [platform, channelId] = event.threadId.split(':');
  if (platform !== 'slack' || !channelId) {
    return;
  }

  const state = parsePollStateFromRaw(event.raw);
  if (!state) {
    logger.warn(
      { userId: event.user.userId },
      'Poll vote action missing poll state'
    );
    return;
  }

  const optionIndex = Number(event.value);
  if (
    !Number.isInteger(optionIndex) ||
    optionIndex < 0 ||
    optionIndex >= state.options.length
  ) {
    return;
  }

  const userId = event.user.userId;
  // Clicking the current choice clears it (toggle); otherwise switch the vote.
  if (state.votes[userId] === optionIndex) {
    delete state.votes[userId];
  } else {
    state.votes[userId] = optionIndex;
  }

  await slack.webClient
    .apiCall('chat.update', {
      blocks: buildPollBlocks(state),
      channel: channelId,
      metadata: buildPollMetadata(state),
      text: `Poll: ${state.question}`,
      ts: event.messageId,
    })
    .catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), userId: event.user.userId },
        'Failed to update poll after vote'
      );
    });
});
