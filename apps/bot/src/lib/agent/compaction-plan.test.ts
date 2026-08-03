import { describe, expect, test } from 'bun:test';
import {
  COMPACT_BATCH,
  type CompactableMessage,
  MAX_MESSAGES_PER_PASS,
  planCompaction,
  renderCompactedBlock,
} from './compaction-plan';

function messages(count: number, offset = 0): CompactableMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `m${offset + index}`,
    rendered: `@someone: message ${offset + index}`,
  }));
}

describe('planCompaction', () => {
  test('does nothing when there is no overflow', () => {
    expect(planCompaction({ overflow: [] })).toBeUndefined();
  });

  test('summarizes everything the first time a thread overflows', () => {
    const overflow = messages(30);
    const plan = planCompaction({ overflow });
    expect(plan?.kind).toBe('summarize');
    if (plan?.kind !== 'summarize') {
      throw new Error('expected a summarize plan');
    }
    expect(plan.batch).toHaveLength(30);
    expect(plan.previous).toBeUndefined();
    expect(plan.throughMessageId).toBe('m29');
  });

  test('summarizes a first overflow even below the batch threshold', () => {
    // No stored summary means the thread has NEVER been compacted, so waiting
    // would leave the model with a bare count for the next 24 turns.
    const plan = planCompaction({ overflow: messages(1) });
    expect(plan?.kind).toBe('summarize');
  });

  test('reuses the stored summary until enough new messages accumulate', () => {
    const overflow = messages(COMPACT_BATCH + 5);
    const plan = planCompaction({
      overflow,
      stored: { summary: 'earlier stuff', throughMessageId: 'm5' },
    });
    // 24 pending (m6..m29) is under the threshold.
    expect(plan).toEqual({ kind: 'reuse', summary: 'earlier stuff' });
  });

  test('folds new messages into the stored summary once the batch fills', () => {
    const overflow = messages(60);
    const plan = planCompaction({
      overflow,
      stored: { summary: 'earlier stuff', throughMessageId: 'm9' },
    });
    if (plan?.kind !== 'summarize') {
      throw new Error('expected a summarize plan');
    }
    expect(plan.previous).toBe('earlier stuff');
    // Only m10..m59 — the already-covered prefix is not paid for twice.
    expect(plan.batch).toHaveLength(50);
    expect(plan.batch[0]?.id).toBe('m10');
    expect(plan.throughMessageId).toBe('m59');
  });

  test('treats an unlocatable stored summary as covering nothing', () => {
    // The row aged out or the thread changed underneath us. Folding new messages
    // into a summary whose starting point we cannot find would double-count or
    // skip a stretch, so start over rather than guess.
    const overflow = messages(40);
    const plan = planCompaction({
      overflow,
      stored: { summary: 'stale', throughMessageId: 'not-in-this-thread' },
    });
    if (plan?.kind !== 'summarize') {
      throw new Error('expected a summarize plan');
    }
    expect(plan.previous).toBeUndefined();
    expect(plan.batch).toHaveLength(40);
  });

  test('caps one pass and keeps the messages nearest the live conversation', () => {
    const overflow = messages(MAX_MESSAGES_PER_PASS + 50);
    const plan = planCompaction({ overflow });
    if (plan?.kind !== 'summarize') {
      throw new Error('expected a summarize plan');
    }
    expect(plan.batch).toHaveLength(MAX_MESSAGES_PER_PASS);
    expect(plan.batch.at(-1)?.id).toBe(`m${MAX_MESSAGES_PER_PASS + 49}`);
    // The pass is capped, but the marker still advances to the newest message —
    // otherwise the skipped prefix would be retried forever.
    expect(plan.throughMessageId).toBe(`m${MAX_MESSAGES_PER_PASS + 49}`);
  });
});

describe('renderCompactedBlock', () => {
  test('always states the count, even with no summary', () => {
    const block = renderCompactedBlock({ count: 42 });
    expect(block).toContain('42 earlier message(s)');
    expect(block).toContain('<earlier_in_this_thread>');
    expect(block).toContain('</earlier_in_this_thread>');
  });

  test('does not claim a digest it does not have', () => {
    const block = renderCompactedBlock({ count: 5 });
    expect(block).not.toContain('compacted digest');
    expect(block).toContain('could not be summarized');
  });

  test('includes the summary and labels it as a digest', () => {
    const block = renderCompactedBlock({
      count: 5,
      summary: 'devansh asked for X; it was delivered',
    });
    expect(block).toContain('devansh asked for X');
    expect(block).toContain('compacted digest, not a transcript');
  });

  test('tells the model the replay is not the start of the conversation', () => {
    // The bug being fixed was the model treating the replay window as the whole
    // thread, so this sentence is load-bearing.
    expect(renderCompactedBlock({ count: 1 })).toContain(
      'do not treat the replayed history as its beginning'
    );
  });
});
