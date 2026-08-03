import { clamp } from '@/lib/utils/text';

// What a fallback model is told about the work the previous attempt already did.
// Split out of the agent loop so the invariants have tests: these blocks are the
// entire reason a cross-model handoff continues a turn instead of restarting it,
// and their wording is load-bearing prompt text, not decoration.

export interface GatheredResult {
  input: unknown;
  output: unknown;
  toolName: string;
}

// Bounds on the replayed carryover so a fallback prompt can't blow up context
// (web-search results are large): keep the most recent results and clamp each.
export const CARRYOVER_MAX_RESULTS = 12;
export const CARRYOVER_OUTPUT_MAX = 1500;
export const CARRYOVER_INPUT_MAX = 400;

// Bounds on the tool observations persisted into the thinking store, kept
// smaller than the carryover so reasoning + observations both fit the per-turn
// thinking budget (MAX_TURN_CHARS). Keeps the most recent results.
export const OBSERVATION_MAX_RESULTS = 14;
export const OBSERVATION_OUTPUT_MAX = 1000;
export const OBSERVATION_INPUT_MAX = 300;

/** A stable string for a tool input, used both for rendering and for dedupe. */
export function stableInput(input: unknown): string {
  try {
    return typeof input === 'string' ? input : JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function toCompactText(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : stableInput(value);
  return clamp(text, max) ?? text;
}

/**
 * Tell a fallback model that the turn is already IN PROGRESS in Slack: the
 * previous model streamed this text to the user before its provider died
 * mid-task. Without this the continuation model restates the whole answer and
 * the user reads it twice.
 */
export function renderContinuation(streamedText: string): string {
  return [
    'IMPORTANT: this turn is already in progress. The user has ALREADY been shown the following reply text, and the model writing it was cut off mid-task by a provider failure:',
    '',
    streamedText.trim(),
    '',
    'Pick up exactly where that left off and finish the job. Do NOT repeat what was already said, do not re-introduce yourself, and do not start the task over — continue it.',
  ].join('\n');
}

/**
 * A compact record of what this turn's tools returned, persisted alongside the
 * reasoning so the NEXT turn can recall a fact kyto observed but never typed into
 * Slack (a decoded captcha, an OCR result, a computed value). Empty string when
 * the turn ran no tools.
 */
export function renderObservations(results: GatheredResult[]): string {
  if (results.length === 0) {
    return '';
  }
  return results
    .slice(-OBSERVATION_MAX_RESULTS)
    .map((result) => {
      const input = toCompactText(result.input, OBSERVATION_INPUT_MAX);
      const output = toCompactText(result.output, OBSERVATION_OUTPUT_MAX);
      return `${result.toolName}(${input}) → ${output}`;
    })
    .join('\n');
}

/**
 * Render gathered tool results as a prompt block the fallback model can answer
 * from without re-running the tools. Most recent results win when over the cap —
 * a turn that fell back nine searches deep must not hand the next model the
 * first nine and none of the recent ones.
 */
export function renderCarryover(results: GatheredResult[]): string {
  const recent = results.slice(-CARRYOVER_MAX_RESULTS);
  const lines = recent.map((result, index) => {
    const input = toCompactText(result.input, CARRYOVER_INPUT_MAX);
    const output = toCompactText(result.output, CARRYOVER_OUTPUT_MAX);
    return `${index + 1}. ${result.toolName}(${input})\n${output}`;
  });
  return [
    'A previous attempt already ran these tools and got these results. Use them to answer directly — do NOT re-run the same tools:',
    '',
    ...lines,
  ].join('\n');
}
