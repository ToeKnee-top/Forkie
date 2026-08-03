import { z } from 'zod';
import type { ActionEvent } from '@/harness';
import { plainText } from '@/harness/views';
import { settleAnswers } from '@/lib/ask-question/pending';
import {
  ASK_OPTION_ACTIONS,
  ASK_OTHER_ACTION,
  ASK_OTHER_BLOCK,
  ASK_OTHER_INPUT,
  ASK_OTHER_MODAL,
  ASK_SUBMIT_ACTION,
  type AskState,
  buildAskBlocks,
  buildAskMetadata,
  isComplete,
  parseAskStateFromRaw,
} from '@/lib/ask-question/state';
import { bot, slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { toLogError } from '@/lib/utils/error';

/**
 * The gate: only the people the question was ADDRESSED to may answer it.
 *
 * The message is public — everyone in the thread can see the buttons — so
 * without this the tool would be a poll, not a question. Someone who wasn't
 * asked gets told so, ephemerally, rather than being ignored (a button that
 * appears to do nothing reads as a bug).
 */
async function refuseOutsider(event: ActionEvent): Promise<void> {
  await event.thread
    ?.postEphemeral(
      event.user,
      "This question wasn't addressed to you, so your answer isn't counted."
    )
    .catch(() => undefined);
}

async function updateAskMessage(
  event: ActionEvent,
  state: AskState
): Promise<void> {
  const channelId = event.threadId.split(':').at(1);
  if (!(channelId && event.messageId)) {
    return;
  }
  await slack.webClient
    .apiCall('chat.update', {
      blocks: buildAskBlocks(state),
      channel: channelId,
      metadata: buildAskMetadata(state),
      text: `Question: ${state.question}`,
      ts: event.messageId,
    })
    .catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), id: state.id },
        '[ask] failed to update the question message'
      );
    });
  // Wake the waiting turn only once EVERYONE asked has finished. A question put
  // to three people is not answered by the fastest of them.
  if (isComplete(state)) {
    settleAnswers(state.id, state);
  }
}

bot.onAction(ASK_OPTION_ACTIONS, async (event) => {
  const state = parseAskStateFromRaw(event.raw);
  if (!state) {
    return;
  }
  const userId = event.user.userId;
  if (!state.askUserIds.includes(userId)) {
    await refuseOutsider(event);
    return;
  }
  if (state.done.includes(userId)) {
    await event.thread
      ?.postEphemeral(event.user, 'You already answered this one.')
      .catch(() => undefined);
    return;
  }
  const index = Number(event.value);
  if (!Number.isInteger(index) || index < 0 || index >= state.options.length) {
    return;
  }
  const current = state.picks[userId] ?? [];
  if (state.multiSelect) {
    // Toggle, so a mis-click is correctable before Done.
    state.picks[userId] = current.includes(index)
      ? current.filter((value) => value !== index)
      : [...current, index];
  } else {
    state.picks[userId] = [index];
    state.done.push(userId);
  }
  await updateAskMessage(event, state);
});

bot.onAction(ASK_SUBMIT_ACTION, async (event) => {
  const state = parseAskStateFromRaw(event.raw);
  if (!state) {
    return;
  }
  const userId = event.user.userId;
  if (!state.askUserIds.includes(userId)) {
    await refuseOutsider(event);
    return;
  }
  if (state.done.includes(userId)) {
    return;
  }
  if ((state.picks[userId] ?? []).length === 0 && !state.answers[userId]) {
    await event.thread
      ?.postEphemeral(event.user, 'Pick at least one option first.')
      .catch(() => undefined);
    return;
  }
  state.done.push(userId);
  await updateAskMessage(event, state);
});

bot.onAction(ASK_OTHER_ACTION, async (event) => {
  const state = parseAskStateFromRaw(event.raw);
  if (!state) {
    return;
  }
  if (!state.askUserIds.includes(event.user.userId)) {
    await refuseOutsider(event);
    return;
  }
  if (!event.triggerId) {
    return;
  }
  await slack.webClient.views
    .open({
      trigger_id: event.triggerId,
      view: {
        blocks: [
          {
            block_id: ASK_OTHER_BLOCK,
            element: {
              action_id: ASK_OTHER_INPUT,
              multiline: true,
              type: 'plain_text_input',
            },
            label: plainText('Your answer'),
            type: 'input',
          },
        ],
        callback_id: ASK_OTHER_MODAL,
        close: plainText('Cancel'),
        // Everything the submit handler needs to find its way back to the
        // message: the modal submission carries no message context of its own.
        private_metadata: JSON.stringify({
          channel: event.threadId.split(':').at(1),
          messageId: event.messageId,
          threadId: event.threadId,
        }),
        submit: plainText('Answer'),
        title: plainText('Other answer'),
        type: 'modal',
      },
    })
    .catch((error: unknown) => {
      logger.warn({ ...toLogError(error) }, '[ask] failed to open other modal');
    });
});

// The modal submission carries no message context of its own, so everything
// needed to find the question message rides in `private_metadata`.
const submissionSchema = z.object({
  view: z.object({ private_metadata: z.string().optional() }),
});

const metadataSchema = z.object({
  channel: z.string(),
  messageId: z.string(),
  threadId: z.string(),
});

bot.onModalSubmit(ASK_OTHER_MODAL, async (event) => {
  const submission = submissionSchema.safeParse(event.raw);
  if (!submission.success) {
    return;
  }
  let meta: z.output<typeof metadataSchema>;
  try {
    meta = metadataSchema.parse(
      JSON.parse(submission.data.view.private_metadata ?? '{}')
    );
  } catch {
    return;
  }
  const text = event.values[ASK_OTHER_BLOCK]?.trim();
  if (!text) {
    return;
  }
  // The modal has no message attached, so the state is re-read from the
  // message it came from rather than trusted from the payload.
  const history = await slack.webClient.conversations
    .history({
      channel: meta.channel,
      inclusive: true,
      latest: meta.messageId,
      limit: 1,
    })
    .catch(() => undefined);
  const raw = { message: history?.messages?.at(0) };
  const state = parseAskStateFromRaw(raw);
  if (!state) {
    return;
  }
  const userId = event.user.userId;
  if (!state.askUserIds.includes(userId) || state.done.includes(userId)) {
    return;
  }
  state.answers[userId] = text;
  if (!state.multiSelect) {
    state.done.push(userId);
  }
  await updateAskMessage(
    {
      messageId: meta.messageId,
      raw,
      threadId: meta.threadId,
      user: event.user,
    } as ActionEvent,
    state
  );
});
