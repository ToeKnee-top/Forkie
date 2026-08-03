import {
  describeImages,
  HACKCLUB_PROVIDER,
  LEADERBOARD_FALLBACK,
  MAX_STEPS,
  type ModelAttempt,
  modelSupportsVision,
  PRIMARY_ATTEMPT,
  type ResolvedModelHolder,
  type SandboxContext,
  streamAttempt,
  systemPrompt,
  visionAttempt,
} from '@repo/ai';
import { LazySandbox } from '@repo/sandbox';
import { env } from '@/env';
import type { Message, StreamChunk, ThreadHandle } from '@/harness';
import {
  type GatheredResult,
  renderCarryover,
  renderContinuation,
  renderObservations,
  stableInput,
} from '@/lib/agent/carryover';
import {
  createRepetitionGuard,
  stripRepeatedLines,
} from '@/lib/agent/degenerate';
import { buildPrompt } from '@/lib/agent/prompt';
import { createReply } from '@/lib/agent/reply';
import {
  attemptKey,
  buildFallbackQueue as buildQueue,
  condemnsHackclub,
  isPromptConstructionError,
  selectNextAttempt,
} from '@/lib/agent/routing';
import { createSegmenter, isVisibleText } from '@/lib/agent/segmentation';
import { isBareSkipText } from '@/lib/agent/skip-text';
import {
  abortReasonOf,
  interruptTurn,
  queuedInput,
} from '@/lib/agent/steering';
import { rememberThinking } from '@/lib/agent/thinking';
import { clearTurn, getTurn, setTurn } from '@/lib/agent/turns';
import { startThinking } from '@/lib/agent/utils';
import { promptWithAttachments, seedAttachments } from '@/lib/ai/attachments';
import { requestHints } from '@/lib/ai/hints';
import { renderStream, type StreamError } from '@/lib/ai/stream';
import { buildTools } from '@/lib/ai/toolset';
import { runQueuedTurn } from '@/lib/ai/turn-queue';
import { recordByokOutcome, resolveUserRouting } from '@/lib/byok';
import { bot, slack } from '@/lib/chat';
import { recordChatgptOutcome } from '@/lib/chatgpt';
import {
  agentErrorMessage,
  BudgetExhaustedError,
  ByokExhaustedError,
  DegenerateOutputError,
  StreamInterruptedError,
} from '@/lib/errors';
import { brokerableGithubToken } from '@/lib/github/token';
import logger from '@/lib/logger';
import { acquireThreadSandbox, threadSandboxStore } from '@/lib/sandbox/store';
import {
  registerProxyToken,
  revokeProxyToken,
  slackHelperInstall,
  slackProxyEnv,
} from '@/lib/slack-proxy';
import {
  deepErrorText,
  describeMalformedPrompt,
  errorMessage,
  errorStatus,
} from '@/lib/utils/error';
import { clamp } from '@/lib/utils/text';
import type { ActiveTurn, AgentErrorStage } from '@/types/agent';
import type { AttemptFailure } from '@/types/attempts';

// HackClub daily-spend-limit rejection (also "insufficient credits"). Matched
// against stream error parts to fail over off HackClub for the turn, i.e.
// HackClub's shared budget is exhausted. Matches both shapes it has returned:
// a 429 "Daily spending limit of $3 reached", and the upstream 403
// "Key limit exceeded (daily limit)". Both live in the response BODY, not the
// error message — see deepErrorText.
const SPEND_LIMIT_PATTERN =
  /spending limit|insufficient credits|daily limit|limit exceeded/i;

// How many non-budget HackClub PROXY failures in a turn before we treat HackClub
// as down and skip its remaining rungs. ONE is enough: every HackClub rung shares
// one proxy and one budget, so a rung that fails for a non-model reason (5xx,
// connection error, rate limit) means the next rung fails identically. Trying a
// second one only bought another "Thinking · fallback" card before the same
// verdict. The owner's own Gemini key is a genuinely separate quota, so jump.
//
// Only a failure the PROXY reported counts (`errorStatus` found an HTTP status).
// This matters because the PRIMARY is itself a HackClub call: the model-level
// faults kyto raises on its own — an empty response, tools-but-no-reply, a
// degenerate loop — carry no status, and they say nothing about the proxy. If
// they counted, one bad completion from the primary would write off every
// remaining HackClub rung for that turn and drop the user straight onto Gemini.
//
// A GATEWAY status is excluded for the same reason (`isGatewayStatus`). Measured
// 2026-07-27: the proxy 504s per REQUEST, not per model and not tier-wide — a
// probe caught opus-4.8 504 while kimi-k2.7 and glm-5.2 answered fine seconds
// either side. So a 504 that survived the retries in gateway-retry.ts says
// "we lost that request", not "the proxy is down", and condemning the tier on
// one of them is how a single dropped request used to skip every HackClub rung
// and land a live thread on gemini-3.1-flash-lite.
const HACKCLUB_OUTAGE_THRESHOLD = 1;

// How many times a reply that hit MAX_OUTPUT_TOKENS mid-sentence may be resumed
// before kyto stops and posts what it has. Three rounds is ~24k tokens of reply,
// far past anything worth reading in Slack; the cap exists because a model that
// keeps filling the budget exactly would otherwise continue forever.
const MAX_CONTINUATIONS = 3;

// How long a single attempt may go with NO sign of progress before it's aborted
// (see the STALL watchdog below — it's re-armed on every streamed text delta,
// tool call, and tool result, so this is an IDLE budget, not a cap on total turn
// length). Without it, a stalled upstream SSE connection or a hung tool leaves
// the turn awaiting forever. On expiry we abort only THIS attempt's signal (not
// the shared turn controller), so the normal recovery path takes over: fall back
// to the next model if no reply text was streamed yet, or surface an error.
// 5 min covers a slow model step and most single long tool calls (a foreground
// subagent / codeMode is bounded only by this) while recovering from a real
// stall far quicker than the old 10-minute cap did.
const ATTEMPT_TIMEOUT_MS =
  Number(process.env.AGENT_ATTEMPT_TIMEOUT_MS) || 5 * 60 * 1000;

// How much of a provider error body to keep in a log line: enough to name the
// real upstream cause (rate limit, context length, budget) without pasting a
// whole request body into the journal.
const ERROR_LOG_MAX_LENGTH = 800;

// How much already-sent reply text a continuation attempt is shown. Only the
// TAIL matters (the model needs to know where the thought was cut off), and the
// user's message plus carryover results are already in the prompt.
const STREAMED_TEXT_MAX = 4000;

function appendStreamedText(existing: string, text: string): string {
  const combined = existing + text;
  return combined.length > STREAMED_TEXT_MAX
    ? combined.slice(-STREAMED_TEXT_MAX)
    : combined;
}

class AttemptTimeoutError extends Error {
  constructor(ms: number) {
    super(
      `Model attempt exceeded ${Math.round(ms / 1000)}s without completing.`
    );
    this.name = 'AttemptTimeoutError';
  }
}

export { stopAllTurns, stopTurn } from '@/lib/agent/turns';

export function runTurn(input: {
  message: Message;
  thread: ThreadHandle;
}): Promise<void> {
  const turn = getTurn({ threadId: input.thread.id });
  if (!turn) {
    return runQueuedTurn({
      threadId: input.thread.id,
      run: (controller) => executeTurn(input, controller),
    });
  }

  interruptTurn({ activeTurn: turn, input });
  return slack
    .addReaction(input.thread.id, input.message.id, 'white_check_mark')
    .then(() => undefined)
    .catch(() => undefined);
}

async function executeTurn(
  { message, thread }: { message: Message; thread: ThreadHandle },
  controller: AbortController
): Promise<void> {
  const threadId = thread.id;
  // Only the owner may make kyto broadcast (@channel/@here/@everyone). For
  // everyone else those tokens are neutralized in the streamed reply and the
  // postMessage tool, so a non-owner can't get it to ping the whole channel.
  const isOwner =
    Boolean(env.OWNER_USER_ID) && message.author.userId === env.OWNER_USER_ID;
  const turnStart = Date.now();
  logger.info(
    {
      attachments: message.attachments.length,
      isOwner,
      text: message.text,
      threadId,
      userId: message.author.userId,
    },
    '[agent] turn started'
  );
  const activeTurn: ActiveTurn = {
    controller,
    pendingMessages: [],
  };
  setTurn({ threadId, turn: activeTurn });
  await startThinking({ thread });
  const hints = await requestHints({ thread, message });

  // Per-turn read-only Slack proxy secret: injected into the sandbox so a
  // script can query Slack (read-only) without the bot token, revoked at turn
  // end. Only when the sites server (which hosts the proxy) is enabled.
  const slackProxySecret = env.SITES_ENABLED ? registerProxyToken() : undefined;
  const proxyEnv = slackProxySecret
    ? slackProxyEnv(slackProxySecret, env.SITES_PUBLIC_HOST)
    : {};

  // The lazy sandbox: creating this object is free — the real E2B sandbox
  // materializes only when a tool first touches it. It is PER-THREAD and
  // PERSISTENT: destroy() pauses it rather than killing it, and the next turn in
  // this thread reconnects to the same filesystem, so files kyto wrote earlier
  // are still there. The store is what makes it persistent (see sandbox/store).
  const sandboxSession = new LazySandbox({
    apiKey: env.E2B_API_KEY,
    // Puts `slack <method>` on PATH, so the plain `bash` tool can query Slack
    // read-only too — not just the slackScript tool.
    bootstrapCommand: slackProxySecret ? slackHelperInstall() : undefined,
    env: proxyEnv,
    // Only a token GitHub still accepts. Brokering a dead one attaches an
    // Authorization header GitHub rejects to EVERY github.com request, which
    // breaks anonymous reads of PUBLIC repos too (see lib/github/token).
    githubToken: await brokerableGithubToken(),
    logger,
    sessionId: threadId,
    store: threadSandboxStore,
  });
  const sandboxContext: SandboxContext = {
    session: sandboxSession,
    sessionWorkDir: sandboxSession.workDir,
  };
  let closeTools: (() => Promise<void>) | undefined;
  let activeAttempt: ModelAttempt | undefined;
  // Agentic steps the winning attempt ran, surfaced in the terminal turn log so
  // a turn that ended near the step ceiling is visible without a Slack transcript.
  let handledSteps: number | undefined;
  // Every attempt that failed this turn, so the terminal log line explains the
  // whole fallback walk (which models were tried, and why each one died).
  const attempts: AttemptFailure[] = [];
  let reply: ReturnType<typeof createReply> | undefined;
  let errorStage: AgentErrorStage = 'before_output';
  // Filled by the successful attempt so the finalizer can render the usage
  // footer (output tokens · tokens/sec) if the user hasn't disabled it.
  let usageFooter:
    | { outputTokens: number; tokensPerSecond: number }
    | undefined;
  // The answering attempt's prompt-token split, logged on `turn complete`. Kept
  // separate from usageFooter: the footer is a user-facing opt-out, this is
  // operational (is the 1h cache actually being hit?) and always recorded.
  let turnUsage:
    | {
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        inputTokens?: number;
      }
    | undefined;

  const cleanup = async (): Promise<void> => {
    revokeProxyToken(slackProxySecret);
    await closeTools?.().catch(() => undefined);
    await sandboxSession.destroy().catch(() => undefined);
  };

  // Hold this thread's sandbox for the whole turn, so a bash reminder firing on
  // the scheduler can't pause the sandbox out from under a running command.
  const releaseSandbox = await acquireThreadSandbox(threadId);

  try {
    // Slack's native streaming API renders the thinking/task-card UI. Every
    // message threads (a top-level message roots its own thread), so a valid
    // threadTs always exists. The turn is driven as a SEQUENCE of plan messages
    // (see streamSegmented) so that reply text splits the plan into separate
    // collapsible blocks: [plan] text [plan] text.
    await streamSegmented({ message, thread });
    await reply?.flush({ thread });
    if (hints.customization?.prompt && !slack.isDM(thread.id)) {
      await thread
        .post({
          markdown: "_kyto's responses are shaped by this user's instructions_",
        })
        .catch(() => undefined);
    }
    if (usageFooter && hints.customization?.showUsageFooter !== false) {
      await postUsageFooter({ footer: usageFooter, thread });
    }
    await cleanup();
    logger.info(
      {
        attempt: attemptLog(activeAttempt),
        // `cacheReadTokens` high and `inputTokens` low across a thread's turns
        // means the 1h breakpoints are landing; a read of 0 on a repeat turn in
        // the same thread means caching is broken (usually a volatile block that
        // moved above the history — see the prompt-order note in CLAUDE.md).
        // Absent entirely = the provider reported no cache detail.
        cache: cacheLog(turnUsage),
        durationMs: Date.now() - turnStart,
        failedAttempts: failedAttemptsLog(attempts),
        outputTokens: usageFooter?.outputTokens,
        steps: handledSteps,
        threadId,
      },
      '[agent] turn complete'
    );
  } catch (error) {
    const reason = abortReasonOf(controller.signal);
    if (reason) {
      logger.info({ reason, threadId }, '[agent] turn interrupted');
      await cleanup();
    } else {
      logger.error(
        {
          attempt: attemptLog(activeAttempt),
          durationMs: Date.now() - turnStart,
          err: errorMessage(error),
          errorDetail: clamp(deepErrorText(error), ERROR_LOG_MAX_LENGTH),
          failedAttempts: failedAttemptsLog(attempts),
          stage: errorStage,
          status: errorStatus(error),
          threadId,
        },
        '[agent] turn failed'
      );
      await reply?.flush({ thread });
      await cleanup();
      await thread.post(agentErrorMessage({ error, stage: errorStage }));
    }
  } finally {
    // cleanup() (which pauses the sandbox) has already run on both paths above.
    releaseSandbox();
    clearTurn({ threadId, turn: activeTurn });
    // Only an interrupt replays queued messages; a rapid burst is merged into a
    // single follow-up so steering does not drop intermediate corrections.
    const resume =
      abortReasonOf(controller.signal) === 'interrupt'
        ? queuedInput(activeTurn)
        : undefined;
    if (resume) {
      runTurn(resume).catch((error: unknown) => {
        logger.error(
          { err: error, threadId },
          '[agent] failed to run interrupted follow-up turn'
        );
      });
    }
  }

  async function* renderTurn({
    message: turnMessage,
    thread: turnThread,
  }: {
    message: Message;
    thread: ThreadHandle;
  }): AsyncGenerator<string | StreamChunk> {
    const messageText = await buildPrompt(turnMessage, {
      customizationPrompt: hints.customization?.prompt,
      thread: turnThread,
    });
    // Seed attached files into the sandbox up front (materializes it only when
    // the message actually carries files — chat-only turns stay sandbox-free).
    const attachments =
      turnMessage.attachments.length > 0
        ? await seedAttachments({ message: turnMessage, sandboxContext })
        : [];
    // Images the user attached, shown to the model's vision on the user turn
    // (not just handed over as file paths). Bounded/filtered in seedAttachments.
    const attachmentImages = attachments
      .filter((entry) => entry.imageBytes !== undefined)
      .map((entry) => ({
        bytes: entry.imageBytes as Uint8Array,
        mediaType: entry.mimeType ?? 'image/png',
        path: entry.name,
      }));
    // The primary (deepseek-v4-flash) is served by a text-only endpoint that
    // 404s on image input. Rather than burn a doomed attempt on every screenshot
    // and fall back, have Gemini DESCRIBE the attached images and feed that text
    // to the primary — the owner's "use gemini to understand the image and tell
    // deepseek what it is". The raw bytes are still on disk in the sandbox for a
    // tool to read. Only kicks in for a text-only primary with a Gemini key
    // configured; a successful description replaces the raw images so nothing
    // 404s, and a failed one silently falls back to sending the raw images.
    let visionDescription: string | null = null;
    let modelImages = attachmentImages;
    if (
      attachmentImages.length > 0 &&
      !modelSupportsVision(PRIMARY_ATTEMPT.model) &&
      visionAttempt
    ) {
      visionDescription = await describeImages({
        attempt: visionAttempt,
        images: attachmentImages,
        signal: controller.signal,
      });
      if (visionDescription) {
        modelImages = [];
      }
    }
    // Distinguish a turn that did real work from a truly empty completion. Only
    // a completion that produced NEITHER reply text, NOR a deliberate skip, NOR
    // tool activity that ended on a clean `stop` is treated as unhandled and
    // falls through to another model (see the handled check below).
    let producedText = false;
    let skipped = false;
    // Everything the user has already been shown this turn. A fallback attempt
    // that CONTINUES an interrupted turn is told about it so it picks up instead
    // of repeating itself (renderContinuation).
    let streamedText = '';
    // Tool results gathered so far this turn, deduped by tool+input. If a later
    // step truncates and the turn falls back to another model, these are
    // replayed into the fallback prompt so the new model answers from them
    // instead of re-running the same tools.
    const gatheredResults: GatheredResult[] = [];
    const gatheredKeys = new Set<string>();
    // BYOK: if the ACTING USER brought their own model keys, this turn runs on
    // them (in the order they added them) instead of the service models. The
    // shared service chain is only reachable afterwards if they opted in — a
    // broken personal key must not silently spend the shared budget.
    const routing = await resolveUserRouting(turnMessage.author.userId);
    // The user's own paid attempts (a linked ChatGPT account and/or BYOK keys),
    // consumed in order. routing.ownFirst decides whether these run before or
    // after kyto's shared service chain.
    const ownQueue = [...routing.own];
    // The service query runs on PRIMARY_ATTEMPT (a pinned model on HackClub).
    // On failure we walk the fallback queue built by buildFallbackQueue. Models
    // already tried are skipped via failedKeys.
    const failedKeys = new Set<string>();
    let triedPrimary = false;
    let fallbackQueue: ModelAttempt[] | undefined;
    // Set when a HackClub call returns the daily-spend-limit 429. The whole
    // HackClub budget is shared, so once one call 429s every HackClub rung
    // would too — the fallback queue then goes straight to the owner's Gemini
    // key (separate quota) instead of burning attempts.
    let hackclubBudgetExhausted = false;
    let spendLimitMessage: string | undefined;
    // Set when HackClub itself looks DOWN (repeated non-budget failures, e.g.
    // 5xx/connection errors), as opposed to just over budget. Every HackClub
    // rung would fail the same way, so once tripped we skip the rest of the
    // HackClub leaderboard and go straight to Gemini instead of burning a dozen
    // doomed attempts (the "lots of Thinking · fallback" bug).
    let hackclubFailures = 0;
    let hackclubUnavailable = false;
    let attempt: ModelAttempt | undefined;
    // Set per attempt (the watchdog is armed inside the loop below), but the
    // toolset is built ONCE up front — so the tools get a stable indirection
    // that always reaches the currently running attempt's watchdog.
    let extendDeadline: ((extraMs: number) => void) | undefined;
    // Built once: the toolset does not depend on the chosen model. Its keys let
    // renderStream hide hallucinated calls to non-existent tools; activeTools
    // drives deferred-tool visibility via prepareStep.
    const built = await buildTools({
      bot,
      extendAttemptDeadline: (extraMs) => extendDeadline?.(extraMs),
      getSandboxContext: () => sandboxContext,
      message: turnMessage,
      thread: turnThread,
    });
    closeTools = built.close;
    const knownTools = new Set(Object.keys(built.tools));

    // The next of the user's OWN attempts (ChatGPT account / BYOK keys), or
    // undefined when they're spent.
    const nextOwnAttempt = (): ModelAttempt | undefined => ownQueue.shift();
    // The next SHARED service attempt: PRIMARY_ATTEMPT first, then the fallback
    // queue in tier order, skipping already-failed keys and any tier written off
    // mid-walk. Undefined when the whole shared chain is exhausted. The queue
    // order and the skip rule live in lib/agent/routing, where they have tests —
    // this is where the worst regression in the project's history came from.
    const nextSharedAttempt = (): ModelAttempt | undefined => {
      if (!triedPrimary) {
        triedPrimary = true;
        return PRIMARY_ATTEMPT;
      }
      fallbackQueue ??= buildQueue(LEADERBOARD_FALLBACK);
      return selectNextAttempt({
        failedKeys,
        queue: fallbackQueue,
        skipHackclub: hackclubBudgetExhausted || hackclubUnavailable,
      });
    };
    const routeNextAttempt = () => {
      if (routing.ownFirst) {
        // Own attempts first; the shared chain only after them, and only if the
        // user opted into it (otherwise the turn stops — see ByokExhaustedError).
        const own = nextOwnAttempt();
        if (own) {
          attempt = own;
          return;
        }
        if (routing.own.length > 0 && !routing.serviceFallback) {
          attempt = undefined;
          return;
        }
        attempt = nextSharedAttempt();
        return;
      }
      // Shared-first: kyto's models lead, and the user's own attempts are the
      // final fallback once the shared chain is exhausted.
      const shared = nextSharedAttempt();
      attempt = shared ?? nextOwnAttempt();
    };
    routeNextAttempt();
    logger.info(
      { model: attempt?.model, provider: attempt?.provider, threadId },
      '[agent] routed turn'
    );
    // The prompt for the NEXT attempt: the user's message, plus (on a fallback)
    // the tool results already gathered, plus (when the turn was cut off after
    // it had started talking) what the user has already been shown.
    const attemptPrompt = (isFallback: boolean): string => {
      const blocks = [messageText];
      if (visionDescription) {
        blocks.push(
          `The user attached image(s). A vision model looked at them and described them for you (you cannot see the raw pixels this turn):\n<attached_image_description>\n${visionDescription}\n</attached_image_description>`
        );
      }
      if (isFallback && gatheredResults.length > 0) {
        blocks.push(renderCarryover(gatheredResults));
      }
      if (isFallback && streamedText.trim().length > 0) {
        blocks.push(renderContinuation(streamedText));
      }
      return promptWithAttachments({
        attachments,
        text: blocks.join('\n\n'),
      });
    };

    while (attempt) {
      const currentAttempt = attempt;
      const modelTaskId = `model-${attempts.length}`;
      const modelTaskTitle =
        attempts.length > 0 ? 'Thinking · fallback' : 'Thinking';
      // Filled by streamAttempt's fetch with the resolved slug. The guard
      // completes the model task EXACTLY once (post-stream success or catch).
      const holder: ResolvedModelHolder = {};
      let modelTaskDone = false;
      const completeModelTask = (): StreamChunk | undefined => {
        if (modelTaskDone) {
          return;
        }
        modelTaskDone = true;
        // The model name is already shown as the in_progress `details` (below);
        // Slack keeps that line, so DON'T also send it as `output` here or the
        // card renders the model twice. Just mark the task complete.
        return {
          id: modelTaskId,
          status: 'complete',
          title: modelTaskTitle,
          type: 'task_update',
        };
      };
      // Per-attempt STALL watchdog: it fires only after ATTEMPT_TIMEOUT_MS of no
      // progress, aborting just THIS attempt so the catch below can recover
      // instead of the turn hanging forever. It is re-armed on every sign of
      // progress — a streamed text delta, a tool call, a tool result (see the
      // armWatchdog calls in the stream callbacks) — so a long-but-working turn
      // (e.g. a benchmark making a tool call every ~20s for 15 min) is NOT killed;
      // only a genuine stall is. (It used to be a fixed cap from attempt start,
      // which killed progressing long tasks and surfaced as "kyto hit an error
      // after it had already started responding".) Deliberately NOT reset by
      // reasoning tokens alone: a model that only "thinks" for the whole window
      // without acting is stuck and should trip. Kept separate from `controller`
      // so a timeout is NOT mistaken for a user interrupt; the combined signal
      // also reaches tool execution. The `wait` tool pushes the deadline out for
      // the length of a deliberate pause (up to an hour) on top of this.
      const attemptAbort = new AbortController();
      let attemptTimer: ReturnType<typeof setTimeout> | undefined;
      const armWatchdog = (ms: number) => {
        clearTimeout(attemptTimer);
        attemptTimer = setTimeout(() => {
          attemptAbort.abort(new AttemptTimeoutError(ms));
        }, ms);
      };
      armWatchdog(ATTEMPT_TIMEOUT_MS);
      // Grant the full idle budget on TOP of the pause, so the model still has
      // its normal working window once the wait is over.
      extendDeadline = (extraMs) => armWatchdog(ATTEMPT_TIMEOUT_MS + extraMs);
      // Per-ATTEMPT outcome (the turn-level flags above persist across attempts).
      // A continuation attempt inherits `producedText` from the interrupted one,
      // so "did THIS model answer?" has to be tracked separately or the fallback
      // would count its predecessor's text as its own and return silently.
      let attemptText = false;
      let attemptToolActivity = false;
      let attemptFinishReason: string | undefined;
      let attemptStreamError: StreamError | undefined;
      // Trips if THIS model stops answering and starts looping (see degenerate.ts).
      const repetition = createRepetitionGuard();
      let degenerated = false;
      // This attempt's reasoning. Per-attempt, so a model that failed or spiralled
      // takes its thinking down with it — only the attempt that ANSWERS gets to
      // leave its train of thought behind for the next turn (see thinking.ts).
      const attemptThinking: string[] = [];
      // Exactly what THIS attempt wrote as reply text, so a reply that turns out
      // to be nothing but a bare `skip` can be recognised and dropped once the
      // stream ends (see isBareSkipText). Kept whole rather than capped: it is
      // only read when it is short enough to be a bare token.
      let attemptRawText = '';
      const isFallback = attempts.length > 0;
      try {
        activeAttempt = currentAttempt;
        reply ??= createReply({ allowBroadcast: isOwner, threadId });
        logger.info(
          {
            attempt: attemptLog(currentAttempt),
            continuing: isFallback && streamedText.length > 0,
            index: attempts.length,
            threadId,
          },
          '[agent] attempt started'
        );
        // Surface the model in the thinking section: `in_progress` while this
        // attempt runs (showing the model it's about to run), completed exactly
        // once with the slug it actually resolved to. Yielded once in_progress
        // and once complete, so `details` never stacks.
        yield {
          details: currentAttempt.model,
          id: modelTaskId,
          status: 'in_progress',
          title: modelTaskTitle,
          type: 'task_update',
        };
        const attemptStart = Date.now();
        const result = streamAttempt({
          abortSignal: AbortSignal.any([
            controller.signal,
            attemptAbort.signal,
          ]),
          activeTools: built.activeTools,
          attempt: currentAttempt,
          holder,
          // Errors the SDK swallows into the stream would otherwise be dumped
          // raw to stderr by its default console.error handler, unattributed.
          getFreshImages: built.drainImages,
          images: modelImages,
          // An image the SDK's schema would reject is dropped rather than
          // allowed to invalidate the whole prompt. Log it: silently ignoring
          // someone's screenshot is confusing enough to be worth a line.
          onDroppedImages: (dropped) => {
            logger.warn(
              {
                attempt: attemptLog(currentAttempt),
                images: dropped.map((image) => ({
                  bytes: typeof image?.bytes,
                  mediaType: image?.mediaType,
                  path: image?.path,
                })),
                threadId,
              },
              '[agent] dropped unusable image(s) from the prompt'
            );
          },
          onError: (error) => {
            logger.error(
              {
                attempt: attemptLog(currentAttempt),
                err: errorMessage(error),
                status: errorStatus(error),
                threadId,
              },
              '[agent] provider error inside attempt stream'
            );
          },
          // A replayed gateway failure is invisible otherwise — the turn just
          // takes longer. Logged so a proxy sliding from flaky to dead is
          // readable in the journal before it starts costing fallbacks.
          onGatewayRetry: ({ delayMs, retry, status }) => {
            logger.warn(
              {
                attempt: attemptLog(currentAttempt),
                delayMs,
                retry,
                status,
                threadId,
              },
              '[agent] gateway failure, retrying the same request'
            );
          },
          prompt: attemptPrompt(isFallback),
          system: systemPrompt({ hints }),
          tools: built.tools,
        });
        for await (const chunk of renderStream({
          context: {
            ...attemptLog(currentAttempt),
            threadId,
          },
          // Reply text is yielded as strings (the message body) so streamSegmented
          // can split the plan on text→tool boundaries; onTextDelta only tracks
          // flags now — the actual posting happens in streamSegmented.
          emitText: true,
          knownTools,
          onSkip: () => {
            // A skip is a deliberate, successful "no reply".
            skipped = true;
          },
          onTextDelta: (text) => {
            producedText = true;
            attemptText = true;
            errorStage = 'after_text';
            attemptRawText += text;
            streamedText = appendStreamedText(streamedText, text);
            // Progress: reset the stall watchdog (see armWatchdog).
            armWatchdog(ATTEMPT_TIMEOUT_MS);
          },
          onReasoning: (text) => {
            attemptThinking.push(text);
          },
          onToolActivity: () => {
            attemptToolActivity = true;
            armWatchdog(ATTEMPT_TIMEOUT_MS);
          },
          onToolResult: (info) => {
            armWatchdog(ATTEMPT_TIMEOUT_MS);
            const key = `${info.toolName}:${stableInput(info.input)}`;
            if (gatheredKeys.has(key)) {
              return;
            }
            gatheredKeys.add(key);
            gatheredResults.push(info);
          },
          onFinish: (reason) => {
            attemptFinishReason = reason;
          },
          onError: (info) => {
            attemptStreamError ??= info;
            // A HackClub daily-spend-limit 429 dooms every HackClub rung.
            if (
              currentAttempt.provider === HACKCLUB_PROVIDER &&
              SPEND_LIMIT_PATTERN.test(info.message)
            ) {
              hackclubBudgetExhausted = true;
              spendLimitMessage = info.message;
            }
          },
          stream: result.fullStream,
        })) {
          if (typeof chunk === 'string') {
            // The model has stopped answering and started looping. Cut it off
            // here, BEFORE this chunk is yielded on to streamSegmented — that is
            // what keeps the loop out of the thread — and abort the attempt so
            // the turn is handed to a different model instead of shipping
            // "@devansh" three hundred times to a public channel.
            if (repetition.push(chunk)) {
              degenerated = true;
              attemptAbort.abort(
                new DegenerateOutputError(currentAttempt.model)
              );
              break;
            }
            // First VISIBLE reply text of this attempt: complete its Thinking
            // card NOW, in the current plan block, before streamSegmented splits
            // off a new block for any tools that run after the text. Otherwise
            // the model card would try to complete in a later block where its id
            // doesn't exist and the plan would show a perpetually spinning
            // Thinking. Whitespace-only fragments don't count (see isVisibleText).
            if (isVisibleText(chunk)) {
              const done = completeModelTask();
              if (done) {
                yield done;
              }
            }
          } else if (errorStage === 'before_output') {
            errorStage = 'after_progress';
          }
          yield chunk;
        }

        // The attempt ran right up to the agentic-step ceiling with a tool call
        // still pending — the job was cut off mid-work, not finished. This is one
        // of the "kyto stopped in the middle" shapes, so name it explicitly in
        // the journal instead of leaving a bare `tool-calls` finish reason that
        // reads like a normal step boundary. (Raise AGENT_MAX_STEPS if genuine
        // work keeps hitting it.)
        if (
          (holder.calls ?? 0) >= MAX_STEPS &&
          attemptFinishReason === 'tool-calls'
        ) {
          logger.warn(
            {
              attempt: attemptLog(currentAttempt),
              maxSteps: MAX_STEPS,
              steps: holder.calls,
              threadId,
            },
            '[agent] attempt hit the step ceiling with work still pending'
          );
        }

        if (degenerated) {
          // Drop whatever the loop already pushed into the reply buffer but that
          // Slack has not seen yet, and scrub it out of the text a continuation
          // attempt is shown — the next model must not read the loop as context.
          reply?.drop();
          streamedText = stripRepeatedLines(streamedText);
          throw new DegenerateOutputError(currentAttempt.model);
        }

        // The model wrote the word `skip` instead of calling the tool, and that
        // word is the entire reply. Honour what it meant: drop the buffered text
        // before Slack ever sees it (nothing is posted until flush, so the bare
        // token is still in the buffer here) and record a deliberate skip, which
        // keeps the turn "handled" AND suppresses the usage footer that used to
        // follow the stray `skip` message.
        if (
          attemptText &&
          isBareSkipText(attemptRawText) &&
          reply?.dropTail(attemptRawText)
        ) {
          streamedText = streamedText.slice(
            0,
            Math.max(0, streamedText.length - attemptRawText.length)
          );
          attemptText = false;
          producedText = streamedText.trim().length > 0;
          errorStage = producedText ? errorStage : 'after_progress';
          skipped = true;
          logger.info(
            { attempt: attemptLog(currentAttempt), threadId },
            '[agent] model wrote a bare "skip" instead of calling the tool; treating it as a skip'
          );
        }

        {
          const done = completeModelTask();
          if (done) {
            yield done;
          }
        }

        // The provider died PART WAY THROUGH this attempt. The SDK does not
        // throw for that: a step whose request fails (429, 5xx, dropped
        // connection) after its internal retries becomes an `error` part and the
        // stream just ends. If the model was still mid-task — it never finished
        // on a clean `stop` — then whatever it had already said is a half-finished
        // thought, and the old code called the turn "handled" and went quiet:
        // exactly the "kyto stopped in the middle" report. Raise it so the
        // fallback chain CONTINUES the turn on the next model.
        if (attemptStreamError && attemptFinishReason !== 'stop') {
          throw new StreamInterruptedError(
            `Model ${currentAttempt.model} died mid-task (${attemptStreamError.status ?? 'stream error'}): ${attemptStreamError.message}`,
            { cause: attemptStreamError.error }
          );
        }

        // A model that ran tools and then ended WITHOUT writing a reply leaves
        // the user staring at tool cards and nothing else — the other half of the
        // "stops in the middle" bug. Treating it as handled means silence;
        // treating it as a failure re-runs the whole turn on another model and
        // could repeat a side effect. So ask THIS model, once, to write up what
        // it already found — tools are off, so it can only produce prose, and
        // nothing can happen twice.
        //
        // This fires on ANY finish reason, not just a clean `stop`. The turns
        // that actually went silent ended on `length` (the reply was cut off
        // mid-tool-call by MAX_OUTPUT_TOKENS) or `tool-calls` (the MAX_STEPS cap
        // hit with a call still pending) — exactly the cases the old
        // `sawCleanStop` guard excluded, so they fell through to a fallback
        // cascade that re-ran the work and often died with no reply at all.
        if (!(attemptText || skipped) && attemptToolActivity) {
          yield* synthesizeFinalAnswer({
            attempt: currentAttempt,
            onText: (text) => {
              producedText = true;
              attemptText = true;
              errorStage = 'after_text';
              streamedText = appendStreamedText(streamedText, text);
            },
            results: gatheredResults,
            signal: AbortSignal.any([controller.signal, attemptAbort.signal]),
            system: systemPrompt({ hints }),
            task: messageText,
          });
        }

        // The model DID write a reply, but ran out of output budget partway
        // through it. `length` means the sentence stopped where the token cap
        // fell, not where the thought ended — observed as a turn that posted
        // "here is the link and a summary of what i found:" and then nothing at
        // all. Text had streamed, so the attempt counted as handled and the
        // turn closed on a dangling colon.
        //
        // Note this is NOT the same as the `length` finish the nudge above
        // handles: there the cap ate a tool call and no reply existed, here the
        // cap ate the reply itself. Ask the same model to carry on from what the
        // user was already shown, tools off so nothing can fire twice.
        if (attemptText && attemptFinishReason === 'length') {
          for (let round = 0; round < MAX_CONTINUATIONS; round += 1) {
            let continuationFinish: string | undefined;
            yield* continueTruncatedReply({
              attempt: currentAttempt,
              onFinish: (reason) => {
                continuationFinish = reason;
              },
              onText: (text) => {
                producedText = true;
                errorStage = 'after_text';
                streamedText = appendStreamedText(streamedText, text);
              },
              signal: AbortSignal.any([controller.signal, attemptAbort.signal]),
              streamedText,
              system: systemPrompt({ hints }),
              task: messageText,
            });
            // Whatever it just wrote fit — the reply is complete.
            if (continuationFinish !== 'length') {
              break;
            }
          }
        }

        // Reply text from THIS attempt, or a deliberate skip, counts as handled.
        // (Not the turn-level `producedText`: a continuation attempt inherits it
        // from the interrupted attempt, and would otherwise report success while
        // contributing nothing.) Anything else — including tool activity whose
        // synthesis nudge above came back empty — falls back to another model,
        // which replays the gathered tool results via renderCarryover rather than
        // re-running them.
        const handled = attemptText || skipped;
        if (!handled) {
          throw new Error(
            attemptToolActivity
              ? `Model ${currentAttempt.model} ran tools but ended without a reply (truncated synthesis step).`
              : `Model ${currentAttempt.model} returned an empty response.`
          );
        }
        handledSteps = holder.calls;
        logger.info(
          {
            attempt: attemptLog(currentAttempt),
            durationMs: Date.now() - attemptStart,
            outcome: skipped ? 'skip' : 'text',
            steps: holder.calls,
            threadId,
          },
          '[agent] attempt handled the turn'
        );
        // Leave this turn's train of thought behind for the next one. Only the
        // attempt that actually answered gets to: a failed attempt's reasoning
        // died with it, and feeding a spiral back in would only seed another.
        // Persisted (best-effort) so it survives a restart.
        await rememberThinking({
          blocks: attemptThinking,
          observations: renderObservations(gatheredResults),
          threadId,
        });
        // A user's own key/account that just answered a whole turn is
        // demonstrably valid (each recorder no-ops unless the attempt is theirs).
        await recordByokOutcome({
          attempt: currentAttempt,
          userId: turnMessage.author.userId,
        });
        await recordChatgptOutcome({
          attempt: currentAttempt,
          userId: turnMessage.author.userId,
        });
        // Capture usage for the footer (best-effort; never fails the turn), and
        // the cache split for the journal — prompt caching is the thing keeping
        // HackClub's $3/day affordable, and until this was recorded there was no
        // way to tell a working cache from a silently broken one except the bill.
        {
          const usage = await Promise.resolve(result.usage).catch(
            () => undefined
          );
          turnUsage = {
            cacheReadTokens: usage?.inputTokenDetails?.cacheReadTokens,
            cacheWriteTokens: usage?.inputTokenDetails?.cacheWriteTokens,
            inputTokens: usage?.inputTokens,
          };
          const outputTokens = usage?.outputTokens ?? usage?.totalTokens;
          const elapsedSeconds = (Date.now() - attemptStart) / 1000;
          if (attemptText && outputTokens && elapsedSeconds > 0) {
            usageFooter = {
              outputTokens,
              tokensPerSecond: outputTokens / elapsedSeconds,
            };
          }
        }
        return;
      } catch (error) {
        {
          const done = completeModelTask();
          if (done) {
            yield done;
          }
        }
        attempts.push({ attempt: currentAttempt, error });
        failedKeys.add(attemptKey(currentAttempt));
        // The prompt kyto BUILT is malformed — the SDK refused it before any
        // request went out, so every remaining rung would fail identically and
        // instantly. Stop the walk here rather than spending the shared daily
        // cap proving a bug in our own prompt assembly three more times.
        if (isPromptConstructionError(error)) {
          logger.error(
            {
              attempt: attemptLog(currentAttempt),
              err: errorMessage(error),
              errorDetail: clamp(deepErrorText(error), ERROR_LOG_MAX_LENGTH),
              // Which message is malformed (roles + content SHAPE, no text) —
              // this is the line that says WHY assembly failed.
              promptShape: describeMalformedPrompt(error),
              threadId,
            },
            '[agent] prompt construction failed; this is a kyto bug, not a model failure — not falling back'
          );
          throw error;
        }
        // Mark the user's key/account invalid only if the PROVIDER rejected it
        // (401/402/403) — a rate limit or an outage says nothing about it. Each
        // recorder no-ops unless the failed attempt is theirs.
        await recordByokOutcome({
          attempt: currentAttempt,
          error,
          userId: turnMessage.author.userId,
        });
        await recordChatgptOutcome({
          attempt: currentAttempt,
          error,
          userId: turnMessage.author.userId,
        });
        // Also catch a spend limit that surfaced as a THROWN error (not a stream
        // error part) — same effect as onError: write off the tier rather than
        // walking the rest of it one doomed rung at a time.
        if (currentAttempt.provider === HACKCLUB_PROVIDER) {
          if (SPEND_LIMIT_PATTERN.test(thrownErrorText(error))) {
            hackclubBudgetExhausted = true;
            spendLimitMessage ??= thrownErrorText(error);
          } else if (condemnsHackclub(errorStatus(error))) {
            // A non-budget HackClub failure that the PROXY reported (it has an
            // HTTP status) and that isn't a per-request gateway drop. Enough of
            // these means the proxy is down, not just this one model, so bail
            // off HackClub entirely. A model-level fault kyto raised itself
            // (empty response, degenerate loop) has no status, and a 504 is a
            // lost request rather than a dead tier — neither may condemn it.
            // See HACKCLUB_OUTAGE_THRESHOLD.
            hackclubFailures += 1;
            if (hackclubFailures >= HACKCLUB_OUTAGE_THRESHOLD) {
              hackclubUnavailable = true;
            }
          }
        }
        routeNextAttempt();
        const retryAttempt = attempt;
        // A turn that already streamed reply text normally must NOT fall back —
        // the next model would restate the answer and the user would read it
        // twice. Three exceptions: a provider that died mid-task (kyto was cut
        // off mid-sentence, so silence is the worse outcome), a model that
        // degenerated into a loop (what it "said" is not an answer at all), and
        // a model that STALLED (the watchdog tripped — it is just as cut off as
        // a provider that died, only quieter about it). In all three, the next
        // model is told what was already sent (renderContinuation, scrubbed of
        // the loop) and picks the work back up instead of starting over.
        //
        // The stall case is why an 11-minute turn ended on "kyto hit an error
        // after it had already started responding": four rungs in, deepseek-v4-pro
        // went idle, the watchdog aborted it, and because text had streamed
        // earlier in the turn this guard threw instead of handing over — with
        // fifteen healthy models still left in the queue.
        const canContinue =
          error instanceof StreamInterruptedError ||
          error instanceof DegenerateOutputError ||
          error instanceof AttemptTimeoutError;
        if (controller.signal.aborted || (producedText && !canContinue)) {
          throw error;
        }
        if (!retryAttempt) {
          // The user's own attempts were the only path allowed and they're
          // spent: say so plainly instead of a generic failure, since only they
          // can fix it (and they explicitly did NOT opt into the shared budget).
          // Only meaningful in own-first mode; in shared-first the shared chain
          // has already run.
          if (
            routing.ownFirst &&
            routing.own.length > 0 &&
            !routing.serviceFallback
          ) {
            throw new ByokExhaustedError(errorMessage(error), { cause: error });
          }
          if (hackclubBudgetExhausted) {
            throw new BudgetExhaustedError(spendLimitMessage, { cause: error });
          }
          throw error;
        }
        logger.warn(
          {
            attempt: attemptLog(currentAttempt),
            continuing: canContinue && producedText,
            err: errorMessage(error),
            errorDetail: clamp(deepErrorText(error), ERROR_LOG_MAX_LENGTH),
            nextAttempt: attemptLog(retryAttempt),
            status: errorStatus(error),
            threadId,
          },
          '[agent] attempt failed, falling back'
        );
        attempt = retryAttempt;
      } finally {
        clearTimeout(attemptTimer);
      }
    }
  }

  // Drive the turn as a SEQUENCE of streamed plan messages instead of one. A
  // "segment" is one collapsible plan block (its task cards) followed by any
  // reply text; the FIRST task card that arrives AFTER text has streamed opens a
  // NEW plan block below that text. So a turn that writes some text, runs more
  // tools, then writes more renders as [plan] text [plan] text — the model can
  // post an in-between update and keep working in a fresh block, instead of
  // every tool of the whole turn piling into one plan pinned above all the text.
  async function streamSegmented({
    message: turnMessage,
    thread: turnThread,
  }: {
    message: Message;
    thread: ThreadHandle;
  }): Promise<void> {
    const source = renderTurn({
      message: turnMessage,
      thread: turnThread,
    })[Symbol.asyncIterator]();
    // The model stream is the only source of this turn's cards: a subagent
    // streams its OWN plan message (see tools/subagent.ts), so nothing races
    // against this iterator.
    const nextRendered = (): Promise<IteratorResult<string | StreamChunk>> =>
      source.next();
    let pending = await nextRendered();
    while (!pending.done) {
      // Reply text before any plan block of this segment (a pure-text turn, or
      // text trailing the previous block) is just posted — no empty plan.
      if (typeof pending.value === 'string') {
        await reply?.append({ text: pending.value, thread: turnThread });
        pending = await nextRendered();
        continue;
      }
      // One plan block: task cards until reply text streams, then the next task
      // card ends this block (left on `pending` for the next iteration). The
      // rule itself lives in lib/agent/segmentation, where it has tests.
      const segmenter = createSegmenter();
      const segment = async function* (): AsyncGenerator<StreamChunk> {
        while (!pending.done) {
          const value = pending.value;
          const action = segmenter.next(value);
          if (action === 'append') {
            await reply?.append({ text: value as string, thread: turnThread });
            pending = await nextRendered();
            continue;
          }
          if (action === 'split') {
            return;
          }
          yield value as StreamChunk;
          pending = await nextRendered();
        }
      };
      await slack.stream(threadId, segment(), {
        recipientTeamId: slack.teamId ?? '',
        recipientUserId: turnMessage.author.userId,
        taskDisplayMode: 'plan',
      });
      // Post any buffered text before the next plan block is created, so the
      // ordering (plan → text → plan) holds.
      await reply?.flush({ thread: turnThread });
    }
  }
}

// Fold an error's message + provider responseBody/data into one string so the
// spend-limit pattern can match text (e.g. "Daily spending limit of $3 reached")
// that lives in responseBody rather than the error message.
const thrownErrorText = deepErrorText;

/**
 * The prompt-token split for one turn, as a log field — or undefined when the
 * provider reported no cache detail at all, so a missing `cache` in the journal
 * reads as "the provider said nothing", not "nothing was cached".
 */
function cacheLog(
  usage:
    | {
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        inputTokens?: number;
      }
    | undefined
) {
  if (
    usage?.cacheReadTokens === undefined &&
    usage?.cacheWriteTokens === undefined
  ) {
    return;
  }
  return {
    input: usage.inputTokens,
    read: usage.cacheReadTokens ?? 0,
    write: usage.cacheWriteTokens ?? 0,
  };
}

function attemptLog(attempt: ModelAttempt | undefined) {
  return attempt
    ? { model: attempt.model, provider: attempt.provider }
    : undefined;
}

// The whole fallback walk on one line: which models were tried, and the real
// upstream reason each one died. This is what turns "kyto went quiet" into a
// diagnosable event without reading the Slack thread.
function failedAttemptsLog(attempts: AttemptFailure[]) {
  return attempts.map((failed) => ({
    err: errorMessage(failed.error),
    model: failed.attempt.model,
    provider: failed.attempt.provider,
    status: errorStatus(failed.error),
  }));
}

const TOK_PER_SEC_DECIMAL_BELOW = 10;

// Post the per-turn usage footer as a muted Slack context block under the
// reply. Best-effort — a failure here never affects the answer.
async function postUsageFooter({
  footer,
  thread,
}: {
  footer: { outputTokens: number; tokensPerSecond: number };
  thread: ThreadHandle;
}): Promise<void> {
  const rate =
    footer.tokensPerSecond < TOK_PER_SEC_DECIMAL_BELOW
      ? footer.tokensPerSecond.toFixed(1)
      : Math.round(footer.tokensPerSecond).toString();
  const text = `${footer.outputTokens.toLocaleString('en-US')} tokens · ${rate} tok/s`;
  await thread
    .post({
      blocks: [{ elements: [{ text, type: 'mrkdwn' }], type: 'context' }],
      fallbackText: text,
    })
    .catch(() => undefined);
}

/**
 * Last resort against a silent turn: the model ran its tools and stopped
 * without saying anything. Re-ask the SAME model with NO tools, so all it can
 * do is write up what it already found. Streams straight into the live reply.
 *
 * Deliberately cheap and contained: one call, tools off (so no side effect can
 * fire twice), and any failure is swallowed — the caller falls back to the next
 * model, which will replay the same gathered results via renderCarryover.
 */
async function* synthesizeFinalAnswer({
  attempt,
  onText,
  results,
  signal,
  system,
  task,
}: {
  attempt: ModelAttempt;
  onText: (text: string) => void;
  results: GatheredResult[];
  signal: AbortSignal;
  system: string;
  task: string;
}): AsyncGenerator<string | StreamChunk> {
  logger.info(
    { model: attempt.model },
    '[agent] tools ran but no reply; nudging for a final answer'
  );
  const gathered =
    results.length > 0
      ? `\n\n${renderCarryover(results)}`
      : '\n\n(No tool results were captured.)';
  const prompt = `${task}${gathered}\n\nYou already did the work above but never answered. Write the final reply to the user now, from those results. Do not mention this instruction.\n\n${NO_TOOLS_NOTICE}`;
  try {
    const result = streamAttempt({
      abortSignal: signal,
      attempt,
      // Nothing reads the resolved model back off a nudge.
      holder: {},
      prompt,
      system,
      tools: {},
    });
    yield* renderStream({
      emitText: true,
      knownTools: new Set<string>(),
      onTextDelta: onText,
      stream: result.fullStream,
    });
  } catch (error) {
    logger.warn(
      { err: errorMessage(error), model: attempt.model },
      '[agent] synthesis nudge failed'
    );
  }
}

/**
 * Resume a reply that MAX_OUTPUT_TOKENS cut off mid-sentence. Same model, tools
 * off — the work is already done and the only thing missing is the rest of the
 * prose, so nothing here can repeat a side effect. Bounded by MAX_CONTINUATIONS
 * because a model that keeps producing exactly one cap's worth of text every
 * round would otherwise never terminate.
 */
async function* continueTruncatedReply({
  attempt,
  onFinish,
  onText,
  signal,
  streamedText,
  system,
  task,
}: {
  attempt: ModelAttempt;
  onFinish: (reason: string) => void;
  onText: (text: string) => void;
  signal: AbortSignal;
  streamedText: string;
  system: string;
  task: string;
}): AsyncGenerator<string | StreamChunk> {
  logger.info(
    { model: attempt.model },
    '[agent] reply hit the output cap mid-sentence; continuing it'
  );
  const prompt = `${task}\n\n${renderTruncation(streamedText)}`;
  try {
    const result = streamAttempt({
      abortSignal: signal,
      attempt,
      holder: {},
      prompt,
      system,
      tools: {},
    });
    yield* renderStream({
      emitText: true,
      knownTools: new Set<string>(),
      onFinish,
      onTextDelta: onText,
      stream: result.fullStream,
    });
  } catch (error) {
    logger.warn(
      { err: errorMessage(error), model: attempt.model },
      '[agent] truncated-reply continuation failed'
    );
  }
}

/** The tail the model must resume from, kept short — it only needs the seam. */
const TRUNCATION_TAIL_CHARS = 2000;

/**
 * Both wrap-up calls below run with `tools: {}` on purpose — the work is already
 * done and nothing may fire a second time. But the system prompt still describes
 * a full toolset, so a model that isn't TOLD spends the whole call trying to use
 * it: an observed turn burned its budget on "getFile isn't available… loadTools
 * isn't available either… No tools available? That's strange", reasoning about a
 * broken environment instead of writing the two sentences it was asked for.
 */
const NO_TOOLS_NOTICE =
  'You have NO TOOLS for this message — every tool has been switched off deliberately, and that is not an error or a broken environment. Do not try to call one, do not comment on their absence, and do not plan work that would need one. Answer from what is already in front of you; if something is genuinely missing, say so in one short sentence and stop.';

function renderTruncation(streamedText: string): string {
  const tail = streamedText.trim().slice(-TRUNCATION_TAIL_CHARS);
  return [
    'IMPORTANT: you were cut off. You already did the work, and the user has ALREADY been shown the reply text below, which stops mid-thought because it hit the output limit:',
    '',
    tail,
    '',
    NO_TOOLS_NOTICE,
    '',
    'Write ONLY the continuation, starting exactly where that stops. Do not repeat any of it, do not restate the task, do not re-introduce yourself, and do not apologise or mention being cut off. If it broke off mid-sentence, finish that sentence. Keep it short.',
  ].join('\n');
}
