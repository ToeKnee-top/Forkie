// The pure half of the thinking cache: how much of each past turn's record is
// worth carrying, and how it is rendered into the prompt. Split out of
// thinking.ts (which owns the Postgres IO) so these rules can be tested — they
// decide real money, because this block rides in EVERY turn's prompt against a
// shared $3/day cap.

// The whole block's ceiling. ~60k chars ≈ 15k tokens: generous, but capped so a
// long thread's thinking can't crowd out the replayed Slack history.
export const THINKING_BUDGET_CHARS = 60_000;

// Per-turn ceiling at the moment a turn is STORED, so one pathological turn
// can't eat the whole budget. Decay below shrinks it further on the way out.
export const MAX_TURN_CHARS = 20_000;

// A turn is never decayed below this: past a point a fragment stops being a
// memory and starts being a riddle.
const MIN_TURN_CHARS = 1500;

// How much of a turn survives, by age. Index 0 is the most recent turn.
//
// The newest turn is kept whole — it is what "pick up where you left off" means.
// Older turns decay fast, because what stays useful from them is the CONCLUSION
// (which lives at the tail), not the tool output that led there. Before this,
// every turn rode along at full length forever: turn 10 of a thread re-sent nine
// turns of complete tool output, unchanged, on every request.
const DECAY = [1, 0.5, 0.25] as const;
const OLDEST_SHARE = 0.125;

/** The char allowance for a turn `age` turns back (0 = most recent). */
export function allowanceForAge(age: number): number {
  const share = DECAY[age] ?? OLDEST_SHARE;
  return Math.max(MIN_TURN_CHARS, Math.round(MAX_TURN_CHARS * share));
}

/**
 * Keep the last `max` chars. Truncation is from the FRONT on purpose: a turn's
 * tail is where it worked out what was going on, and the head is the tool output
 * it was reasoning from. The marker is left in so the model can tell the
 * difference between "this turn was short" and "you are seeing the end of it".
 */
export function tail(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `[…earlier detail from this turn has been dropped]\n${text.slice(-max)}`;
}

/**
 * Given all stored turns (oldest→newest), decay each by age and keep the newest
 * that fit the char budget, oldest first. The most recent turn is always kept
 * even if it alone exceeds the budget.
 */
export function selectWithinBudget(
  turns: string[],
  budget: number = THINKING_BUDGET_CHARS
): string[] {
  const kept: string[] = [];
  let used = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn === undefined) {
      continue;
    }
    const age = turns.length - 1 - index;
    const decayed = tail(turn, allowanceForAge(age));
    const cost = decayed.length + 2;
    if (used + cost > budget && kept.length > 0) {
      break;
    }
    kept.push(decayed);
    used += cost;
  }
  return kept.reverse();
}

/**
 * The block buildPrompt injects. Framed hard, because the failure mode of
 * showing a model its own past reasoning is that it narrates or re-litigates it
 * instead of moving on.
 */
export function renderThinking(
  turns: string[],
  budget: number = THINKING_BUDGET_CHARS
): string {
  const selected = selectWithinBudget(turns, budget);
  if (selected.length === 0) {
    return '';
  }
  const rendered = selected.map((turn, index) => {
    const ago = selected.length - index;
    const label = ago === 1 ? 'your previous turn' : `${ago} turns ago`;
    return `[${label}]\n${turn}`;
  });
  return [
    '<your_previous_thinking>',
    'Your own private reasoning AND what your tools returned in earlier turns in THIS thread, oldest first. Nobody in Slack can see it — Slack only kept what you said out loud, so this is the only way you still have your train of thought and the facts your tools uncovered (a value you computed, a captcha you decoded, an OCR result) but never typed into a message.',
    'Older turns are abbreviated to their tails; if you need detail that was dropped, re-run the tool rather than guessing at it.',
    'Use it to pick up where you left off: what you already tried, ruled out, were part-way through, or found. Do NOT narrate it, quote it, or apologise for it — it is a memory, not something the user said.',
    '',
    ...rendered,
    '</your_previous_thinking>',
  ].join('\n');
}
