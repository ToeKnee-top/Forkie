// A weak model under a long tool-heavy prompt can stop generating an answer and
// start generating a LOOP: the same line, forever, until the output cap. It is
// still "reply text" as far as the agent loop is concerned, so it used to be
// streamed straight into the thread and counted as a handled turn — nemotron
// once posted "@devansh" several hundred times into a public channel this way.
//
// This guard watches the reply text as it streams and trips the moment the
// output has clearly degenerated, so the attempt can be aborted BEFORE the loop
// reaches Slack and handed to a different model instead.

// Consecutive identical lines that mean "this is a loop, not an answer". Real
// prose never repeats a whole line even twice; a list, a table or numbered steps
// all differ line to line. Code blocks legitimately can (a data dump, ASCII art),
// so lines inside a fence are not counted at all.
const MAX_REPEATED_LINES = 8;

// The same failure with no newlines in it ("@devansh @devansh @devansh …"): one
// runaway line. Any line this long made of at most two distinct whitespace-
// separated tokens is a loop — 24 words of real prose are never two words.
const MIN_RUNAWAY_TOKENS = 24;
const MAX_RUNAWAY_VOCABULARY = 2;

const FENCE = /^(?:```|~~~)/;

export interface RepetitionGuard {
  /**
   * Feed one streamed text delta. Returns true once the output has degenerated,
   * and keeps returning true after that.
   */
  push(text: string): boolean;
}

export function createRepetitionGuard(): RepetitionGuard {
  // The tail of the last delta: a line is only judged once it is complete.
  let partial = '';
  let previous: string | undefined;
  let repeats = 0;
  let fenced = false;
  let tripped = false;

  const consider = (line: string): boolean => {
    const trimmed = line.trim();
    if (FENCE.test(trimmed)) {
      fenced = !fenced;
      previous = undefined;
      repeats = 0;
      return false;
    }
    if (fenced) {
      return false;
    }
    // Blank lines neither break a run nor extend it, so a model looping with a
    // blank line between each repeat is caught the same as one without.
    if (!trimmed) {
      return false;
    }
    if (trimmed === previous) {
      repeats += 1;
      return repeats >= MAX_REPEATED_LINES;
    }
    previous = trimmed;
    repeats = 1;
    return false;
  };

  return {
    push(text: string): boolean {
      if (tripped) {
        return true;
      }
      const lines = (partial + text).split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) {
        if (consider(line)) {
          tripped = true;
          return true;
        }
      }
      if (!fenced && isRunawayLine(partial)) {
        tripped = true;
        return true;
      }
      return false;
    },
  };
}

function isRunawayLine(line: string): boolean {
  const tokens = line.trim().split(/\s+/);
  if (tokens.length < MIN_RUNAWAY_TOKENS) {
    return false;
  }
  return new Set(tokens).size <= MAX_RUNAWAY_VOCABULARY;
}

/**
 * Drop a degenerate run out of text that is being carried to another model as
 * context (renderContinuation): the next model must see what kyto legitimately
 * said before the loop started, and none of the loop itself — otherwise it reads
 * "@devansh @devansh @devansh" as the thread's tone and carries on in kind.
 */
export function stripRepeatedLines(text: string): string {
  const kept: string[] = [];
  let previous: string | undefined;
  let repeats = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && trimmed === previous) {
      repeats += 1;
      if (repeats >= MAX_REPEATED_LINES) {
        continue;
      }
    } else if (trimmed) {
      previous = trimmed;
      repeats = 1;
    }
    kept.push(isRunawayLine(line) ? '' : line);
  }
  return kept.join('\n').trim();
}
