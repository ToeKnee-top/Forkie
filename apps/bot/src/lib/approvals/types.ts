/**
 * The actions that can be held for the owner's approval.
 *
 * Deliberately a CLOSED set. The executor (lib/approvals/execute) switches on
 * this, and the payload it reads was written by a model — so anything not
 * listed here simply cannot be made to run, no matter what a request row says.
 *
 * `sendAsUser` / `editAsUser` are NOT here and must never be added. Posting as
 * the owner has no approval path at all: only the owner can ask for it, and it
 * still goes through the synchronous confirm-post click. An approval queue that
 * could speak as a person is a different and much worse thing than one that can
 * post as a bot.
 */
export type ApprovalKind = 'post' | 'broadcast' | 'github';

export const APPROVAL_KINDS: readonly ApprovalKind[] = [
  'post',
  'broadcast',
  'github',
];

export function isApprovalKind(value: string): value is ApprovalKind {
  return (APPROVAL_KINDS as readonly string[]).includes(value);
}

/** A post held for approval: the same shape `executePostMessage` takes. */
export interface PostApprovalPayload {
  /** Whether the approved post may carry a real @channel/@here ping. */
  allowBroadcast?: boolean;
  blocks?: unknown[];
  body: string;
  targetId: string;
  targetType: 'thread' | 'channel' | 'user';
}

/** A GitHub write held for approval. Approving grants trust; see execute.ts. */
export interface GithubApprovalPayload {
  command: string;
  repo: string;
}
