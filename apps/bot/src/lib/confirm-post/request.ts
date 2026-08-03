import type { ThreadHandle } from '@/harness';
import { mrkdwn, plainText } from '@/harness/views';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { toLogError } from '@/lib/utils/error';
import {
  CONFIRM_WAIT_MS,
  type ConfirmOutcome,
  discardPendingPost,
  type PendingPost,
  stashPendingPost,
} from './pending';

/** What the tool hands back once the approver has (or hasn't) acted. */
export type ConfirmResult =
  | { success: true; summary: string }
  | { success: false; denied?: boolean; error?: string; summary?: string };

export const CONFIRM_SEND_ACTION = 'confirm_post_send';
export const CONFIRM_CANCEL_ACTION = 'confirm_post_cancel';

// Slack truncates the preview if it's enormous; keep it readable.
const PREVIEW_MAX = 500;

function preview(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > PREVIEW_MAX
    ? `${trimmed.slice(0, PREVIEW_MAX)}…`
    : trimmed;
}

function confirmBlocks(id: string, post: PendingPost): unknown[] {
  const bodyPreview = post.kind === 'postMessage' ? post.body : post.text;
  // A person asked to lend their face gets a different headline: they are not
  // approving kyto's outbound post in general, they are deciding whether a
  // message may go out under their name and picture.
  const heading =
    post.kind === 'postMessage' && post.identity && post.approverUserId
      ? ':bust_in_silhouette: *This would go out as YOU — is that ok?*'
      : ':lock: *Confirm before I send this*';
  return [
    {
      type: 'section',
      text: mrkdwn(`${heading}\n${post.summary}`),
    },
    ...(bodyPreview.trim()
      ? [
          {
            type: 'section',
            text: mrkdwn(`>>> ${preview(bodyPreview)}`),
          },
        ]
      : []),
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: CONFIRM_SEND_ACTION,
          style: 'primary',
          text: plainText('Confirm & send'),
          value: id,
        },
        {
          type: 'button',
          action_id: CONFIRM_CANCEL_ACTION,
          style: 'danger',
          text: plainText('Cancel'),
          value: id,
        },
      ],
    },
  ];
}

function outcomeToResult(
  outcome: ConfirmOutcome | null,
  post: PendingPost,
  aborted: boolean
): ConfirmResult {
  if (outcome?.decision === 'confirmed') {
    return outcome.ok
      ? { success: true, summary: outcome.detail }
      : { error: outcome.detail, success: false };
  }
  // Named rather than "the owner": for an impersonated post the decision was
  // someone else's, and the model must not tell the thread the owner refused.
  const who =
    post.kind === 'postMessage' && post.approverUserId
      ? `<@${post.approverUserId}>`
      : 'the owner';
  if (outcome?.decision === 'denied') {
    return {
      denied: true,
      success: false,
      summary: `${who} denied this — I did NOT ${post.summary}. Do not retry it; acknowledge that they declined.`,
    };
  }
  return {
    success: false,
    summary: aborted
      ? `Interrupted before ${who} responded — I did NOT ${post.summary}.`
      : `${who} did not respond within ${Math.round(
          CONFIRM_WAIT_MS / 60_000
        )} minutes — I did NOT ${post.summary}. You can ask them again.`,
  };
}

/**
 * Hold an outward-facing post (cross-channel, as the owner, or wearing someone
 * else's face), show its APPROVER an ephemeral Confirm/Cancel button in the
 * current thread, and BLOCK until they choose (or the wait times out / the turn
 * aborts). Returns the real outcome so the model can say it sent it, that they
 * declined, or that nobody answered — never a premature "waiting…". Nothing is
 * sent here; the button handler performs the send and reports back through the
 * pending row.
 *
 * `approverUserId` is the owner for everything except an impersonated post, where
 * it is the person being impersonated. Whoever it is, it is stored on the row and
 * re-checked when the button is clicked.
 */
export async function requestPostConfirmation({
  abortSignal,
  approverUserId,
  extendAttemptDeadline,
  post,
  thread,
}: {
  abortSignal?: AbortSignal;
  approverUserId: string;
  extendAttemptDeadline?: (extraMs: number) => void;
  post: PendingPost;
  thread: ThreadHandle;
}): Promise<ConfirmResult> {
  const { id, wait } = stashPendingPost(post);
  const delivered = await thread.postEphemeral(
    approverUserId,
    `Confirm before I send: ${post.summary}`,
    { blocks: confirmBlocks(id, post), fallbackToDM: true }
  );
  // Remember a DM-delivered prompt so the button handler can EDIT it instead of
  // replying beside it. `replace_original` only works on a message Slack owns
  // through the interaction; on an ordinary DM it silently does nothing, so the
  // outcome arrived as a second message and the original stayed put with its
  // Confirm button still clickable.
  if (delivered.delivery === 'dm' && delivered.channel && delivered.ts) {
    rememberPromptMessage(id, {
      channel: delivered.channel,
      ts: delivered.ts,
    });
  }

  // Tell the attempt watchdog this deliberate pause isn't a stall (same as the
  // `wait` tool), so a slow decision doesn't get the turn killed mid-wait.
  extendAttemptDeadline?.(CONFIRM_WAIT_MS + 30_000);

  const outcome = await new Promise<ConfirmOutcome | null>((resolve) => {
    let done = false;
    const finish = (value: ConfirmOutcome | null) => {
      if (done) {
        return;
      }
      done = true;
      resolve(value);
    };
    const timer = setTimeout(() => {
      discardPendingPost(id);
      promptMessages.delete(id);
      finish(null);
    }, CONFIRM_WAIT_MS);
    const onAbort = () => {
      clearTimeout(timer);
      discardPendingPost(id);
      promptMessages.delete(id);
      finish(null);
    };
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    wait.then((value) => {
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', onAbort);
      finish(value);
    });
  });

  return outcomeToResult(outcome, post, Boolean(abortSignal?.aborted));
}

const interactionSchema = {
  container: { thread_ts: '' },
  response_url: '',
};

// Confirm prompts that were delivered as a real DM (the ephemeral fallback),
// keyed by pending-post id, so the outcome can edit that message rather than
// pile up beside it. Cleared when claimed; a leftover row is bounded by the
// pending post's own lifetime.
const promptMessages = new Map<string, { channel: string; ts: string }>();

function rememberPromptMessage(
  id: string,
  location: { channel: string; ts: string }
): void {
  promptMessages.set(id, location);
}

/**
 * Show the outcome in place of the confirm prompt.
 *
 * Two delivery shapes, two mechanisms: a true ephemeral is replaced through the
 * interaction's `response_url`, and a DM-fallback message is edited with
 * `chat.update`. Using `replace_original` on the latter is a no-op — which is
 * how a confirmed post ended up with the result posted BESIDE a prompt whose
 * buttons were still live.
 */
export async function respondToInteraction(
  raw: unknown,
  text: string,
  pendingId?: string
): Promise<void> {
  const dmPrompt = pendingId ? promptMessages.get(pendingId) : undefined;
  if (dmPrompt) {
    promptMessages.delete(pendingId as string);
    try {
      await slack.webClient.chat.update({
        blocks: [{ text: mrkdwn(text), type: 'section' }],
        channel: dmPrompt.channel,
        text,
        ts: dmPrompt.ts,
      });
      return;
    } catch (error) {
      logger.warn(
        toLogError(error),
        '[confirm-post] failed to update the DM prompt; falling back to response_url'
      );
    }
  }
  const payload = raw as Partial<typeof interactionSchema> | undefined;
  const responseUrl = payload?.response_url;
  if (!responseUrl) {
    return;
  }
  // The confirm prompt is a THREADED ephemeral (postEphemeral with thread_ts).
  // A response_url reply with replace_original but NO thread_ts can't anchor to
  // the threaded original: Slack swaps it for the viewing client AND drops a
  // second copy at the channel root — the duplicate ephemeral the owner saw.
  // The block_actions payload carries the thread on `container.thread_ts` (same
  // field bot.ts reads to route the interaction); carry it one more hop so the
  // replacement targets the threaded message unambiguously.
  const threadTs = payload?.container?.thread_ts;
  try {
    await fetch(responseUrl, {
      body: JSON.stringify({
        replace_original: true,
        text,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
  } catch (error) {
    logger.warn(toLogError(error), '[confirm-post] failed to update ephemeral');
  }
}
