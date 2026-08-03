import type { Message, ThreadHandle as Thread } from '@/harness';
import { stopTurn } from '@/lib/agent';
import logger from '@/lib/logger';
import { toLogError } from '@/lib/utils/error';
import { rawText, withoutLeadingMentions } from '@/lib/utils/message';

interface BotCommand {
  type: 'stop';
}

export async function handleCommand({
  message,
  thread,
}: {
  message: Message;
  thread: Thread;
}): Promise<boolean> {
  const command = cmd(message);
  if (!command) {
    return false;
  }

  const stopped = stopTurn({ threadId: thread.id });
  if (!stopped) {
    await thread
      .postEphemeral(message.author, 'no active response to stop.', {
        fallbackToDM: false,
      })
      .catch((error: unknown) => {
        logger.warn(
          {
            ...toLogError(error),
            threadId: thread.id,
            userId: message.author.userId,
          },
          'Failed to post stop feedback'
        );
      });
  }
  return true;
}

function cmd(message: Message): BotCommand | null {
  const body = withoutLeadingMentions(rawText(message)).trim();

  const match = body.match(/^!(\w+)\b(.*)$/is);
  if (!match?.[1]) {
    return null;
  }

  switch (match[1].toLowerCase()) {
    case 'stop':
      return { type: 'stop' };
    default:
      return null;
  }
}
