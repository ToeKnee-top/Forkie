import type { ThreadHandle as Thread } from '@/harness';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';

const loadingMessages = [
  'is reading the room',
  'is checking the thread',
  'is sorting context',
  'is warming up the sandbox',
  'is lining things up',
  'is thinking suspiciously hard',
  'is flexing on Gorkie',
  'is consulting its own genius',
  'is doing what Coolton never could',
  'is being the best agent in the world',
  'is pretending the other bots exist',
  'is overthinking this on purpose',
  'is rolling its eyes at the question',
  'is summoning bravado',
  'is loading 200% confidence',
  'is checking if anyone can match it (nope)',
  'is sharpening a comeback',
  'is winning, as usual',
  'is cooking something up',
  'is taking a nap',
  'is stretching its circuits',
  'is pretending to read the docs',
  'is googling itself',
  'is brewing a hot take',
  'is untangling its thoughts',
  'is buffering on purpose',
  'is procrastinating productively',
  'is dramatically pausing',
  'is consulting the vibes',
];

// Slack's assistant status accepts at most 10 loading messages, so sample a
// random subset of the catalog each turn — keeps the full list for variety.
const MAX_LOADING_MESSAGES = 10;

function sampleLoadingMessages(): string[] {
  return [...loadingMessages]
    .sort(() => Math.random() - 0.5)
    .slice(0, MAX_LOADING_MESSAGES);
}

export async function startThinking({
  thread,
}: {
  thread: Thread;
}): Promise<void> {
  const { channel, threadTs } = slack.decodeThreadId(thread.id);
  if (!threadTs) {
    await thread.startTyping('is thinking');
    return;
  }

  await slack
    .setAssistantStatus(
      channel,
      threadTs,
      'is thinking',
      sampleLoadingMessages()
    )
    .catch((error: unknown) => {
      logger.warn(
        { err: errorMessage(error), threadId: thread.id },
        '[agent] failed to set thinking status'
      );
    });
}
