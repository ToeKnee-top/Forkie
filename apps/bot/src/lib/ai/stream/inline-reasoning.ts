// Split inline chain-of-thought out of a model's TEXT stream.
//
// A well-behaved provider reports reasoning in its own channel
// (`reasoning_content` / `reasoning`), which the SDK turns into reasoning parts
// and renderStream shows in a Thinking card. Some upstreams don't: the model
// wraps its thinking in `<think>…</think>` and it arrives as ordinary content.
// Kyto then posted it as the reply — a public thread got several messages of raw
// deliberation ("What are my honest critiques?", "Need to provide opinions…")
// before the actual answer, which is both noise and a small leak of how kyto
// reasons about the people in the room.
//
// So text deltas run through this first. It is a STREAMING splitter because a
// tag routinely straddles a chunk boundary: `<thi` arrives in one delta and
// `nk>` in the next.

const OPEN_TAG = /<(think|thinking|reasoning)\s*>/i;
const CLOSE_TAG = /<\/(think|thinking|reasoning)\s*>/i;
// `</reasoning>` is the longest tag we look for; nothing shorter than a complete
// tag ever needs to be held back further than this.
const MAX_TAG_LENGTH = 12;

export interface SplitResult {
  /** Content that was inside a thinking tag. */
  reasoning: string;
  /** Content to show the user. */
  text: string;
}

/**
 * How much of the tail might be the start of a tag that has not fully arrived?
 *
 * Only a trailing `<…` with no `>` yet qualifies. Bounded by MAX_TAG_LENGTH so
 * a stray `<` in prose (`a < b`) delays at most a few characters rather than
 * stalling the stream, and `<@U123>` — which has its `>` — is never held.
 */
function heldBackLength(buffer: string): number {
  const start = buffer.lastIndexOf('<');
  if (start === -1 || buffer.indexOf('>', start) !== -1) {
    return 0;
  }
  const candidate = buffer.length - start;
  return candidate <= MAX_TAG_LENGTH ? candidate : 0;
}

export function createInlineReasoningSplitter() {
  let buffer = '';
  let inside = false;

  const drain = (final: boolean): SplitResult => {
    let text = '';
    let reasoning = '';
    for (;;) {
      const match = (inside ? CLOSE_TAG : OPEN_TAG).exec(buffer);
      if (match) {
        const before = buffer.slice(0, match.index);
        if (inside) {
          reasoning += before;
        } else {
          text += before;
        }
        buffer = buffer.slice(match.index + match[0].length);
        inside = !inside;
        continue;
      }
      // No complete tag left. Release everything except a tail that could still
      // become one (unless this is the flush, where nothing more is coming).
      const hold = final ? 0 : heldBackLength(buffer);
      const releasable = buffer.slice(0, buffer.length - hold);
      if (inside) {
        reasoning += releasable;
      } else {
        text += releasable;
      }
      buffer = buffer.slice(buffer.length - hold);
      break;
    }
    return { reasoning, text };
  };

  return {
    /** Feed one text delta; returns the visible text and any reasoning in it. */
    push(chunk: string): SplitResult {
      buffer += chunk;
      return drain(false);
    },
    /**
     * End of stream: release whatever is still buffered. An unterminated
     * `<think>` means everything after it was reasoning — emitting it as the
     * reply is exactly the failure this module exists to prevent, so it stays
     * classified as reasoning.
     */
    flush(): SplitResult {
      return drain(true);
    },
  };
}
