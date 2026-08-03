import {
  type ApprovalRequest,
  decideApprovalRequest,
  setApprovalOutcome,
} from '@repo/db/queries';
import { env } from '@/env';
import type { ActionEvent } from '@/harness';
import { mrkdwn } from '@/harness/views';
import { executeApproval } from '@/lib/approvals/execute';
import { APPROVE_ACTION, DENY_ACTION } from '@/lib/approvals/request';
import { bot, slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { toLogError } from '@/lib/utils/error';

/**
 * Only the owner decides. The approval message is PUBLIC — everyone in the
 * thread can see the buttons — so this check is the entire gate, not a
 * convenience: without it, the person who asked could approve their own
 * request, which would make the whole thing decorative.
 */
function isOwner(event: ActionEvent): boolean {
  return Boolean(env.OWNER_USER_ID) && event.user.userId === env.OWNER_USER_ID;
}

async function replaceApprovalMessage(
  row: ApprovalRequest,
  text: string
): Promise<void> {
  if (!(row.messageChannel && row.messageTs)) {
    return;
  }
  await slack.webClient.chat
    .update({
      blocks: [{ text: mrkdwn(text), type: 'section' }],
      channel: row.messageChannel,
      text,
      ts: row.messageTs,
    })
    .catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), approvalId: row.id },
        '[approvals] failed to update the approval message'
      );
    });
}

/** Tell the thread what happened, so the asker learns the outcome in place. */
async function announce(row: ApprovalRequest, text: string): Promise<void> {
  await bot
    .thread(row.threadId)
    .post({ markdown: text })
    .catch(() => undefined);
}

bot.onAction(APPROVE_ACTION, async (event) => {
  if (!isOwner(event)) {
    await event.thread
      ?.postEphemeral(event.user, 'Only the owner can approve this.')
      .catch(() => undefined);
    return;
  }
  const id = Number(event.value);
  if (!Number.isFinite(id)) {
    return;
  }
  // The claim: `decideApprovalRequest` only matches a row that is still
  // pending, so a double-click cannot send the same message twice.
  const row = await decideApprovalRequest({
    decidedBy: event.user.userId,
    id,
    status: 'approved',
  });
  if (!row) {
    await event.thread
      ?.postEphemeral(event.user, 'That request was already decided.')
      .catch(() => undefined);
    return;
  }
  const result = await executeApproval(row);
  await setApprovalOutcome({ id: row.id, outcome: result.detail }).catch(
    () => undefined
  );
  logger.info(
    { approvalId: row.id, kind: row.kind, ok: result.ok },
    '[approvals] owner approved'
  );
  const text = result.ok
    ? `:white_check_mark: Approved — ${result.detail}`
    : `:x: Approved, but it failed: ${result.detail}`;
  await replaceApprovalMessage(row, text);
  await announce(row, `<@${row.requestedBy}> ${text}`);
});

bot.onAction(DENY_ACTION, async (event) => {
  if (!isOwner(event)) {
    await event.thread
      ?.postEphemeral(event.user, 'Only the owner can decide this.')
      .catch(() => undefined);
    return;
  }
  const id = Number(event.value);
  if (!Number.isFinite(id)) {
    return;
  }
  const row = await decideApprovalRequest({
    decidedBy: event.user.userId,
    id,
    status: 'denied',
  });
  if (!row) {
    return;
  }
  logger.info(
    { approvalId: row.id, kind: row.kind },
    '[approvals] owner denied'
  );
  const text = `:heavy_multiplication_x: Denied — I will not ${row.summary}.`;
  await replaceApprovalMessage(row, text);
  await announce(row, `<@${row.requestedBy}> ${text}`);
});
