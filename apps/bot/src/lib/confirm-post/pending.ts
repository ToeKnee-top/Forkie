import { randomUUID } from 'node:crypto';
import type { ResolvedIdentity } from '@/lib/identity';

// A post that is about to go out but is waiting for a human to physically click
// "Confirm & send" or "Cancel" in an ephemeral message. Cross-channel posts, any
// post/edit made AS the owner, and any post wearing a real person's face are held
// here rather than executed inline, so a prompt injection can get as far as
// *asking* for the post but never actually send it — only a human click can. The
// requesting tool call BLOCKS on `wait` until that click (or it times out), so the
// model learns the real outcome instead of guessing. The store is in-memory and
// short-lived (the same philosophy as the rest of harness/kv.ts): a confirmation
// that does not survive a restart just times out, and the asker re-asks.
//
// WHICH human is fixed here, when the request is MADE, and re-checked at click
// time (`approverUserId`) — never taken from whoever clicked. Normally the owner;
// for a post wearing someone's name and picture it is THAT PERSON, since consent
// to be impersonated is theirs to give (owner's call, 2026-07-30).

export type PendingPost =
  | {
      kind: 'postMessage';
      requestedBy: string;
      /** Whose click sends this. Defaults to the owner; see the note above. */
      approverUserId?: string;
      target: { type: 'thread' | 'channel' | 'user'; id: string };
      body: string;
      blocks?: unknown[];
      // Per-post identity override (custom name/icon, or a mirrored person/bot).
      // Carried through the confirm gate so the sent post wears the same face the
      // approver saw described in the confirmation.
      identity?: ResolvedIdentity;
      summary: string;
    }
  | {
      kind: 'sendAsUser';
      requestedBy: string;
      // Either a channel to post into, or a user to DM as the owner. When
      // targetUser is set, the IM channel is opened at send time with the
      // owner's token — the confirm preview names the person, not a raw D-id.
      targetChannel?: string;
      targetUser?: string;
      text: string;
      blocks?: unknown[];
      threadTs?: string;
      crossChannel: boolean;
      summary: string;
    }
  | {
      kind: 'editAsUser';
      requestedBy: string;
      targetChannel: string;
      messageTs: string;
      text: string;
      blocks?: unknown[];
      summary: string;
    };

/** How the approver resolved a pending post. `null` = timed out / aborted. */
export type ConfirmOutcome =
  | { decision: 'confirmed'; ok: boolean; detail: string }
  | { decision: 'denied' };

// The wait window the tool blocks for, and the row's TTL, are the same: past it
// the confirmation is gone and a late click finds nothing.
export const CONFIRM_WAIT_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 500;

interface Entry {
  expiresAt: number;
  post: PendingPost;
  settle: (outcome: ConfirmOutcome | null) => void;
}

const pending = new Map<string, Entry>();

function sweep(): void {
  const now = Date.now();
  for (const [id, entry] of pending) {
    if (entry.expiresAt <= now) {
      pending.delete(id);
      entry.settle(null);
    }
  }
}

/**
 * Register a pending post. Returns the id to embed in the buttons and a `wait`
 * promise that resolves when the approver clicks (`ConfirmOutcome`) or when the
 * post is discarded on timeout/abort (`null`).
 */
export function stashPendingPost(post: PendingPost): {
  id: string;
  wait: Promise<ConfirmOutcome | null>;
} {
  sweep();
  if (pending.size >= MAX_ENTRIES) {
    const oldest = pending.keys().next().value;
    if (oldest) {
      const entry = pending.get(oldest);
      pending.delete(oldest);
      entry?.settle(null);
    }
  }
  let settle: (outcome: ConfirmOutcome | null) => void = () => {
    // replaced synchronously below; the noop guards the type only.
  };
  const wait = new Promise<ConfirmOutcome | null>((resolve) => {
    settle = resolve;
  });
  const id = randomUUID();
  pending.set(id, { expiresAt: Date.now() + CONFIRM_WAIT_MS, post, settle });
  return { id, wait };
}

/**
 * Read a pending post WITHOUT claiming it, so a click can be checked against the
 * row's approver before it consumes the row — a stranger pressing the button must
 * not burn the confirmation the real approver still has to answer. Returns null
 * for an unknown or expired id (left for `takePendingPost` to settle).
 */
export function peekPendingPost(id: string): PendingPost | null {
  const entry = pending.get(id);
  if (!entry || entry.expiresAt <= Date.now()) {
    return null;
  }
  return entry.post;
}

/**
 * Claim a pending post for processing (a button click). Removing it here means
 * a second click, or a click racing the timeout, finds nothing and is a no-op.
 * The caller MUST call the returned `settle` to unblock the waiting tool.
 */
export function takePendingPost(
  id: string
): { post: PendingPost; settle: (outcome: ConfirmOutcome) => void } | null {
  const entry = pending.get(id);
  if (!entry) {
    return null;
  }
  pending.delete(id);
  if (entry.expiresAt <= Date.now()) {
    entry.settle(null);
    return null;
  }
  return { post: entry.post, settle: entry.settle };
}

/** The tool gives up (timeout/abort): drop the row and unblock with `null`. */
export function discardPendingPost(id: string): void {
  const entry = pending.get(id);
  if (!entry) {
    return;
  }
  pending.delete(id);
  entry.settle(null);
}
