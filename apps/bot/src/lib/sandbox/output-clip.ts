/**
 * Clipping long tool output so the model KNOWS it was clipped.
 *
 * The old behaviour was `clamp(text, 12_000)` — a hard cut with a bare `…`
 * appended and nothing else. That is indistinguishable from the output simply
 * ending, and it produced a confidently wrong answer in public: asked which
 * models the HackClub proxy serves, kyto ran `curl …/v1/models | jq .`, was
 * handed the first 12,000 characters of a ~3MB document, and reported that
 * `moonshotai/kimi-k2.7-code` — the model it was running on — is not listed.
 * It was reasoning correctly about a document it had been silently given 0.4% of.
 *
 * So a clipped result now says so, in numbers, and keeps BOTH ends: the head
 * (what the command is doing) and the tail (where errors, summaries and totals
 * live — `make`, `pytest`, and every long install put the verdict last, and the
 * old cut threw exactly that away). The full text is written to a file in the
 * sandbox, so the model can go and filter it instead of re-running the command.
 */

/** Total character budget for a clipped result, head + tail together. */
export const OUTPUT_MAX = 12_000;
const HEAD_BUDGET = 8000;
const TAIL_BUDGET = 3000;

export interface ClipStats {
  headLines: number;
  hiddenLines: number;
  tailLines: number;
  totalChars: number;
  totalLines: number;
}

export interface ClipResult {
  stats?: ClipStats;
  text: string;
  /** True when the text was clipped and a full copy is worth saving. */
  truncated: boolean;
}

// Take whole lines from one end until the next one would blow the budget. Whole
// lines because a half line of JSON or a half stack frame reads as corruption;
// one oversized single line is hard-cut instead, since it has no line to stop at.
function takeLines(
  lines: string[],
  budget: number,
  fromEnd: boolean
): string[] {
  const taken: string[] = [];
  let used = 0;
  const ordered = fromEnd ? [...lines].reverse() : lines;
  for (const line of ordered) {
    const cost = line.length + 1;
    if (used + cost > budget) {
      if (taken.length === 0) {
        taken.push(line.slice(0, Math.max(budget - 1, 0)));
      }
      break;
    }
    taken.push(line);
    used += cost;
  }
  return fromEnd ? taken.reverse() : taken;
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * Build the notice that sits between the two halves. It states what is missing
 * and what to do about it — a model that is told "40,901 lines are not shown"
 * asks a narrower question instead of answering from the fragment.
 */
function notice(stats: ClipStats, savedPath: string | undefined): string {
  const where = savedPath
    ? `The COMPLETE output is saved at ${savedPath} — do not cat it, filter it (grep/jq/sed/awk/readFile with startLine).`
    : 'The complete output could not be saved to a file, so re-run the command filtered (grep/jq/head) if you need the middle.';
  return [
    '',
    `[... ${formatNumber(stats.hiddenLines)} LINES NOT SHOWN ...]`,
    `[kyto truncated this output: ${formatNumber(stats.totalLines)} lines / ${formatNumber(stats.totalChars)} chars total, of which you are seeing the first ${formatNumber(stats.headLines)} and the last ${formatNumber(stats.tailLines)}. Do NOT conclude anything from what is absent here — if what you need could be in the hidden middle, go and look. ${where}]`,
    '',
  ].join('\n');
}

/**
 * Clip `text` to the budget, or return it untouched if it already fits.
 * `savedPath` is where the full copy lives (the caller writes it, and passes
 * undefined if that failed or if the text was already on disk somewhere else).
 */
export function clipOutput(text: string, savedPath?: string): ClipResult {
  if (text.length <= OUTPUT_MAX) {
    return { text, truncated: false };
  }
  const lines = text.split('\n');
  const head = takeLines(lines, HEAD_BUDGET, false);
  // The tail is taken from what the head did not already cover, so a text just
  // over the budget can never show the same line twice.
  const rest = lines.slice(head.length);
  const tail = takeLines(rest, TAIL_BUDGET, true);
  const stats: ClipStats = {
    headLines: head.length,
    hiddenLines: Math.max(lines.length - head.length - tail.length, 0),
    tailLines: tail.length,
    totalChars: text.length,
    totalLines: lines.length,
  };
  return {
    stats,
    text: [head.join('\n'), notice(stats, savedPath), tail.join('\n')].join(
      '\n'
    ),
    truncated: true,
  };
}

/** Where a clipped command's full output is kept inside the sandbox. */
export function fullOutputPath(label: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const suffix = Math.random().toString(36).slice(2, 8);
  return `/tmp/kyto-output/${stamp}-${label}-${suffix}.txt`;
}
