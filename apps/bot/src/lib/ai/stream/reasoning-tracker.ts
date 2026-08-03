// Which stretch of reasoning is open, and what it has collected so far.
//
// Split out of renderStream because the bookkeeping is where the bugs were and
// the rest of that module can't be tested (it reaches the toolset, and through it
// the environment). Two rules live here, both of which users saw break:
//
//  1. **A provider id is not a card id.** The openai-compatible provider labels
//     every reasoning block `reasoning-0`, so keying the plan card on it collapsed
//     a whole turn's thinking onto one row, pinned wherever it first appeared.
//     Each block gets its own `reasoning-N` instead, so the plan reads
//     thinking → tool → thinking → tool.
//  2. **Every block that opens must close.** A block left open is a task card
//     stuck on `in_progress`; when its plan message is stopped, the collapsed plan
//     renders that row as broken. Its text is also lost for the next turn. The
//     provider emits `reasoning-end` only from its own stream flush, so a stream
//     that dies or is aborted mid-thought never sends one — and a provider that
//     reopens an id that is still open orphans the block that was there.

/** A block that just finished: its card id and everything it collected. */
export interface ClosedReasoning {
  id: string;
  text: string;
}

export function createReasoningTracker() {
  let counter = 0;
  // Provider's (reused) block id → this block's unique card id.
  const open = new Map<string, string>();
  const collected = new Map<string, string>();

  const close = (providerId: string): ClosedReasoning | undefined => {
    const id = open.get(providerId);
    open.delete(providerId);
    if (!id) {
      return;
    }
    const text = (collected.get(id) ?? '').trim();
    collected.delete(id);
    return { id, text };
  };

  return {
    /**
     * Start a block for this provider id. Returns its card id, plus any block
     * the provider left open under the SAME id — that one has to be closed by
     * the caller, or it stays on the plan forever.
     */
    open(providerId: string): { id: string; orphaned?: ClosedReasoning } {
      const orphaned = close(providerId);
      const id = `reasoning-${counter++}`;
      open.set(providerId, id);
      collected.set(id, '');
      return orphaned ? { id, orphaned } : { id };
    },
    /** Append a delta. Ignored when nothing is open for this provider id. */
    delta(providerId: string, text: string): void {
      const id = open.get(providerId);
      if (id) {
        collected.set(id, (collected.get(id) ?? '') + text);
      }
    },
    close,
    /** Close everything still open, oldest first. */
    closeAll(): ClosedReasoning[] {
      const closed: ClosedReasoning[] = [];
      for (const providerId of [...open.keys()]) {
        const done = close(providerId);
        if (done) {
          closed.push(done);
        }
      }
      return closed;
    },
  };
}
