import { env } from '@/env';
import type { ActionEvent } from '@/harness';
import { executePostMessage } from '@/lib/ai/tools/post-message';
import {
  executeEditAsUser,
  executeSendAsUser,
} from '@/lib/ai/tools/send-as-user';
import { bot } from '@/lib/chat';
import {
  type PendingPost,
  peekPendingPost,
  takePendingPost,
} from '@/lib/confirm-post/pending';
import {
  CONFIRM_CANCEL_ACTION,
  CONFIRM_SEND_ACTION,
  respondToInteraction,
} from '@/lib/confirm-post/request';
import logger from '@/lib/logger';
import { errorMessage, toLogError } from '@/lib/utils/error';

// Who this row's buttons belong to: the person named on it when the request was
// MADE (an impersonated post asks the person being impersonated), else the owner.
// Taken from the row, never from the click.
function approverOf(post: PendingPost): string | undefined {
  const designated =
    post.kind === 'postMessage' ? post.approverUserId : undefined;
  return designated ?? env.OWNER_USER_ID;
}

// The ephemeral is only shown to that person, but a crafted interaction payload
// could still target the action id, so re-check the clicker here — this button is
// the last line of defense against a prompt injection driving an outward-facing
// post.
function mayDecide(event: ActionEvent, post: PendingPost): boolean {
  const approver = approverOf(post);
  return Boolean(approver) && event.user.userId === approver;
}

const NOT_YOURS = 'This confirmation is not yours to decide.';
const GONE = 'That confirmation expired or was already used.';

/**
 * The clicker's right to decide is checked BEFORE the row is claimed: claiming
 * first would let a stranger's click consume a confirmation the real approver
 * still has to answer (they would find nothing left to press). Double-click
 * protection is unaffected — that comes from `takePendingPost` deleting the row.
 */
function claimIfAllowed(event: ActionEvent) {
  const id = event.value;
  if (!id) {
    return { error: GONE } as const;
  }
  const peeked = peekPendingPost(id);
  if (!peeked) {
    return { error: GONE } as const;
  }
  if (!mayDecide(event, peeked)) {
    return { error: NOT_YOURS } as const;
  }
  const claimed = takePendingPost(id);
  return claimed ? ({ claimed } as const) : ({ error: GONE } as const);
}

bot.onAction(CONFIRM_SEND_ACTION, async (event) => {
  const outcome = claimIfAllowed(event);
  if (outcome.error) {
    await respondToInteraction(event.raw, outcome.error);
    return;
  }
  const { post, settle } = outcome.claimed;
  try {
    let result: { success: boolean; summary?: string; error?: string };
    if (post.kind === 'postMessage') {
      await executePostMessage(bot, {
        blocks: post.blocks,
        body: post.body,
        identity: post.identity,
        target: post.target,
      });
      result = { success: true, summary: `Sent — ${post.summary}.` };
    } else if (post.kind === 'sendAsUser') {
      result = await executeSendAsUser(post);
    } else {
      result = await executeEditAsUser(post);
    }
    const detail = result.success
      ? (result.summary ?? 'Sent.')
      : (result.error ?? 'Send failed.');
    // Unblock the waiting tool with the real result, so the model reports the
    // truth (sent / failed) instead of a guess.
    settle({ decision: 'confirmed', detail, ok: result.success });
    logger.info(
      {
        impersonated:
          post.kind === 'postMessage' ? Boolean(post.approverUserId) : false,
        kind: post.kind,
        ok: result.success,
        userId: event.user.userId,
      },
      '[confirm-post] approver confirmed'
    );
    await respondToInteraction(
      event.raw,
      result.success ? `:white_check_mark: ${detail}` : `:x: ${detail}`,
      event.value
    );
  } catch (error) {
    const message = errorMessage(error);
    settle({ decision: 'confirmed', detail: message, ok: false });
    logger.warn(toLogError(error), '[confirm-post] send failed');
    await respondToInteraction(
      event.raw,
      `:x: Failed to send: ${message}`,
      event.value
    );
  }
});

bot.onAction(CONFIRM_CANCEL_ACTION, async (event) => {
  const outcome = claimIfAllowed(event);
  if (outcome.error) {
    await respondToInteraction(event.raw, outcome.error);
    return;
  }
  outcome.claimed.settle({ decision: 'denied' });
  await respondToInteraction(
    event.raw,
    ":heavy_multiplication_x: Cancelled — I won't send it.",
    event.value
  );
});
