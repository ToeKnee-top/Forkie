import type { RequestHints } from '@repo/ai';
import { getUserCustomization, listMemoryIndex } from '@repo/db/queries';
import { env } from '@/env';
import type { Message, ThreadHandle as Thread } from '@/harness';
import { slack } from '@/lib/chat';
import { resolveKytoEmail } from '@/lib/email/address';
import { resolveChannelName, resolveWorkspaceName } from '@/lib/slack/names';

export async function requestHints({
  message,
  thread,
}: {
  message: Message;
  thread: Thread;
}): Promise<RequestHints> {
  const channelId = slack.channelIdFromThreadId(thread.id);
  const { channel: rawChannelId } = slack.decodeThreadId(thread.id);
  const [channel, workspace, customization, memories, email] =
    await Promise.all([
      resolveChannelName(rawChannelId),
      resolveWorkspaceName(),
      getUserCustomization(message.author.userId).catch(() => null),
      // Scoped to the person kyto is answering: their own memories plus whatever
      // the owner has promoted to global. Someone else's private notes are never
      // in this list, so they can't become instructions on a stranger's turn.
      listMemoryIndex(message.author.userId).catch(() => []),
      // Cached after the first resolve — no per-turn AgentMail call.
      resolveKytoEmail().catch(() => undefined),
    ]);
  return {
    botUserId: slack.botUserId,
    channel: {
      id: channelId,
      name: channel,
    },
    customization,
    email,
    memories,
    messageId: message.id,
    ownerUserId: env.OWNER_USER_ID,
    githubLogin: env.GH_LOGIN,
    workspace,
    threadId: thread.id,
    time: new Date().toISOString(),
  };
}
