import { and, desc, eq } from 'drizzle-orm';
import { db } from '../client';
import { type ApprovalRequest, approvalRequests } from '../schema';

export type { ApprovalRequest } from '../schema';

export async function createApprovalRequest({
  detail,
  kind,
  payload,
  requestedBy,
  summary,
  threadId,
}: {
  detail?: string;
  kind: string;
  payload: Record<string, unknown>;
  requestedBy: string;
  summary: string;
  threadId: string;
}): Promise<ApprovalRequest> {
  const [row] = await db
    .insert(approvalRequests)
    .values({
      detail: detail ?? null,
      kind,
      payload,
      requestedBy,
      summary,
      threadId,
    })
    .returning();
  if (!row) {
    throw new Error('Failed to record the approval request.');
  }
  return row;
}

export async function getApprovalRequest(
  id: number
): Promise<ApprovalRequest | null> {
  const [row] = await db
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.id, id))
    .limit(1);
  return row ?? null;
}

export async function listPendingApprovals(): Promise<ApprovalRequest[]> {
  return await db
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.status, 'pending'))
    .orderBy(desc(approvalRequests.createdAt));
}

/** Remember where the approval message landed, so it can be edited in place. */
export async function setApprovalMessage({
  channel,
  id,
  ts,
}: {
  channel: string;
  id: number;
  ts: string;
}): Promise<void> {
  await db
    .update(approvalRequests)
    .set({ messageChannel: channel, messageTs: ts })
    .where(eq(approvalRequests.id, id));
}

/**
 * Claim a pending request for a decision.
 *
 * The `status = 'pending'` predicate is the CLAIM: two clicks that land at the
 * same moment both try to update the same row, and only the first matches. The
 * second gets nothing back and its handler stops — without it, a double-click
 * would run the action twice, which for a post means sending it twice.
 */
export async function decideApprovalRequest({
  decidedBy,
  id,
  status,
}: {
  decidedBy: string;
  id: number;
  status: 'approved' | 'denied';
}): Promise<ApprovalRequest | null> {
  const [row] = await db
    .update(approvalRequests)
    .set({ decidedAt: new Date(), decidedBy, status })
    .where(
      and(eq(approvalRequests.id, id), eq(approvalRequests.status, 'pending'))
    )
    .returning();
  return row ?? null;
}

/** Record what happened when an approved action ran. */
export async function setApprovalOutcome({
  id,
  outcome,
}: {
  id: number;
  outcome: string;
}): Promise<void> {
  await db
    .update(approvalRequests)
    .set({ outcome })
    .where(eq(approvalRequests.id, id));
}
