import { isPromptConstructionError } from '@/lib/agent/routing';
import { errorMessage } from '@/lib/utils/error';
import type { AgentErrorStage } from '@/types/agent';

// Thrown when a turn fails after HackClub returned the daily-spend-limit 429 AND
// every fallback (cheaper HackClub rungs, then baishui) also failed — i.e. the
// daily budget is the root cause, not a transient provider error. Carries the
// raw 429 text (e.g. "Daily spending limit of $3 reached") so the user-facing
// message can name the actual dollar amount.
export class BudgetExhaustedError extends Error {
  constructor(detail?: string, options?: { cause?: unknown }) {
    super(detail ?? 'Daily model spending limit reached.', options);
    this.name = 'BudgetExhaustedError';
  }
}

/**
 * The provider died in the middle of a multi-step attempt. The AI SDK does not
 * throw for this: a step that fails after its internal retries is emitted as an
 * `error` part and the stream simply ends. If the model had already streamed
 * reply text, the turn used to look "handled" and kyto went quiet mid-task with
 * no error anywhere except a raw SDK blob on stderr.
 *
 * Raising it turns that silence into a real failure, which lets the fallback
 * chain CONTINUE the turn on the next model (the one case where a turn that
 * already produced text is allowed to fall back — see renderContinuation).
 */
export class StreamInterruptedError extends Error {
  constructor(detail: string, options?: { cause?: unknown }) {
    super(detail, options);
    this.name = 'StreamInterruptedError';
  }
}

/**
 * The model fell into a token loop: it stopped answering and started repeating
 * itself (the same line, or the same phrase, over and over). Formally this is
 * reply text, so the old loop counted it as a handled turn and posted it —
 * `nvidia/nemotron-3-ultra-550b-a55b` streamed "@devansh" several hundred times
 * into a public thread that way.
 *
 * Repetition is not an answer. The guard raises this as soon as it trips, which
 * aborts the attempt, keeps the loop out of Slack, and falls back to another
 * model — one of the two cases (with StreamInterruptedError) where a turn that
 * already streamed text is still allowed to fall back.
 */
export class DegenerateOutputError extends Error {
  constructor(model: string, options?: { cause?: unknown }) {
    super(
      `Model ${model} started repeating itself instead of answering.`,
      options
    );
    this.name = 'DegenerateOutputError';
  }
}

/**
 * The acting user brought their own model key(s), every one of them failed, and
 * they did NOT opt into spending the shared service budget as a backstop. Only
 * they can fix it, so the message points at their App Home tab rather than
 * reading as a kyto outage.
 */
export class ByokExhaustedError extends Error {
  constructor(detail?: string, options?: { cause?: unknown }) {
    super(detail ?? 'Your model key failed.', options);
    this.name = 'ByokExhaustedError';
  }
}

const SPEND_AMOUNT_PATTERN = /\$\d+(?:\.\d+)?/;

const SECONDS_PER_DAY = 86_400;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_MINUTE = 60;

// The HackClub daily spend limit resets at **UK midnight** (Europe/London, so
// the reset tracks BST/GMT automatically). Compute the time left until the next
// London midnight purely from the current London wall-clock — independent of the
// host timezone and of the current UTC offset (correct except across the rare
// DST-transition night, which is close enough for a "try again in ~Xh Ym" hint).
function timeUntilUkReset(now: Date = new Date()): {
  hours: number;
  minutes: number;
} {
  const parts = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'Europe/London',
  }).formatToParts(now);
  const partValue = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  // en-GB renders midnight as "24" in the hour-only slot; normalize to 0.
  const hour = partValue('hour') % 24;
  const elapsed =
    hour * SECONDS_PER_HOUR +
    partValue('minute') * SECONDS_PER_MINUTE +
    partValue('second');
  const remaining = (SECONDS_PER_DAY - elapsed) % SECONDS_PER_DAY;
  return {
    hours: Math.floor(remaining / SECONDS_PER_HOUR),
    minutes: Math.floor((remaining % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE),
  };
}

const CREDIT_ERROR_PATTERN =
  /\b(credit|credits|quota|daily limit|requires more credits)\b/i;
const CONTEXT_ERROR_PATTERN =
  /\b(max_tokens|maximum context|context length|too many tokens)\b/i;
const PROVIDER_TIMEOUT_PATTERN =
  /\b(5\d\d|gateway time-out|gateway timeout|cloudflare|timeout occurred|origin_response_timeout)\b/i;

export function agentErrorMessage({
  error,
  stage = 'before_output',
}: {
  error: unknown;
  stage?: AgentErrorStage;
}): string {
  const message = errorMessage(error);
  // Budget exhaustion is the real cause regardless of how far the turn got, so
  // it wins over the stage-based messages. Name the daily cap when the 429 text
  // carried it. Deliberately does NOT explain the proxy's pessimistic limit
  // accounting — just that the daily budget is spent.
  // The user's own key is the root cause and only they can fix it, so this wins
  // over the stage-based messages too. Deliberately does not quote the
  // provider's raw rejection into a possibly-public channel — the detail lives
  // in their App Home tab, where only they can see it.
  if (error instanceof ByokExhaustedError) {
    return "_kyto couldn't run this on your own model key — every key you added failed. check the Model keys section of kyto's App Home tab for what the provider said, or turn on shared-model fallback there._";
  }
  if (error instanceof BudgetExhaustedError) {
    const amount = message.match(SPEND_AMOUNT_PATTERN)?.[0] ?? '$3';
    const { hours, minutes } = timeUntilUkReset();
    return `_kyto's daily model budget (${amount}/day) is used up — every model is out of credits for today. it resets at UK midnight, in ${hours}h ${minutes}m._`;
  }
  // Kyto assembled a prompt the SDK refuses to send. No model ever saw it, so
  // "the provider failed" would be a lie and "try again" is useless advice —
  // the same thread state rebuilds the same broken prompt. Say what it is.
  if (isPromptConstructionError(error)) {
    return '_kyto built a malformed prompt for this turn and could not send it — that is a bug in kyto, not a model outage. starting a new thread works around it._';
  }
  if (stage === 'after_text') {
    return '_kyto hit an error after it had already started responding. the reply above may be partial; send a follow-up and kyto can continue from the current thread state._';
  }
  if (stage === 'after_progress') {
    return '_kyto hit an error after it had already shown progress. the task rows above show what completed; send a follow-up and kyto can continue from the current thread state._';
  }
  if (CREDIT_ERROR_PATTERN.test(message)) {
    return '_kyto is out of model credits for this request. try again later or ask for a shorter/smaller result._';
  }
  if (CONTEXT_ERROR_PATTERN.test(message)) {
    return '_that request is too large for the current model budget. try a shorter prompt or start a new thread._';
  }
  if (PROVIDER_TIMEOUT_PATTERN.test(message)) {
    return '_kyto hit a model provider timeout. try again in a bit, or send a shorter follow-up so kyto can continue from the current thread state._';
  }
  return '_oops, something went wrong._';
}
