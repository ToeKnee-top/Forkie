import {
  type Message,
  mrkdwnToMarkdown,
  type ThreadHandle as Thread,
} from '@/harness';
import { compactOverflow } from '@/lib/agent/compaction';
import { isFocusAllowed } from '@/lib/agent/focus';
import { annotateMentions } from '@/lib/agent/mentions';
import { recallThinking, renderThinking } from '@/lib/agent/thinking';
import { slack } from '@/lib/chat';
import { isHiddenFromBot, rawSlackText } from '@/lib/utils/message';

// We never persist a session, so the whole Slack thread is the agent's only
// memory. Cap how many prior messages we replay VERBATIM to bound prompt size.
const MAX_THREAD_MESSAGES = 100;
// How far back we look beyond that cap. Everything between this and the verbatim
// window is compacted into a summary (see lib/agent/compaction) instead of being
// dropped on the floor, which is what used to happen: the model was handed the
// tail of a conversation with no indication it had a beginning, and cheerfully
// contradicted decisions made earlier in the same thread.
//
// Bounded, not unlimited: `fetchMessages` pages until this many are in hand, so
// a bigger number is real Slack API work on every turn. 4x the replay window
// covers any thread anyone has actually held with kyto; past it the very oldest
// messages are still lost, and the block's count says how many were kept.
const MAX_COMPACTION_MESSAGES = 400;
// The bot's Slack username is a leftover gorkie-era handle; label its own
// authored messages as kyto so it doesn't think "gorkie" spoke (mirrors the
// same special-case in annotateMentions).
const BOT_NAME = 'kyto';

function authorLabel(message: Message): string {
  if (slack.botUserId && message.author.userId === slack.botUserId) {
    return BOT_NAME;
  }
  return message.author.userName;
}

async function renderMessage(message: Message): Promise<string> {
  const slackText = rawSlackText(message);
  const text = slackText
    ? mrkdwnToMarkdown(await annotateMentions(slackText))
    : message.text;
  return `@${authorLabel(message)} (${message.author.userId}): ${text}`;
}

export async function buildPrompt(
  message: Message,
  {
    customizationPrompt,
    thread,
  }: {
    customizationPrompt?: string;
    thread?: Thread;
  } = {}
): Promise<string> {
  const current = await renderMessage(message);

  // What kyto was THINKING on this thread's last few turns. Slack replayed above
  // only records what it said, so without this each turn re-derives the reasoning
  // (and the dead ends) of the one before it.
  const thinking = thread
    ? renderThinking(await recallThinking(thread.id))
    : '';

  let history = '';
  let compacted = '';
  if (thread) {
    // Focus mode: drop messages from non-focused users so kyto genuinely never
    // sees what other people said in a focused thread (not just declines to
    // reply). Its own messages and the owner's are always kept.
    const focusState = await thread.state.catch(() => null);
    const fetched = await slack
      .fetchMessages(thread.id, { limit: MAX_COMPACTION_MESSAGES })
      .catch(() => undefined);
    const prior = (fetched?.messages ?? []).filter(
      (entry): entry is Message =>
        entry.id !== message.id &&
        !isHiddenFromBot(entry) &&
        isFocusAllowed(focusState, entry.author.userId, {
          isMe: entry.author.isMe === true,
        })
    );
    // Split AFTER filtering, so a focused thread's window is 100 messages kyto
    // may actually see rather than 100 slots partly spent on hidden ones.
    const replayed = prior.slice(-MAX_THREAD_MESSAGES);
    const overflow = prior.slice(
      0,
      Math.max(prior.length - replayed.length, 0)
    );
    if (overflow.length > 0) {
      const rendered = await Promise.all(
        overflow.map(async (entry) => ({
          id: entry.id,
          rendered: await renderMessage(entry),
        }))
      );
      compacted = await compactOverflow({
        overflow: rendered,
        threadId: thread.id,
      });
    }
    if (replayed.length > 0) {
      const rendered = await Promise.all(replayed.map(renderMessage));
      history = [
        'Conversation so far in this Slack thread (oldest first):',
        ...rendered,
      ].join('\n');
    }
  }

  // The label that introduces the new message. Kept with `current` rather than
  // appended to `history`, because the thinking block now sits BETWEEN them —
  // and a "the latest message is next" line followed by a page of last turn's
  // reasoning reads as if the reasoning were the message.
  const latest = history
    ? `The latest message, which you must respond to:\n${current}`
    : current;

  // ORDER IS LOAD-BEARING, for prompt caching (see addCacheControl in
  // packages/ai/src/agent.ts — the breakpoint lands on the last user message,
  // which is this whole string).
  //
  // Cheapest → most volatile, so the cacheable prefix is as long as possible:
  //
  //   user_instructions   changes only when the user edits them
  //   compacted           changes once per COMPACT_BATCH of overflow
  //   history             append-only until the thread passes MAX_THREAD_MESSAGES
  //   thinking            CHANGES EVERY TURN (last turn's reasoning is appended)
  //   current             the new message
  //
  // The thinking block used to come FIRST. It is up to THINKING_BUDGET_CHARS of
  // text that is different on every single turn, so putting it at the front
  // invalidated the cached prefix at byte ~0 and the entire replayed thread was
  // re-billed at full price every turn — on a $3/day shared cap. Moving it below
  // the history costs nothing (the model reads the whole prompt either way) and
  // makes system + instructions + history a stable prefix that actually caches.
  //
  // Do NOT move a volatile block back above `history`.
  const body = [
    customizationPrompt
      ? [
          '<user_instructions>',
          customizationPrompt,
          '</user_instructions>',
        ].join('\n')
      : '',
    compacted,
    history,
    thinking,
    latest,
  ]
    .filter(Boolean)
    .join('\n\n');

  return body;
}
