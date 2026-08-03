import { z } from 'zod';
import { mrkdwn, plainText } from '@/harness/views';

// A question kyto asked specific people, rendered as a PUBLIC message in the
// thread with option buttons.
//
// Public rather than ephemeral (owner's call): an ephemeral vanishes on reload
// and cannot be answered later, and nobody else can see that a decision is
// being made. Gated rather than open: only the people the question was
// ADDRESSED to can answer it, so "ask the two people who own this" does not
// become "let the loudest person in the channel decide".
//
// State lives in the message's own Slack metadata, like polls do, so the
// message keeps working across a bot restart instead of leaving dead buttons.

export const ASK_METADATA_TYPE = 'kyto_ask';
export const ASK_OPTION_ACTION = 'ask_option';
export const ASK_SUBMIT_ACTION = 'ask_submit';
export const ASK_OTHER_ACTION = 'ask_other';
export const ASK_OTHER_MODAL = 'ask_other_modal';
export const ASK_OTHER_BLOCK = 'ask_other_block';
export const ASK_OTHER_INPUT = 'ask_other_input';

export const MAX_ASK_OPTIONS = 8;
const BUTTON_LABEL_MAX = 70;

// Slack needs a unique action_id per element in a message.
export const ASK_OPTION_ACTIONS = Array.from(
  { length: MAX_ASK_OPTIONS },
  (_, index) => `${ASK_OPTION_ACTION}_${index}`
);

export interface AskOption {
  description?: string;
  label: string;
}

export interface AskState {
  allowOther: boolean;
  /** Free-text answers, by user id. Only present when allowOther. */
  answers: Record<string, string>;
  /** Slack user ids allowed to answer. Everyone else can look but not touch. */
  askUserIds: string[];
  /** Who has finalised their answer. Multi-select needs an explicit Done. */
  done: string[];
  /** Correlates the message with the waiting turn. */
  id: string;
  multiSelect: boolean;
  options: AskOption[];
  /** Chosen option indexes, by user id. */
  picks: Record<string, number[]>;
  question: string;
}

const askStateSchema = z.object({
  answers: z.record(z.string(), z.string()),
  allowOther: z.boolean(),
  askUserIds: z.array(z.string()),
  done: z.array(z.string()),
  id: z.string(),
  multiSelect: z.boolean(),
  options: z.array(
    z.object({ description: z.string().optional(), label: z.string() })
  ),
  question: z.string(),
  picks: z.record(z.string(), z.array(z.number())),
});

const rawActionMessageSchema = z.looseObject({
  message: z
    .looseObject({
      metadata: z
        .looseObject({
          event_payload: z.unknown().optional(),
          event_type: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});

export function parseAskStateFromRaw(raw: unknown): AskState | undefined {
  const parsedRaw = rawActionMessageSchema.safeParse(raw);
  if (!parsedRaw.success) {
    return;
  }
  const metadata = parsedRaw.data.message?.metadata;
  if (metadata?.event_type !== ASK_METADATA_TYPE) {
    return;
  }
  const state = askStateSchema.safeParse(metadata.event_payload);
  return state.success ? state.data : undefined;
}

export function buildAskMetadata(state: AskState) {
  return {
    event_payload: state as unknown as Record<string, unknown>,
    event_type: ASK_METADATA_TYPE,
  };
}

/** Has everyone the question was addressed to finished answering? */
export function isComplete(state: AskState): boolean {
  return state.askUserIds.every((userId) => state.done.includes(userId));
}

/** One person's answer, as prose for the model. */
export function renderAnswer(state: AskState, userId: string): string {
  const picked = (state.picks[userId] ?? [])
    .map((index) => state.options[index]?.label)
    .filter((label): label is string => Boolean(label));
  const other = state.answers[userId];
  const parts = [...picked, ...(other ? [`Other: ${other}`] : [])];
  return parts.length > 0 ? parts.join(', ') : '(no answer)';
}

function truncate(text: string): string {
  return text.length > BUTTON_LABEL_MAX
    ? `${text.slice(0, BUTTON_LABEL_MAX - 1)}…`
    : text;
}

function answerLines(state: AskState): string[] {
  return state.askUserIds.map((userId) => {
    if (!state.done.includes(userId)) {
      const partial = state.picks[userId] ?? [];
      return partial.length > 0
        ? `• <@${userId}> — _choosing: ${renderAnswer(state, userId)}_`
        : `• <@${userId}> — _waiting_`;
    }
    return `• <@${userId}> — *${renderAnswer(state, userId)}*`;
  });
}

export function buildAskBlocks(state: AskState): unknown[] {
  const addressed = state.askUserIds.map((id) => `<@${id}>`).join(' ');
  const optionLines = state.options
    .filter((option) => option.description)
    .map((option) => `*${option.label}* — ${option.description}`);
  const complete = isComplete(state);
  return [
    {
      text: mrkdwn(
        `:speech_balloon: *${state.question}*\n${addressed} — ${
          state.multiSelect
            ? 'pick any that apply, then hit Done.'
            : 'pick one.'
        }`
      ),
      type: 'section',
    },
    ...(optionLines.length > 0
      ? [{ text: mrkdwn(optionLines.join('\n')), type: 'section' }]
      : []),
    ...(complete
      ? []
      : [
          {
            elements: [
              ...state.options.map((option, index) => ({
                action_id: ASK_OPTION_ACTIONS[index],
                text: plainText(truncate(option.label)),
                type: 'button',
                value: String(index),
              })),
              ...(state.allowOther
                ? [
                    {
                      action_id: ASK_OTHER_ACTION,
                      text: plainText('Other…'),
                      type: 'button',
                      value: state.id,
                    },
                  ]
                : []),
              ...(state.multiSelect
                ? [
                    {
                      action_id: ASK_SUBMIT_ACTION,
                      style: 'primary',
                      text: plainText('Done'),
                      type: 'button',
                      value: state.id,
                    },
                  ]
                : []),
            ],
            type: 'actions',
          },
        ]),
    {
      text: mrkdwn(answerLines(state).join('\n')),
      type: 'section',
    },
  ];
}
