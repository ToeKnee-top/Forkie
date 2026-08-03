import {
  clearThreadThinking,
  getThreadThinking,
  pruneThreadThinking,
  saveThreadThinking,
} from '@repo/db/queries';
import {
  THINKING_BUDGET_CHARS as DEFAULT_THINKING_BUDGET_CHARS,
  MAX_TURN_CHARS,
  renderThinking as renderThinkingBlock,
  tail,
} from '@/lib/agent/thinking-render';
import logger from '@/lib/logger';

// Kyto's memory of a conversation is the Slack thread itself (buildPrompt
// replays it). But Slack only records what was SAID — the reasoning that led to
// it is rendered into the plan's "Thinking" cards and then gone. So every turn
// used to start cold: kyto could see that it had said "let me check all 50
// slider positions" but not why, what it had already ruled out, or what it was
// part-way through. It re-derived the same dead ends.
//
// This keeps the FULL reasoning (and tool observations) of a thread's turns and
// buildPrompt feeds it back on the next turn — the whole history, oldest dropped
// only when the block would exceed a char budget (see THINKING_BUDGET_CHARS).
// PERSISTED to Postgres (thread_thinking) so it survives a restart — the old
// in-memory buffer was wiped on every deploy, which is why a thread picked back
// up after a restart lost its train of thought. Rows are reaped after
// RETENTION_MS so this stays a recent train of thought, not a permanent
// transcript.

// The model carries its reasoning across turns, the way it carries reasoning
// across tool calls WITHIN a turn: the end of a turn is just another boundary.
// How much of each past turn survives — and the whole block's ceiling — is
// decided by thinking-render.ts, which is pure and has tests.
const THINKING_BUDGET_CHARS = numericEnv(
  'THINKING_BUDGET_CHARS',
  DEFAULT_THINKING_BUDGET_CHARS
);
// Hard cap on how many turns are kept on disk, so a very long-lived thread's row
// stays bounded regardless of the char budget. Rendering trims further to fit.
const MAX_STORED_TURNS = 40;

function numericEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
// How long a thread's stored reasoning stays usable and on disk (~a month).
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Record one completed turn's reasoning AND what its tools observed. Called with
 * the reasoning blocks and tool observations of the attempt that actually
 * ANSWERED — a failed attempt's thinking is discarded with the attempt, so a
 * model that spiralled doesn't poison the next turn.
 *
 * Slack replays only what kyto SAID, never what it thought or what a tool
 * returned — so a fact kyto worked out but never typed (a captcha it decoded, an
 * OCR result, a computed value) is otherwise lost the moment the turn ends. Both
 * halves ride back into the next turn via buildPrompt.
 *
 * Best-effort: a DB hiccup here must never fail the turn.
 */
export async function rememberThinking({
  blocks,
  observations,
  threadId,
}: {
  blocks: string[];
  /** Pre-rendered, already-clamped summary of the turn's tool results. */
  observations?: string;
  threadId: string;
}): Promise<void> {
  const reasoning = blocks
    .map((block) => block.trim())
    .filter(Boolean)
    .join('\n\n');
  const trimmedObservations = observations?.trim();
  const text = [
    reasoning,
    trimmedObservations
      ? `[what your tools returned this turn]\n${trimmedObservations}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  if (!text) {
    return;
  }
  try {
    const existing = await getThreadThinking(threadId, RETENTION_MS);
    const turns = [...existing, tail(text, MAX_TURN_CHARS)].slice(
      -MAX_STORED_TURNS
    );
    await saveThreadThinking(threadId, turns);
  } catch (error) {
    logger.warn({ err: error, threadId }, '[thinking] failed to persist');
  }
}

/** The stored reasoning of this thread's turns, oldest first (render trims to
 * the char budget). */
export async function recallThinking(threadId: string): Promise<string[]> {
  return await getThreadThinking(threadId, RETENTION_MS).catch(() => []);
}

/** Forget a thread's train of thought (a new turn is starting from scratch). */
export async function forgetThinking(threadId: string): Promise<void> {
  await clearThreadThinking(threadId).catch(() => undefined);
}

// Reap reasoning older than the retention window, on startup and daily after.
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function pruneThinking(): Promise<void> {
  await pruneThreadThinking(new Date(Date.now() - RETENTION_MS)).catch(
    (error: unknown) => {
      logger.warn({ err: error }, '[thinking] prune failed');
    }
  );
}

export function startThinkingReaper(): void {
  const tick = (): void => {
    pruneThinking().catch(() => undefined);
  };
  setInterval(tick, PRUNE_INTERVAL_MS);
  tick();
}

/**
 * The block buildPrompt injects. The decay rules and the framing live in
 * thinking-render.ts (pure, tested); this only supplies the env-overridable
 * budget.
 */
export function renderThinking(turns: string[]): string {
  return renderThinkingBlock(turns, THINKING_BUDGET_CHARS);
}
