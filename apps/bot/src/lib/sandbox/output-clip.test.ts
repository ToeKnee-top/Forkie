import { describe, expect, test } from 'bun:test';
import { clipOutput, fullOutputPath, OUTPUT_MAX } from './output-clip';

const line = (n: number) => `line-${n}-${'x'.repeat(40)}`;
const manyLines = (count: number) =>
  Array.from({ length: count }, (_, i) => line(i)).join('\n');

describe('clipOutput', () => {
  test('leaves output that fits completely untouched', () => {
    const text = manyLines(50);
    const result = clipOutput(text);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe(text);
    expect(result.stats).toBeUndefined();
  });

  test('keeps the head AND the tail', () => {
    // The verdict of a long command lives at the END — the old hard cut kept
    // only the head, so a passing build and a failing one looked identical.
    const text = `${manyLines(4000)}\nFAILED: 3 tests failed`;
    const result = clipOutput(text);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain('line-0-');
    expect(result.text).toContain('FAILED: 3 tests failed');
  });

  test('says how much is missing, in numbers', () => {
    const text = manyLines(4000);
    const result = clipOutput(text);
    const stats = result.stats;
    if (!stats) {
      throw new Error('expected stats');
    }
    expect(stats.totalLines).toBe(4000);
    expect(stats.hiddenLines).toBeGreaterThan(0);
    expect(stats.headLines + stats.tailLines + stats.hiddenLines).toBe(4000);
    expect(result.text).toContain('LINES NOT SHOWN');
    expect(result.text).toContain('kyto truncated this output');
    // The count has to be readable in the text itself, not just in `stats` —
    // the model only ever sees the text.
    expect(result.text).toContain(stats.hiddenLines.toLocaleString('en-US'));
  });

  test('points at the saved copy when there is one', () => {
    const result = clipOutput(manyLines(4000), '/tmp/kyto-output/full.txt');
    expect(result.text).toContain('/tmp/kyto-output/full.txt');
    expect(result.text).toContain('do not cat it');
  });

  test('admits when the full copy could not be saved', () => {
    const result = clipOutput(manyLines(4000));
    expect(result.text).toContain('could not be saved');
    expect(result.text).not.toContain('/tmp/kyto-output/');
  });

  test('stays near the budget', () => {
    const result = clipOutput(manyLines(20_000));
    // Budget plus the notice — the point is that a 900KB output does not go on
    // costing 900KB of context.
    expect(result.text.length).toBeLessThan(OUTPUT_MAX + 1000);
  });

  test('never shows the same line in both halves', () => {
    // A text only just over the budget: head and tail must not overlap.
    const text = 'a'
      .repeat(OUTPUT_MAX + 100)
      .split('')
      .join('\n');
    const result = clipOutput(text);
    const stats = result.stats;
    if (!stats) {
      throw new Error('expected stats');
    }
    expect(stats.headLines + stats.tailLines).toBeLessThanOrEqual(
      stats.totalLines
    );
    expect(stats.hiddenLines).toBeGreaterThanOrEqual(0);
  });

  test('handles a single enormous line with no newlines at all', () => {
    // Minified JSON — one line, megabytes long. There is no line boundary to
    // stop at, so it is hard-cut rather than dropped entirely.
    const result = clipOutput('{'.repeat(200_000));
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThan(OUTPUT_MAX + 1000);
    expect(result.text).toContain('kyto truncated this output');
  });
});

describe('fullOutputPath', () => {
  test('is a unique path under the sandbox tmp dir', () => {
    const at = new Date('2026-07-27T05:40:12.000Z');
    const path = fullOutputPath('stdout', at);
    expect(path.startsWith('/tmp/kyto-output/')).toBe(true);
    expect(path).toContain('stdout');
    expect(path.endsWith('.txt')).toBe(true);
    // A second call must not collide — two clipped outputs in one turn are
    // normal and one must not overwrite the other.
    expect(fullOutputPath('stdout', at)).not.toBe(path);
  });
});
