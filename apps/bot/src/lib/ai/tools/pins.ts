import { tool } from 'ai';
import { z } from 'zod';
import { env } from '@/env';
import type { ThreadHandle as Thread } from '@/harness';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';

const okSchema = z.looseObject({
  error: z.string().optional(),
  ok: z.boolean(),
});

const actAsSchema = z
  .enum(['bot', 'user'])
  .optional()
  .describe(
    "Who performs the action: 'bot' (default) pins as the bot; 'user' pins as the owner. 'user' only works when the owner triggered this turn."
  );

const channelIdSchema = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Target Slack channel id (e.g. C0123ABC). Defaults to the current channel.'
  );

function channelIdFromThread(thread: Thread): string | undefined {
  const [platform, channelId] = thread.id.split(':');
  return platform === 'slack' ? channelId : undefined;
}

/** Resolve the channel to act on, preferring an explicit id over the thread. */
function resolveChannel(
  thread: Thread,
  channelId?: string
): { ok: true; channelId: string } | { ok: false; error: string } {
  const resolved = channelId ?? channelIdFromThread(thread);
  if (!resolved) {
    return { error: 'Could not resolve a Slack channel.', ok: false };
  }
  return { channelId: resolved, ok: true };
}

/**
 * Owner gate for "act as the owner". The tools are registered for everyone, but
 * `as: 'user'` must never be honored for a non-owner — re-check here as
 * defense-in-depth so a misconfiguration can't let one user act as another.
 */
function ownerUserToken(authorUserId: string): string | null {
  if (
    env.SLACK_USER_TOKEN &&
    env.OWNER_USER_ID &&
    authorUserId === env.OWNER_USER_ID
  ) {
    return env.SLACK_USER_TOKEN;
  }
  return null;
}

/**
 * Call a Slack pins API method. As the bot we use the shared web client and, on
 * `not_in_channel`, try to join the (public) channel once and retry — that's the
 * usual reason a bot can't pin in another channel. As the user we call with the
 * owner's token so the pin is attributed to them.
 */
async function callPins({
  method,
  channelId,
  timestamp,
  userToken,
}: {
  method: 'pins.add' | 'pins.remove';
  channelId: string;
  timestamp: string;
  userToken: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  if (userToken) {
    const response = await fetch(`https://slack.com/api/${method}`, {
      body: JSON.stringify({ channel: channelId, timestamp }),
      headers: {
        Authorization: `Bearer ${userToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      method: 'POST',
    });
    return okSchema.parse(await response.json());
  }

  const first = okSchema.parse(
    await slack.webClient.apiCall(method, {
      channel: channelId,
      timestamp,
    })
  );
  if (first.ok || first.error !== 'not_in_channel' || method !== 'pins.add') {
    return first;
  }
  // Bot isn't in the target channel — join (public channels only) and retry.
  await slack.webClient
    .apiCall('conversations.join', { channel: channelId })
    .catch(() => undefined);
  return okSchema.parse(
    await slack.webClient.apiCall(method, { channel: channelId, timestamp })
  );
}

/** Resolve which token to use, enforcing the owner gate for `as: 'user'`. */
function tokenForActor(
  as: 'bot' | 'user' | undefined,
  authorUserId: string
): { ok: true; userToken: string | null } | { ok: false; error: string } {
  if (as !== 'user') {
    return { ok: true, userToken: null };
  }
  const userToken = ownerUserToken(authorUserId);
  if (!userToken) {
    return {
      error:
        'Pinning as the owner is only available when the owner triggers it.',
      ok: false,
    };
  }
  return { ok: true, userToken };
}

export function pinMessageTool({
  authorUserId,
  thread,
}: {
  authorUserId: string;
  thread: Thread;
}) {
  return tool({
    description:
      'Pin a message to a Slack channel so the team can find it later. Defaults to the current channel; pass channelId to pin in another channel (the bot auto-joins public channels). Use for decisions, important links, or canonical answers.',
    inputSchema: z.object({
      as: actAsSchema,
      channelId: channelIdSchema,
      messageTs: z
        .string()
        .min(1)
        .describe(
          'Timestamp (ts) of the message to pin, e.g. 1781599802.270109.'
        ),
    }),
    execute: async ({ as, channelId, messageTs }) => {
      try {
        const channel = resolveChannel(thread, channelId);
        if (!channel.ok) {
          return { error: channel.error, success: false };
        }
        const actor = tokenForActor(as, authorUserId);
        if (!actor.ok) {
          return { error: actor.error, success: false };
        }
        const result = await callPins({
          channelId: channel.channelId,
          method: 'pins.add',
          timestamp: messageTs,
          userToken: actor.userToken,
        });
        if (!result.ok) {
          return { error: `Pin failed: ${result.error}`, success: false };
        }
        return {
          success: true,
          summary: `Pinned the message to <#${channel.channelId}>${as === 'user' ? ' as the owner' : ''}.`,
        };
      } catch (error) {
        logger.warn({ error: errorMessage(error) }, '[pinMessage] failed');
        return { error: errorMessage(error), success: false };
      }
    },
  });
}

export function unpinMessageTool({
  authorUserId,
  thread,
}: {
  authorUserId: string;
  thread: Thread;
}) {
  return tool({
    description:
      'Unpin a previously pinned message from a Slack channel. Defaults to the current channel; pass channelId to unpin in another channel.',
    inputSchema: z.object({
      as: actAsSchema,
      channelId: channelIdSchema,
      messageTs: z
        .string()
        .min(1)
        .describe(
          'Timestamp (ts) of the pinned message to remove, e.g. 1781599802.270109.'
        ),
    }),
    execute: async ({ as, channelId, messageTs }) => {
      try {
        const channel = resolveChannel(thread, channelId);
        if (!channel.ok) {
          return { error: channel.error, success: false };
        }
        const actor = tokenForActor(as, authorUserId);
        if (!actor.ok) {
          return { error: actor.error, success: false };
        }
        const result = await callPins({
          channelId: channel.channelId,
          method: 'pins.remove',
          timestamp: messageTs,
          userToken: actor.userToken,
        });
        if (!result.ok) {
          return { error: `Unpin failed: ${result.error}`, success: false };
        }
        return {
          success: true,
          summary: `Removed the pin from <#${channel.channelId}>.`,
        };
      } catch (error) {
        logger.warn({ error: errorMessage(error) }, '[unpinMessage] failed');
        return { error: errorMessage(error), success: false };
      }
    },
  });
}

export function bookmarkLinkTool({ thread }: { thread: Thread }) {
  return tool({
    description:
      'Add a bookmark to a Slack channel so a link is always one click away in the channel header. Defaults to the current channel; pass channelId for another channel.',
    inputSchema: z.object({
      channelId: channelIdSchema,
      title: z
        .string()
        .min(1)
        .max(255)
        .describe('Label shown for the bookmark.'),
      link: z.string().url().describe('The URL to bookmark.'),
      emoji: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe('Optional emoji shortcode, e.g. :link:.'),
    }),
    execute: async ({ channelId, title, link, emoji }) => {
      try {
        const channel = resolveChannel(thread, channelId);
        if (!channel.ok) {
          return { error: channel.error, success: false };
        }
        const result = okSchema.parse(
          await slack.webClient.apiCall('bookmarks.add', {
            channel_id: channel.channelId,
            link,
            title,
            type: 'link',
            ...(emoji && { emoji }),
          })
        );
        if (!result.ok) {
          return { error: `Bookmark failed: ${result.error}`, success: false };
        }
        return {
          success: true,
          summary: `Bookmarked "${title}" in <#${channel.channelId}>.`,
        };
      } catch (error) {
        logger.warn({ error: errorMessage(error) }, '[bookmarkLink] failed');
        return { error: errorMessage(error), success: false };
      }
    },
  });
}
