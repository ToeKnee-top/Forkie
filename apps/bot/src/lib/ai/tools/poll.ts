import { tool } from 'ai';
import { z } from 'zod';
import type { ThreadHandle as Thread } from '@/harness';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { buildPollBlocks, buildPollMetadata } from '@/lib/slack/poll';
import { errorMessage } from '@/lib/utils/error';

const postMessageSchema = z.looseObject({
  error: z.string().optional(),
  ok: z.boolean(),
  ts: z.string().optional(),
});

export function pollTool({ thread }: { thread: Thread }) {
  return tool({
    description:
      'Post an interactive poll card to the current thread. Members vote by clicking a button under their choice (click again to undo); the card shows live tallies with bars. No reactions involved.',
    inputSchema: z.object({
      question: z.string().min(1).max(300).describe('The poll question.'),
      options: z
        .array(z.string().min(1).max(150))
        .min(2)
        .max(10)
        .describe('Between 2 and 10 answer options.'),
    }),
    execute: async ({ question, options }) => {
      try {
        const [platform, channelId, threadTs] = thread.id.split(':');
        if (platform !== 'slack' || !channelId) {
          return {
            error: 'Could not resolve a Slack channel for this thread.',
            success: false,
          };
        }

        const state = { options, question, votes: {} };
        const posted = postMessageSchema.parse(
          await slack.webClient.apiCall('chat.postMessage', {
            blocks: buildPollBlocks(state),
            channel: channelId,
            metadata: buildPollMetadata(state),
            text: `Poll: ${question}`,
            ...(threadTs && { thread_ts: threadTs }),
          })
        );
        if (!posted.ok) {
          return {
            error: `Failed to post poll: ${posted.error ?? 'unknown'}`,
            success: false,
          };
        }

        return {
          optionCount: options.length,
          success: true,
          summary: `Posted an interactive poll with ${options.length} options.`,
        };
      } catch (error) {
        logger.warn({ error: errorMessage(error) }, '[poll] failed');
        return { error: errorMessage(error), success: false };
      }
    },
  });
}
