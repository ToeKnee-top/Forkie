import { bot, slack } from '@/lib/chat';
import { toRawSlackChannelId } from '@/lib/slack/ids';
import { errorMessage } from '@/lib/utils/error';

// Slack ids carry their conversation kind in the first letter: D = a 1:1 DM,
// G / mpdm = a private or group DM. Kyto is not a member of a conversation
// between other people, so `conversations.info` on one fails with a bare
// `channel_not_found` — which reads like "that channel does not exist" and sent
// a turn off trying six other tools to get at it. Recognising the id shape
// answers correctly without an API call.
const DM_CHANNEL_ID = /^D[A-Z0-9]+$/i;
const GROUP_CHANNEL_ID = /^(G[A-Z0-9]+|mpdm-)/i;

const UNREACHABLE_CONVERSATION =
  'That is a DM or private conversation. Kyto is not a member of it and CANNOT read it — this is a hard Slack limit, not a permission you can request, and no other tool will get at it either. Do not retry with a different tool. Ask the person to paste the text, forward the message into a channel kyto is in, or say what it said.';

export async function assertReadableChannel(
  chatChannelId: string,
  options?: { currentThreadId?: string }
) {
  const currentChannelId = options?.currentThreadId
    ? slack.channelIdFromThreadId(options.currentThreadId)
    : undefined;
  const isCurrent = Boolean(
    currentChannelId && chatChannelId === currentChannelId
  );
  const raw = toRawSlackChannelId(chatChannelId);
  if (!isCurrent && (DM_CHANNEL_ID.test(raw) || GROUP_CHANNEL_ID.test(raw))) {
    throw new Error(UNREACHABLE_CONVERSATION);
  }
  const metadata = await bot
    .channel(chatChannelId)
    .fetchMetadata()
    .catch((error: unknown) => {
      // A conversation kyto isn't in doesn't exist as far as the API is
      // concerned. Say what that actually means rather than passing
      // `channel_not_found` to the model.
      if (/channel_not_found|not_in_channel/i.test(errorMessage(error))) {
        throw new Error(
          `Kyto cannot see that conversation (${raw}). If it is a public channel, kyto can join it and read it — check the id is right. If it is a DM or a private channel kyto is not in, it is unreadable: ask for the content instead of retrying.`
        );
      }
      throw error;
    });
  if (isCurrent) {
    return metadata;
  }
  if (metadata.isDM || metadata.channelVisibility !== 'workspace') {
    throw new Error(UNREACHABLE_CONVERSATION);
  }
  return metadata;
}

export async function joinChannel(channelId: string): Promise<unknown> {
  try {
    return await slack.webClient.apiCall('conversations.join', {
      channel: toRawSlackChannelId(channelId),
    });
  } catch {
    return;
  }
}
