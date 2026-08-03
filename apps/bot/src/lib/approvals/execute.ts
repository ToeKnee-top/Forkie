import type { ApprovalRequest } from '@repo/db/queries';
import { grantGithubTrust } from '@repo/db/queries';
import { executePostMessage } from '@/lib/ai/tools/post-message';
import { bot } from '@/lib/chat';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';
import type { GithubApprovalPayload, PostApprovalPayload } from './types';
import { isApprovalKind } from './types';

/**
 * Perform an approved action.
 *
 * Everything it acts on comes out of `row`, which was written when the request
 * was made — never from the click. The clicker only ever chooses approve or
 * deny; they cannot redirect a request at a different channel, and neither can
 * a later prompt injection in the same thread.
 *
 * `kind` is re-validated against the closed set even though the row came from
 * our own table: a row is the one part of this that a model's input reached.
 */
export async function executeApproval(
  row: ApprovalRequest
): Promise<{ ok: boolean; detail: string }> {
  if (!isApprovalKind(row.kind)) {
    logger.error(
      { approvalId: row.id, kind: row.kind },
      '[approvals] refusing to run an unknown approval kind'
    );
    return { detail: `Unknown request kind "${row.kind}".`, ok: false };
  }
  try {
    if (row.kind === 'post' || row.kind === 'broadcast') {
      return await executePostApproval(row);
    }
    return await executeGithubApproval(row);
  } catch (error) {
    logger.warn(
      { approvalId: row.id, err: errorMessage(error), kind: row.kind },
      '[approvals] approved action failed'
    );
    return { detail: errorMessage(error), ok: false };
  }
}

async function executePostApproval(
  row: ApprovalRequest
): Promise<{ ok: boolean; detail: string }> {
  const payload = row.payload as unknown as PostApprovalPayload;
  if (!(payload?.body && payload.targetId && payload.targetType)) {
    return { detail: 'That request is missing its message.', ok: false };
  }
  await executePostMessage(bot, {
    // A broadcast request is the ONLY way a non-owner's @channel goes out, and
    // it goes out because the owner pressed a button naming that exact message.
    allowBroadcast: row.kind === 'broadcast',
    blocks: payload.blocks,
    body: payload.body,
    target: { id: payload.targetId, type: payload.targetType },
  });
  return { detail: `Sent — ${row.summary}.`, ok: true };
}

/**
 * Approving a GitHub request GRANTS THE TRUST and stops there. It does NOT
 * re-run the command.
 *
 * That command was composed by a model in a thread that has since moved on;
 * running it blind, possibly hours later, turns an approval click into an
 * action nobody reviewed in its current context. The person asks kyto again and
 * it now succeeds. Same rule the dashboard already follows.
 */
async function executeGithubApproval(
  row: ApprovalRequest
): Promise<{ ok: boolean; detail: string }> {
  const payload = row.payload as unknown as GithubApprovalPayload;
  if (!payload?.repo) {
    return { detail: 'That request is missing its repo.', ok: false };
  }
  await grantGithubTrust({
    grantedBy: row.decidedBy ?? 'approval',
    repo: payload.repo,
    userId: row.requestedBy,
  });
  return {
    detail: `<@${row.requestedBy}> can now have me write to \`${payload.repo}\`. I did NOT re-run the command — ask me again and it will work.`,
    ok: true,
  };
}
