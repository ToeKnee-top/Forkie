import { z } from 'zod';

export const POLL_VOTE_ACTION = 'poll_vote';
export const POLL_METADATA_TYPE = 'kyto_poll';

const BAR_SLOTS = 10;
const BUTTON_LABEL_MAX = 70;
const MAX_POLL_OPTIONS = 10;

// Slack requires every action_id in a message to be unique, so each option's
// button gets its own id. The handler is registered for all of them.
export const POLL_VOTE_ACTIONS = Array.from(
  { length: MAX_POLL_OPTIONS },
  (_, index) => `${POLL_VOTE_ACTION}_${index}`
);

export interface PollState {
  options: string[];
  question: string;
  /** Map of voter user id -> chosen option index. */
  votes: Record<string, number>;
}

const pollStateSchema = z.object({
  options: z.array(z.string()).min(2).max(10),
  question: z.string(),
  votes: z.record(z.string(), z.number()),
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

/** Extract poll state from a Slack block_actions payload's message metadata. */
export function parsePollStateFromRaw(raw: unknown): PollState | undefined {
  const parsedRaw = rawActionMessageSchema.safeParse(raw);
  if (!parsedRaw.success) {
    return;
  }
  const metadata = parsedRaw.data.message?.metadata;
  if (metadata?.event_type !== POLL_METADATA_TYPE) {
    return;
  }
  const state = pollStateSchema.safeParse(metadata.event_payload);
  return state.success ? state.data : undefined;
}

export function buildPollMetadata(state: PollState) {
  return { event_payload: state, event_type: POLL_METADATA_TYPE };
}

function countVotes(state: PollState): number[] {
  const counts = new Array<number>(state.options.length).fill(0);
  for (const index of Object.values(state.votes)) {
    if (index >= 0 && index < counts.length) {
      counts[index] = (counts[index] ?? 0) + 1;
    }
  }
  return counts;
}

function bar(count: number, total: number): string {
  if (total === 0) {
    return '░'.repeat(BAR_SLOTS);
  }
  const filled = Math.round((count / total) * BAR_SLOTS);
  return '█'.repeat(filled) + '░'.repeat(BAR_SLOTS - filled);
}

export function buildPollBlocks(state: PollState) {
  const counts = countVotes(state);
  const total = counts.reduce((sum, count) => sum + count, 0);

  const tally = state.options
    .map((option, index) => {
      const count = counts[index] ?? 0;
      const percent = total === 0 ? 0 : Math.round((count / total) * 100);
      return `*${option}*\n\`${bar(count, total)}\`  ${count} vote${count === 1 ? '' : 's'} · ${percent}%`;
    })
    .join('\n\n');

  const buttons = state.options.map((option, index) => ({
    action_id: `${POLL_VOTE_ACTION}_${index}`,
    text: {
      emoji: true,
      text: option.slice(0, BUTTON_LABEL_MAX),
      type: 'plain_text' as const,
    },
    type: 'button' as const,
    value: String(index),
  }));

  return [
    {
      text: { emoji: true, text: `📊  ${state.question}`, type: 'plain_text' },
      type: 'header',
    },
    { type: 'divider' },
    { text: { text: tally, type: 'mrkdwn' }, type: 'section' },
    { elements: buttons, type: 'actions' },
    {
      elements: [
        {
          text: `🗳️ Click an option to vote · click again to undo · ${total} total vote${total === 1 ? '' : 's'}`,
          type: 'mrkdwn',
        },
      ],
      type: 'context',
    },
  ];
}
