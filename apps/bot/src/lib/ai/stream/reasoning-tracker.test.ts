import { describe, expect, test } from 'bun:test';
import { createReasoningTracker } from './reasoning-tracker';

// The provider labels every block with the same id, so that is what the tests use.
const PROVIDER_ID = 'reasoning-0';

describe('createReasoningTracker', () => {
  test('collects a block and hands back its text on close', () => {
    const tracker = createReasoningTracker();
    const { id, orphaned } = tracker.open(PROVIDER_ID);
    expect(orphaned).toBeUndefined();
    tracker.delta(PROVIDER_ID, 'weighing ');
    tracker.delta(PROVIDER_ID, 'the options');
    expect(tracker.close(PROVIDER_ID)).toEqual({
      id,
      text: 'weighing the options',
    });
  });

  test('gives each block its own card id, even under one provider id', () => {
    const tracker = createReasoningTracker();
    const first = tracker.open(PROVIDER_ID).id;
    tracker.close(PROVIDER_ID);
    const second = tracker.open(PROVIDER_ID).id;
    // Same provider id, two rows — otherwise a whole turn's thinking collapses
    // onto the row where it first appeared.
    expect(second).not.toBe(first);
  });

  // The provider reuses one id and does not always close it. Reopening must hand
  // the previous block back, or its card spins forever and its text is lost.
  test('reopening an open id returns the orphaned block', () => {
    const tracker = createReasoningTracker();
    const first = tracker.open(PROVIDER_ID).id;
    tracker.delta(PROVIDER_ID, 'first thought');
    const reopened = tracker.open(PROVIDER_ID);
    expect(reopened.orphaned).toEqual({ id: first, text: 'first thought' });
    expect(reopened.id).not.toBe(first);
    tracker.delta(PROVIDER_ID, 'second thought');
    expect(tracker.close(PROVIDER_ID)).toEqual({
      id: reopened.id,
      text: 'second thought',
    });
  });

  // A stream that dies or is aborted mid-thought never sends `reasoning-end`.
  test('closeAll finishes whatever is still open', () => {
    const tracker = createReasoningTracker();
    const { id } = tracker.open(PROVIDER_ID);
    tracker.delta(PROVIDER_ID, 'cut off here');
    expect(tracker.closeAll()).toEqual([{ id, text: 'cut off here' }]);
  });

  test('closeAll covers several concurrent provider ids, oldest first', () => {
    const tracker = createReasoningTracker();
    const a = tracker.open('a').id;
    const b = tracker.open('b').id;
    tracker.delta('a', 'from a');
    tracker.delta('b', 'from b');
    expect(tracker.closeAll()).toEqual([
      { id: a, text: 'from a' },
      { id: b, text: 'from b' },
    ]);
  });

  test('closing twice is a no-op, so a card is never completed twice', () => {
    const tracker = createReasoningTracker();
    tracker.open(PROVIDER_ID);
    tracker.close(PROVIDER_ID);
    expect(tracker.close(PROVIDER_ID)).toBeUndefined();
    expect(tracker.closeAll()).toEqual([]);
  });

  test('a delta with nothing open is dropped rather than throwing', () => {
    const tracker = createReasoningTracker();
    expect(() => tracker.delta(PROVIDER_ID, 'stray')).not.toThrow();
    expect(tracker.closeAll()).toEqual([]);
  });

  test('whitespace-only thinking closes with empty text', () => {
    const tracker = createReasoningTracker();
    const { id } = tracker.open(PROVIDER_ID);
    tracker.delta(PROVIDER_ID, '  \n ');
    expect(tracker.close(PROVIDER_ID)).toEqual({ id, text: '' });
  });
});
