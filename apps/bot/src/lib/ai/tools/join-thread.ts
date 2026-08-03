import { tool } from 'ai';
import { z } from 'zod';
import type { ThreadHandle as Thread } from '@/harness';

export function joinThreadTool({ thread }: { thread: Thread }) {
  return tool({
    description:
      'Join the current thread: start auto-responding to its messages even without being @mentioned. Use this when asked to follow along, keep participating, or stay engaged in a thread. Use leaveThread to stop.',
    inputSchema: z.object({}),
    execute: async () => {
      await thread.setState({ respondOnThreadMessages: true });
      await thread.subscribe();
      return {
        joined: true,
        summary:
          'Joined the thread. I will keep responding to new messages here without needing an @mention.',
      };
    },
  });
}
