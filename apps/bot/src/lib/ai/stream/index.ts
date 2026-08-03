import type { TextStreamPart, ToolSet } from 'ai';
import type { StreamChunk } from '@/harness';
import logger from '@/lib/logger';
import { deepErrorText, errorStatus } from '@/lib/utils/error';
import { clamp } from '@/lib/utils/text';
import { createInlineReasoningSplitter } from './inline-reasoning';
import {
  type ClosedReasoning,
  createReasoningTracker,
} from './reasoning-tracker';
import { renderTask } from './tasks';

const MAX_VISIBLE_TASKS = 45;
// Reasoning ("Thinking") cards get their OWN visibility budget, separate from
// tool-call cards. They used to share one 45-slot set, so a turn with many tool
// calls exhausted the budget on tool cards and every later THINKING block was
// folded into the generic "N more steps" counter instead of shown — the model's
// reasoning vanished behind a step count on exactly the long turns where it
// matters most. A separate budget means tool activity can never starve it.
const MAX_VISIBLE_REASONING = 45;
const REASONING_OUTPUT_MAX_LENGTH = 2800;

// Opt-in raw-stream dump for diagnosing the Thinking card (e.g. "N more steps"
// showing where reasoning should be). Set KYTO_LOG_FULLSTREAM=1 and restart to
// log every fullStream part's type + a text snippet to the journal, so a real
// turn's parts can be read back (`journalctl -u kyto.service | grep fullStream`).
// Off by default — it is verbose and per-part.
const LOG_FULLSTREAM = process.env.KYTO_LOG_FULLSTREAM === '1';
const FULLSTREAM_SNIPPET_MAX = 240;

// A short, safe text snippet from any stream part for the diagnostic log above.
function fullStreamSnippet(part: { type: string } & Record<string, unknown>) {
  let text: string | undefined;
  if (typeof part.text === 'string') {
    text = part.text;
  } else if (typeof part.toolName === 'string') {
    text = `tool:${part.toolName}`;
  }
  return {
    id: typeof part.id === 'string' ? part.id : undefined,
    text: text ? clamp(text, FULLSTREAM_SNIPPET_MAX) : undefined,
    type: part.type,
  };
}
// How much of a provider error body to keep in the log. Enough to see the real
// upstream message (rate limit, context length, budget) without dumping a whole
// request body into the journal.
const ERROR_LOG_MAX_LENGTH = 800;

/**
 * What one model attempt's stream actually emitted. Logged at the end of every
 * attempt so a turn that went quiet can be explained from the journal alone:
 * zero text with tool calls is a silent completion, a non-empty `errors` with a
 * `tool-calls` last finish reason is a provider that died mid-task.
 */
export interface StreamTally {
  errors: string[];
  finishReasons: string[];
  reasoningParts: number;
  textChars: number;
  toolCalls: number;
  toolResults: number;
}

export interface StreamError {
  error: unknown;
  message: string;
  status?: number;
}

export async function* renderStream({
  context,
  emitText = false,
  knownTools,
  onTextDelta,
  onReasoning,
  onSkip,
  onToolActivity,
  onToolResult,
  onError,
  onFinish,
  onTally,
  stream,
}: {
  /** Attempt identity (model/provider/threadId) folded into every log line. */
  context?: Record<string, unknown>;
  /** Receives the attempt's tally once the stream ends (for the caller's log). */
  onTally?: (tally: StreamTally) => void;
  // When true, reply text is ALSO yielded as plain strings (the message body),
  // not only routed through onTextDelta. The main turn keeps this off (its text
  // is posted as separate messages via createReply); the subagent turns it on so
  // its streamed message shows the response in-body, alongside the plan cards.
  emitText?: boolean;
  knownTools?: ReadonlySet<string>;
  onTextDelta?: (text: string) => PromiseLike<void> | void;
  // Fires once per completed reasoning block with its full text. The agent loop
  // keeps the turn's reasoning so the NEXT turn in the thread can be shown what
  // kyto was thinking last time (lib/agent/thinking.ts) — Slack replays what was
  // said, never what was thought, so without this every turn starts from cold.
  onReasoning?: (text: string) => void;
  onSkip?: () => void;
  // Fires on the first real (non-phantom, registered) tool call. Lets the agent
  // loop tell "the model did actual work" apart from a truly empty completion,
  // so a turn that ran tools is never discarded as empty and restarted on a
  // fresh model (which would re-do all the work and burn the fallback chain).
  onToolActivity?: () => void;
  // Fires once per completed (non-phantom, non-skip) tool call with its input and
  // output. Lets the agent loop stash gathered results so that if a later step
  // truncates and the turn falls back to another model, those results can be
  // replayed into the fallback prompt — the new model answers from them instead
  // of re-running the same tools (e.g. re-doing identical web searches).
  onToolResult?: (info: {
    toolName: string;
    input: unknown;
    output: unknown;
  }) => void;
  // Fires for each stream-level error part (e.g. a provider 429 swallowed into
  // the stream). Lets the agent loop react to provider conditions — like a
  // HackClub "daily spending limit" 429, or a mid-task death that must not be
  // mistaken for a finished turn — that never surface as a thrown error.
  onError?: (info: StreamError) => void;
  // Fires for each stream finish/finish-step that carries a finishReason. Lets
  // the agent loop tell a deliberate completion (`stop`) apart from a truncated
  // or empty step that emitted no finish — the latter, when it also produced no
  // text, is the "stops mid-task" bug (tools ran, synthesis step came back empty)
  // and must fall back instead of ending the turn silently.
  onFinish?: (finishReason: string) => void;
  stream: AsyncIterable<TextStreamPart<ToolSet>>;
}): AsyncGenerator<string | StreamChunk> {
  const toolInputs = new Map<string, unknown>();
  // Weak models sometimes hallucinate a tool call to a non-existent tool (e.g.
  // a mangled name like " analemma"). The harness answers with a "Tool X not
  // found" tool-result and the model recovers on the next step — but we must not
  // surface that phantom call/result as a visible activity task. Track their ids
  // so the matching tool-result/tool-error is dropped too.
  const phantomToolCallIds = new Set<string>();
  // Which stretch of reasoning is open and what it has collected. The two rules
  // it enforces — a card id per BLOCK, and every block closed — are in
  // reasoning-tracker.ts, where they have tests.
  const reasoningTracker = createReasoningTracker();
  const visibleTaskIds = new Set<string>();
  // Reasoning cards' own visibility budget (see MAX_VISIBLE_REASONING).
  const visibleReasoningIds = new Set<string>();
  let hiddenTaskCount = 0;
  let skipped = false;
  let droppedTextDeltas = 0;
  // Reasoning that arrived inline in the TEXT stream (see inline-reasoning.ts),
  // rather than in the provider's reasoning channel. Handed to onReasoning at
  // the end of the stream so the next turn still gets it, exactly like a
  // properly-separated reasoning block.
  const inlineReasoning = createInlineReasoningSplitter();
  let inlineReasoningText = '';
  // What this attempt emitted, so the caller can log why a turn ended the way it
  // did (silent completion vs. provider death mid-task) without a transcript.
  const tally: StreamTally = {
    errors: [],
    finishReasons: [],
    reasoningParts: 0,
    textChars: 0,
    toolCalls: 0,
    toolResults: 0,
  };

  /**
   * Render a finished block: attach the thinking to its card and keep the text
   * for the next turn.
   *
   * EVERY exit path has to run this for whatever is still open. A block left open
   * is a task card stuck on `in_progress`, and a plan message stopped with a
   * non-terminal task renders that row as broken once it collapses — plus the
   * thinking it held never reaches `onReasoning`, so the next turn loses it.
   */
  function* renderClosed(
    closed: ClosedReasoning | undefined
  ): Generator<string | StreamChunk> {
    if (!closed) {
      return;
    }
    if (closed.text) {
      onReasoning?.(closed.text);
    }
    if (!visibleReasoningIds.has(closed.id)) {
      return;
    }
    yield {
      id: closed.id,
      output: closed.text
        ? clamp(closed.text, REASONING_OUTPUT_MAX_LENGTH)
        : undefined,
      status: 'complete',
      title: 'Thinking',
      type: 'task_update',
    };
  }

  /** Close every block still open, so no card is left spinning. */
  function* closeAllReasoning(): Generator<string | StreamChunk> {
    for (const closed of reasoningTracker.closeAll()) {
      yield* renderClosed(closed);
    }
  }

  try {
    for await (const part of stream) {
      if (LOG_FULLSTREAM) {
        logger.info(
          {
            ...context,
            part: fullStreamSnippet(
              part as { type: string } & Record<string, unknown>
            ),
          },
          '[stream] fullStream part'
        );
      }
      if (part.type === 'finish-step' || part.type === 'finish') {
        const reason = (part as { finishReason?: string }).finishReason;
        if (reason) {
          tally.finishReasons.push(reason);
          onFinish?.(reason);
        }
      }
      if (part.type === 'error') {
        const error = (part as { error?: unknown }).error;
        const message = clamp(deepErrorText(error), ERROR_LOG_MAX_LENGTH) ?? '';
        const status = errorStatus(error);
        tally.errors.push(message);
        logger.error(
          { ...context, err: message, status },
          '[stream] provider error mid-stream'
        );
        onError?.({ error, message, status });
      }
      switch (part.type) {
        case 'text-delta': {
          // Some upstreams don't separate reasoning into its own channel: the
          // model wraps it in `<think>…</think>` and it arrives here, as content.
          // Route it to the thinking record instead of the reply — a public
          // thread once got several messages of raw deliberation before the
          // answer. See inline-reasoning.ts.
          const split = inlineReasoning.push(part.text ?? '');
          if (split.reasoning) {
            inlineReasoningText += split.reasoning;
          }
          // A skipped turn intentionally produces no reply, and some providers
          // emit placeholder garbage (e.g. "(Empty response: ...)") in this slot
          // when the model returned only a thinking block — never forward either.
          if (split.text && !skipped && !isPlaceholderText(split.text)) {
            tally.textChars += split.text.length;
            await onTextDelta?.(split.text);
            if (emitText) {
              yield split.text;
            }
          } else if (split.text) {
            droppedTextDeltas += 1;
          }
          break;
        }
        case 'reasoning-start': {
          tally.reasoningParts += 1;
          // Opening under an id that is STILL open (the provider reuses
          // "reasoning-0" for everything) hands back the block that was there;
          // close it, or its card spins forever and its thinking is lost.
          const { id, orphaned } = reasoningTracker.open(part.id);
          yield* renderClosed(orphaned);
          // Text is collected for EVERY reasoning block, including one whose plan
          // card is hidden (the visible-task budget is a UI limit; a thought kyto
          // had is still a thought it should remember next turn — see onReasoning).
          if (
            !showTask({
              id,
              max: MAX_VISIBLE_REASONING,
              visibleIds: visibleReasoningIds,
            })
          ) {
            hiddenTaskCount += 1;
            yield hiddenTaskUpdate({ count: hiddenTaskCount, done: false });
            break;
          }
          yield {
            id,
            status: 'in_progress',
            title: 'Thinking',
            type: 'task_update',
          };
          break;
        }
        case 'reasoning-delta': {
          reasoningTracker.delta(part.id, part.text);
          break;
        }
        case 'reasoning-end': {
          yield* renderClosed(reasoningTracker.close(part.id));
          break;
        }
        case 'tool-call': {
          // Drop hallucinated calls to tools we never registered: hide them from
          // the UI entirely (the model still gets the harness's not-found result
          // and recovers on the next step).
          if (knownTools && !knownTools.has(part.toolName.trim())) {
            phantomToolCallIds.add(part.toolCallId);
            logger.warn(
              { input: part.input, toolName: part.toolName },
              '[tool] ignored hallucinated tool call'
            );
            break;
          }
          toolInputs.set(part.toolCallId, part.input);
          tally.toolCalls += 1;
          onToolActivity?.();
          logger.info(
            {
              input: part.input,
              toolCallId: part.toolCallId,
              toolName: part.toolName,
            },
            '[tool] called'
          );
          const rendered = renderTask({
            input: part.input,
            phase: 'request',
            toolName: part.toolName,
          });
          if (
            !showTask({
              id: part.toolCallId,
              max: MAX_VISIBLE_TASKS,
              visibleIds: visibleTaskIds,
            })
          ) {
            hiddenTaskCount += 1;
            yield hiddenTaskUpdate({ count: hiddenTaskCount, done: false });
            break;
          }
          yield {
            details: rendered.details,
            id: part.toolCallId,
            status: 'in_progress',
            title: rendered.title,
            type: 'task_update',
          };
          break;
        }
        case 'tool-result': {
          if (phantomToolCallIds.has(part.toolCallId)) {
            phantomToolCallIds.delete(part.toolCallId);
            break;
          }
          tally.toolResults += 1;
          // Kept as a literal, not @repo/ai's SKIP_TOOL_NAME: importing that pulls
          // the provider/env chain into this module and takes its tests with it.
          if (part.toolName === 'skip') {
            skipped = true;
            onSkip?.();
          } else {
            onToolResult?.({
              input: toolInputs.get(part.toolCallId),
              output: part.output,
              toolName: part.toolName,
            });
          }
          const input = toolInputs.get(part.toolCallId);
          logger.info(
            {
              input,
              output: part.output,
              toolCallId: part.toolCallId,
              toolName: part.toolName,
            },
            '[tool] completed'
          );
          const rendered = renderTask({
            input,
            output: part.output,
            phase: 'response',
            toolName: part.toolName,
          });
          toolInputs.delete(part.toolCallId);
          if (!visibleTaskIds.has(part.toolCallId)) {
            break;
          }
          yield {
            id: part.toolCallId,
            output: rendered.output,
            status: 'complete',
            title: rendered.title,
            type: 'task_update',
          };
          break;
        }
        case 'tool-error': {
          if (phantomToolCallIds.has(part.toolCallId)) {
            phantomToolCallIds.delete(part.toolCallId);
            break;
          }
          const input = toolInputs.get(part.toolCallId);
          logger.warn(
            {
              error: part.error,
              input,
              toolCallId: part.toolCallId,
              toolName: part.toolName,
            },
            '[tool] failed'
          );
          const rendered = renderTask({
            input,
            output: part.error,
            phase: 'error',
            toolName: part.toolName,
          });
          toolInputs.delete(part.toolCallId);
          if (!visibleTaskIds.has(part.toolCallId)) {
            break;
          }
          yield {
            id: part.toolCallId,
            output: rendered.output,
            status: 'error',
            title: rendered.title,
            type: 'task_update',
          };
          break;
        }
        default:
          break;
      }
    }
  } catch (error) {
    // The stream died or was aborted mid-thought. Finish the open cards on the
    // way out — the plan message is already in Slack, so a row left spinning
    // stays visible after the failure — then let the caller route the error.
    yield* closeAllReasoning();
    throw error;
  }
  // A provider that ended without its own `reasoning-end` (or a step whose
  // flush never ran) leaves the last block open on the SUCCESS path too.
  yield* closeAllReasoning();
  // Release anything the splitter was still holding. An unterminated `<think>`
  // ends up here as reasoning, which is the safe classification: the model was
  // cut off mid-thought and that is not an answer.
  {
    const rest = inlineReasoning.flush();
    inlineReasoningText += rest.reasoning;
    if (rest.text && !skipped && !isPlaceholderText(rest.text)) {
      tally.textChars += rest.text.length;
      await onTextDelta?.(rest.text);
      if (emitText) {
        yield rest.text;
      }
    }
  }
  const inlineTrimmed = inlineReasoningText.trim();
  if (inlineTrimmed) {
    // Keep it for the next turn like any other reasoning block, and say so in
    // the journal — a model routing its thinking through the text channel is
    // worth noticing, not silently papering over.
    tally.reasoningParts += 1;
    onReasoning?.(inlineTrimmed);
    logger.warn(
      { ...context, chars: inlineTrimmed.length },
      '[stream] model emitted reasoning inline in its text; kept it out of the reply'
    );
  }
  if (hiddenTaskCount > 0) {
    yield hiddenTaskUpdate({ count: hiddenTaskCount, done: true });
  }
  logger.info(
    { ...context, ...tally, droppedTextDeltas },
    '[stream] attempt stream ended'
  );
  onTally?.(tally);
}

// Some upstream proxies, when a model returns only a thinking block with no
// text, substitute a placeholder string (e.g. a Python-repr "(Empty response:
// {...})") into the text slot. Never surface those to users.
const PLACEHOLDER_TEXT = /^\s*\(empty (response|completion):/i;

function isPlaceholderText(text: string): boolean {
  return PLACEHOLDER_TEXT.test(text);
}

function showTask({
  id,
  visibleIds,
  max,
}: {
  id: string;
  visibleIds: Set<string>;
  max: number;
}): boolean {
  if (visibleIds.has(id)) {
    return true;
  }
  if (visibleIds.size < max) {
    visibleIds.add(id);
    return true;
  }
  return false;
}

// The overflow row, shown once the plan is already MAX_VISIBLE_TASKS long. It
// is read by people scrolling a Slack thread, not by us reading a log, so it
// says what it means: "Activity: 25 / Ran 25 additional activity items" told
// nobody anything, and looked like a bug in a turn that had gone fine.
function hiddenTaskUpdate({
  count,
  done,
}: {
  count: number;
  done: boolean;
}): StreamChunk {
  return {
    id: 'hidden-activity',
    output: done
      ? `${count} more step${count === 1 ? '' : 's'} ran and are not shown individually, to keep this list readable.`
      : undefined,
    status: done ? 'complete' : 'in_progress',
    title: done
      ? `${count} more step${count === 1 ? '' : 's'}`
      : `${count} more step${count === 1 ? '' : 's'} (running)`,
    type: 'task_update',
  };
}
