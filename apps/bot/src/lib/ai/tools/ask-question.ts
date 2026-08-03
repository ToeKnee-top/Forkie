import { tool } from 'ai';
import { z } from 'zod';
import type { ThreadHandle as Thread } from '@/harness';
import { abandonQuestion, waitForAnswers } from '@/lib/ask-question/pending';
import {
  type AskState,
  buildAskBlocks,
  buildAskMetadata,
  isComplete,
  MAX_ASK_OPTIONS,
  renderAnswer,
} from '@/lib/ask-question/state';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';

// How long a turn will hold for an answer. Long enough for someone to notice a
// Slack message and click; short enough that an unanswered question doesn't
// pin an attempt open forever. The question message OUTLIVES this — it stays in
// the thread and still records answers; the turn just stops waiting.
const ASK_WAIT_MS = 10 * 60 * 1000;

const USER_ID = /^[UW][A-Z0-9]+$/i;

function normalizeUserId(raw: string): string | undefined {
  // Accept a bare id, `<@U123>`, or `<@U123|name>` — models write all three.
  const match = /^<@([^|>]+)(?:\|[^>]*)?>$/.exec(raw.trim());
  const id = (match?.[1] ?? raw).trim();
  return USER_ID.test(id) ? id.toUpperCase() : undefined;
}

export function askQuestionTool({
  extendAttemptDeadline,
  thread,
}: {
  extendAttemptDeadline?: (extraMs: number) => void;
  thread: Thread;
}) {
  return tool({
    description:
      'Ask specific people a multiple-choice question and WAIT for their answer. Posts a public message in this thread with option buttons, addressed to the user ids you name — only those people can answer it; everyone else sees it but their clicks are refused. Use this when you genuinely need someone to decide between concrete options and guessing would waste their time or do the wrong thing; do NOT use it to ask something you could work out yourself, and do not use it in a recurring job (nobody is there). It blocks for up to 10 minutes and then returns whatever came in, so ask it once and early rather than repeatedly.',
    inputSchema: z.object({
      allowOther: z
        .boolean()
        .default(false)
        .describe(
          'Add an "Other…" button that opens a box for a free-text answer.'
        ),
      askUserIds: z
        .array(z.string())
        .min(1)
        .max(10)
        .describe(
          'Slack user ids of the people who may answer (e.g. ["U085KKYFA6Q"]). Only these people can click.'
        ),
      multiSelect: z
        .boolean()
        .default(false)
        .describe(
          'Let each person pick several options and confirm with a Done button.'
        ),
      options: z
        .array(
          z.object({
            description: z
              .string()
              .optional()
              .describe('One line on what this choice means.'),
            label: z.string().min(1).describe('Short button text.'),
          })
        )
        .min(2)
        .max(MAX_ASK_OPTIONS),
      question: z.string().min(1).describe('The question, in one sentence.'),
    }),
    execute: async (
      { allowOther, askUserIds, multiSelect, options, question },
      { abortSignal }
    ) => {
      const resolved = askUserIds
        .map(normalizeUserId)
        .filter((id): id is string => Boolean(id));
      if (resolved.length === 0) {
        return {
          error:
            'askQuestion needs at least one valid Slack user id (e.g. U085KKYFA6Q). Nobody could be addressed, so nothing was asked.',
        };
      }
      const id = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const state: AskState = {
        allowOther,
        answers: {},
        askUserIds: [...new Set(resolved)],
        done: [],
        id,
        multiSelect,
        options,
        picks: {},
        question,
      };

      try {
        await thread.post({
          blocks: buildAskBlocks(state),
          fallbackText: `Question: ${question}`,
          metadata: buildAskMetadata(state),
        });
      } catch (error) {
        return {
          error: `Could not post the question: ${errorMessage(error)}`,
        };
      }

      // A deliberate pause, not a stall — tell the attempt watchdog, the same
      // way the `wait` tool and the confirm gate do, or a slow answer gets the
      // turn killed while it is doing exactly what it was asked to.
      extendAttemptDeadline?.(ASK_WAIT_MS + 30_000);

      const answered = await Promise.race([
        waitForAnswers(id),
        new Promise<null>((resolve) => {
          const timer = setTimeout(() => resolve(null), ASK_WAIT_MS);
          abortSignal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              resolve(null);
            },
            { once: true }
          );
        }),
      ]);
      abandonQuestion(id);

      if (!answered) {
        logger.info({ id, question }, '[ask] nobody answered in time');
        return {
          answers: {},
          complete: false,
          summary:
            'Nobody answered within 10 minutes. The question is still in the thread and they can still answer it, but you do not have an answer now — say so and either carry on with what does not depend on it, or stop. Do not ask again in this turn, and do not invent an answer.',
        };
      }

      const answers = Object.fromEntries(
        answered.askUserIds
          .filter((userId) => answered.done.includes(userId))
          .map((userId) => [userId, renderAnswer(answered, userId)])
      );
      logger.info(
        { answered: Object.keys(answers).length, id },
        '[ask] question answered'
      );
      return {
        answers,
        complete: isComplete(answered),
        summary: `Answers: ${Object.entries(answers)
          .map(([userId, answer]) => `<@${userId}> chose "${answer}"`)
          .join('; ')}. Act on these; do not ask them to confirm again.`,
      };
    },
  });
}
