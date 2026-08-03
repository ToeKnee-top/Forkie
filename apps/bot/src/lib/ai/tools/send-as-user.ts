import { tool } from 'ai';
import { z } from 'zod';
import { env } from '@/env';
import type { ThreadHandle as Thread } from '@/harness';
import {
  neutralizeBroadcast,
  neutralizeBroadcastDeep,
  restoreAnnotatedMentions,
} from '@/harness';
import { requestPostConfirmation } from '@/lib/confirm-post/request';
import logger from '@/lib/logger';
import { normalizeSlackChannelArg, toRawSlackUserId } from '@/lib/slack/ids';
import { errorMessage } from '@/lib/utils/error';
import { parseBlocks } from './post-message';

const postMessageSchema = z.looseObject({
  error: z.string().optional(),
  ok: z.boolean(),
  ts: z.string().optional(),
});

const openDmSchema = z.looseObject({
  channel: z.looseObject({ id: z.string() }).optional(),
  error: z.string().optional(),
  ok: z.boolean(),
});

/**
 * Shared owner gate. The tools are only registered for the owner (see
 * toolset.ts), but we re-check here as defense-in-depth so a misconfiguration
 * can never let one user act as another.
 */
function checkOwner(
  authorUserId: string
): { ok: true; userToken: string } | { ok: false; error: string } {
  const userToken = env.SLACK_USER_TOKEN;
  if (!(userToken && env.OWNER_USER_ID)) {
    return { error: 'Acting as the owner is not configured.', ok: false };
  }
  if (authorUserId !== env.OWNER_USER_ID) {
    return { error: 'Only the owner can act as themselves.', ok: false };
  }
  return { ok: true, userToken };
}

/**
 * Open (or find) the owner's own DM with a user, using the owner's token — so
 * the message lands in the owner↔user IM, not the app's bot DM.
 */
async function openOwnerDm(
  userToken: string,
  userId: string
): Promise<{ channelId: string } | { error: string }> {
  const response = await fetch('https://slack.com/api/conversations.open', {
    body: JSON.stringify({ users: userId }),
    headers: {
      Authorization: `Bearer ${userToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    method: 'POST',
  });
  const result = openDmSchema.parse(await response.json());
  if (!(result.ok && result.channel?.id)) {
    return { error: `Could not open a DM with <@${userId}>: ${result.error}` };
  }
  return { channelId: result.channel.id };
}

/**
 * Post AS the owner using their personal user token. Shared by the confirm
 * handler — sendAsUser never fires inline; every "speak as the owner" waits for
 * the owner's confirm click first (a prompt injection can ask, not press).
 */
export async function executeSendAsUser({
  targetChannel,
  targetUser,
  text,
  blocks,
  threadTs,
  crossChannel,
}: {
  targetChannel?: string;
  targetUser?: string;
  text: string;
  blocks?: unknown[];
  threadTs?: string;
  crossChannel: boolean;
}): Promise<{ success: boolean; summary?: string; error?: string }> {
  const gate = checkOwner(env.OWNER_USER_ID ?? '');
  if (!gate.ok) {
    return { error: gate.error, success: false };
  }
  let channel = targetChannel;
  if (targetUser) {
    const dm = await openOwnerDm(gate.userToken, targetUser);
    if ('error' in dm) {
      return { error: dm.error, success: false };
    }
    channel = dm.channelId;
  }
  if (!channel) {
    return { error: 'No target channel or user to send to.', success: false };
  }
  const response = await fetch('https://slack.com/api/chat.postMessage', {
    body: JSON.stringify({
      channel,
      text,
      ...(blocks ? { blocks } : {}),
      ...(!crossChannel && threadTs && { thread_ts: threadTs }),
    }),
    headers: {
      Authorization: `Bearer ${gate.userToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    method: 'POST',
  });
  const result = postMessageSchema.parse(await response.json());
  if (!result.ok) {
    return {
      error: `Failed to send as owner: ${result.error}`,
      success: false,
    };
  }
  if (crossChannel) {
    logger.info(
      { targetChannel: channel, targetUser },
      '[sendAsUser] posted as owner outside the current channel'
    );
  }
  if (targetUser) {
    return {
      success: true,
      summary: `Sent the DM as the owner to <@${targetUser}>.`,
    };
  }
  return {
    success: true,
    summary: crossChannel
      ? `Sent the message as the owner to <#${channel}>.`
      : 'Sent the message as the owner.',
  };
}

/** Edit one of the owner's own messages. Shared by the confirm handler. */
export async function executeEditAsUser({
  targetChannel,
  messageTs,
  text,
  blocks,
}: {
  targetChannel: string;
  messageTs: string;
  text: string;
  blocks?: unknown[];
}): Promise<{ success: boolean; summary?: string; error?: string }> {
  const gate = checkOwner(env.OWNER_USER_ID ?? '');
  if (!gate.ok) {
    return { error: gate.error, success: false };
  }
  const response = await fetch('https://slack.com/api/chat.update', {
    body: JSON.stringify({
      channel: targetChannel,
      text,
      ts: messageTs,
      ...(blocks ? { blocks } : {}),
    }),
    headers: {
      Authorization: `Bearer ${gate.userToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    method: 'POST',
  });
  const result = postMessageSchema.parse(await response.json());
  if (!result.ok) {
    return {
      error: `Failed to edit the owner's message: ${result.error}`,
      success: false,
    };
  }
  return { success: true, summary: "Edited the owner's message." };
}

/**
 * Send a message AS the owner. Owner-gated, and never inline: it stages the
 * post and shows the owner a confirm button. The message only goes out — under
 * the owner's own name — once they click Confirm.
 */
export function sendAsUserTool({
  authorUserId,
  extendAttemptDeadline,
  thread,
}: {
  authorUserId: string;
  extendAttemptDeadline?: (extraMs: number) => void;
  thread: Thread;
}) {
  return tool({
    description:
      'Send a message AS the owner (under their own name), not as the bot. Defaults to the current thread. Pass channelId to post a top-level message in a different channel, or userId to send a DM from the owner to that person. Pass `blocks` to send Block Kit from the owner (the text becomes the notification fallback). Only available when the owner triggered this turn. The owner must confirm via a button before it sends.',
    inputSchema: z.object({
      text: z
        .string()
        .min(1)
        .max(4000)
        .describe(
          'The message to post as the owner. With `blocks`, the notification fallback text.'
        ),
      channelId: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Target Slack channel id (e.g. C0123ABC) to post into as a top-level message. Defaults to the current thread.'
        ),
      userId: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Target Slack user id (e.g. U0123ABC) to DM from the owner's account. Mutually exclusive with channelId."
        ),
      blocks: z
        .string()
        .optional()
        .describe(
          'Optional Block Kit payload: a JSON array of up to 50 blocks. Replaces the plain text body; `text` is still sent as the notification fallback.'
        ),
    }),
    execute: async (
      { text, channelId, userId, blocks: rawBlocks },
      { abortSignal }
    ) => {
      try {
        const gate = checkOwner(authorUserId);
        if (!gate.ok) {
          return { error: gate.error, success: false };
        }
        if (channelId && userId) {
          return {
            error: 'Pass channelId OR userId, not both.',
            success: false,
          };
        }
        const [platform, currentChannelId, threadTs] = thread.id.split(':');
        if (platform !== 'slack' || !currentChannelId) {
          return {
            error: 'Could not resolve a Slack channel for this thread.',
            success: false,
          };
        }
        // Validate the target SHAPE before it can be queued and confirmed. A
        // timestamp mis-supplied as `channelId` (or a display name as `userId`)
        // otherwise sails through the gate and only fails deep in the Web API as
        // `channel_not_found` — sometimes after the owner already clicked Confirm.
        // postMessage guards this at its entry; sendAsUser/editAsUser did not.
        let resolvedChannel: string | undefined;
        if (channelId) {
          const raw = normalizeSlackChannelArg(channelId);
          if (!raw) {
            return {
              error: `"${channelId}" is not a Slack channel id — it looks like a message timestamp. Pass a channel id (C…/G…/D…) or an <#channel> mention.`,
              success: false,
            };
          }
          resolvedChannel = raw;
        }
        let resolvedUser: string | undefined;
        if (userId) {
          const raw = toRawSlackUserId(userId);
          if (!raw) {
            return {
              error: `"${userId}" is not a Slack user id, so it can't be a DM target. Pass a user id (U…/W… or an <@mention>).`,
              success: false,
            };
          }
          resolvedUser = raw;
        }
        let blocks: unknown[] | undefined;
        if (rawBlocks) {
          const parsed = parseBlocks(rawBlocks);
          if (parsed.error) {
            return { error: parsed.error, success: false };
          }
          blocks = parsed.blocks;
        }
        const crossChannel = Boolean(
          resolvedUser ||
            (resolvedChannel && resolvedChannel !== currentChannelId)
        );
        // Same broadcast rule as postMessage: a send that leaves the current
        // channel never carries an @channel/@here ping, owner included.
        // Un-annotate mentions so a person named in the message is really
        // pinged (see restoreAnnotatedMentions); the broadcast strip still runs
        // after it on a cross-channel send.
        const restored = restoreAnnotatedMentions(text);
        const body = crossChannel ? neutralizeBroadcast(restored) : restored;
        const safeBlocks =
          crossChannel && blocks ? neutralizeBroadcastDeep(blocks) : blocks;
        const targetChannel = resolvedUser
          ? undefined
          : (resolvedChannel ?? currentChannelId);
        let summary = 'send as YOU in this thread';
        if (resolvedUser) {
          summary = `send as YOU in a DM to <@${resolvedUser}>`;
        } else if (crossChannel && targetChannel) {
          summary = `send as YOU to <#${targetChannel}>`;
        }
        return await requestPostConfirmation({
          abortSignal,
          extendAttemptDeadline,
          approverUserId: authorUserId,
          post: {
            blocks: safeBlocks,
            crossChannel,
            kind: 'sendAsUser',
            requestedBy: authorUserId,
            summary: blocks ? `${summary} (Block Kit)` : summary,
            targetChannel,
            targetUser: resolvedUser,
            text: body,
            threadTs,
          },
          thread,
        });
      } catch (error) {
        logger.warn({ error: errorMessage(error) }, '[sendAsUser] failed');
        return { error: errorMessage(error), success: false };
      }
    },
  });
}

/**
 * Edit a message previously sent AS the owner. Owner-gated, and confirmed via a
 * button like sendAsUser — editing under the owner's name is just as
 * outward-facing as posting under it.
 */
export function editAsUserTool({
  authorUserId,
  extendAttemptDeadline,
  thread,
}: {
  authorUserId: string;
  extendAttemptDeadline?: (extraMs: number) => void;
  thread: Thread;
}) {
  return tool({
    description:
      "Edit one of the owner's own messages (under their own name). Defaults to the current channel; pass channelId to edit a message in another channel. Pass `blocks` to replace the message with Block Kit. Only available when the owner triggered this turn. The owner must confirm via a button before the edit applies.",
    inputSchema: z.object({
      messageTs: z
        .string()
        .min(1)
        .describe(
          'Timestamp (ts) of the owner message to edit, e.g. 1781599802.270109.'
        ),
      text: z
        .string()
        .min(1)
        .max(4000)
        .describe('The new message text to replace the existing content with.'),
      channelId: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Slack channel id (e.g. C0123ABC) the message lives in. Defaults to the current channel.'
        ),
      blocks: z
        .string()
        .optional()
        .describe(
          'Optional Block Kit payload: a JSON array of up to 50 blocks to replace the message content with; `text` becomes the notification fallback.'
        ),
    }),
    execute: async (
      { messageTs, text, channelId, blocks: rawBlocks },
      { abortSignal }
    ) => {
      try {
        const gate = checkOwner(authorUserId);
        if (!gate.ok) {
          return { error: gate.error, success: false };
        }
        const [platform, currentChannelId] = thread.id.split(':');
        if (platform !== 'slack' || !currentChannelId) {
          return {
            error: 'Could not resolve a Slack channel for this thread.',
            success: false,
          };
        }
        let blocks: unknown[] | undefined;
        if (rawBlocks) {
          const parsed = parseBlocks(rawBlocks);
          if (parsed.error) {
            return { error: parsed.error, success: false };
          }
          blocks = parsed.blocks;
        }
        // Same shape guard as sendAsUser: reject a timestamp-as-channel before
        // it becomes a dead confirm that fails as channel_not_found on click.
        let resolvedChannel: string | undefined;
        if (channelId) {
          const raw = normalizeSlackChannelArg(channelId);
          if (!raw) {
            return {
              error: `"${channelId}" is not a Slack channel id — it looks like a message timestamp. Pass a channel id (C…/G…/D…) or an <#channel> mention.`,
              success: false,
            };
          }
          resolvedChannel = raw;
        }
        const targetChannel = resolvedChannel ?? currentChannelId;
        return await requestPostConfirmation({
          abortSignal,
          extendAttemptDeadline,
          approverUserId: authorUserId,
          post: {
            blocks,
            kind: 'editAsUser',
            messageTs,
            requestedBy: authorUserId,
            summary: `edit YOUR message in <#${targetChannel}>`,
            targetChannel,
            text,
          },
          thread,
        });
      } catch (error) {
        logger.warn({ error: errorMessage(error) }, '[editAsUser] failed');
        return { error: errorMessage(error), success: false };
      }
    },
  });
}
