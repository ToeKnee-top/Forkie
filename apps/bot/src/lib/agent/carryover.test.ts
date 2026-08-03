import { describe, expect, test } from 'bun:test';
import {
  CARRYOVER_MAX_RESULTS,
  CARRYOVER_OUTPUT_MAX,
  type GatheredResult,
  OBSERVATION_MAX_RESULTS,
  renderCarryover,
  renderContinuation,
  renderObservations,
  stableInput,
} from './carryover';

function results(count: number): GatheredResult[] {
  return Array.from({ length: count }, (_, index) => ({
    input: { query: `q${index}` },
    output: `result ${index}`,
    toolName: `tool${index}`,
  }));
}

describe('renderCarryover', () => {
  test('tells the next model not to re-run the tools', () => {
    // Without this line a fallback model repeats every web search the dead
    // attempt already paid for.
    expect(renderCarryover(results(2))).toContain(
      'do NOT re-run the same tools'
    );
  });

  test('includes each tool name, input and output', () => {
    const block = renderCarryover(results(2));
    expect(block).toContain('tool0');
    expect(block).toContain('q1');
    expect(block).toContain('result 1');
  });

  test('keeps the MOST RECENT results when over the cap', () => {
    // A turn that fell back deep into a long tool run must not hand the next
    // model the first twelve results and none of the recent ones.
    const block = renderCarryover(results(CARRYOVER_MAX_RESULTS + 5));
    expect(block).toContain(`tool${CARRYOVER_MAX_RESULTS + 4}`);
    expect(block).not.toContain('tool0(');
  });

  test('numbers the results from 1 after trimming', () => {
    const block = renderCarryover(results(CARRYOVER_MAX_RESULTS + 5));
    expect(block).toContain('1. tool5(');
  });

  test('clamps a huge tool output instead of blowing up the prompt', () => {
    const block = renderCarryover([
      { input: 'x', output: 'y'.repeat(50_000), toolName: 'searchWeb' },
    ]);
    expect(block.length).toBeLessThan(CARRYOVER_OUTPUT_MAX + 1000);
  });

  test('survives an unserializable input', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      renderCarryover([{ input: circular, output: 'ok', toolName: 't' }])
    ).not.toThrow();
  });
});

describe('renderContinuation', () => {
  const streamed = 'i checked the logs and found three errors.';

  test('quotes what the user was already shown', () => {
    expect(renderContinuation(streamed)).toContain(streamed);
  });

  test('says the turn is already in progress and must not restart', () => {
    // The whole point: without it the continuation model restates the answer
    // and the user reads it twice.
    const block = renderContinuation(streamed);
    expect(block).toContain('already in progress');
    expect(block).toContain('Do NOT repeat what was already said');
    expect(block).toContain('do not start the task over');
  });
});

describe('renderObservations', () => {
  test('is empty when the turn ran no tools', () => {
    expect(renderObservations([])).toBe('');
  });

  test('records what each tool returned, one per line', () => {
    const block = renderObservations(results(3));
    expect(block.split('\n')).toHaveLength(3);
    expect(block).toContain('tool1({"query":"q1"}) → result 1');
  });

  test('keeps the most recent when over its own, smaller cap', () => {
    const block = renderObservations(results(OBSERVATION_MAX_RESULTS + 3));
    expect(block.split('\n')).toHaveLength(OBSERVATION_MAX_RESULTS);
    expect(block).toContain(`tool${OBSERVATION_MAX_RESULTS + 2}`);
  });

  test('stays smaller than the carryover cap', () => {
    // Reasoning AND observations share one per-turn thinking budget.
    expect(OBSERVATION_MAX_RESULTS).toBeGreaterThan(0);
    expect(renderObservations(results(5)).length).toBeLessThan(
      renderCarryover(results(5)).length
    );
  });
});

describe('stableInput', () => {
  test('passes a string straight through', () => {
    expect(stableInput('hello')).toBe('hello');
  });

  test('serializes an object', () => {
    expect(stableInput({ a: 1 })).toBe('{"a":1}');
  });

  test('falls back to String() rather than throwing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(stableInput(circular)).toContain('object');
  });

  test('is stable — the same input dedupes to the same key', () => {
    // gatheredResults dedupes on `${toolName}:${stableInput(input)}`.
    expect(stableInput({ a: 1, b: 2 })).toBe(stableInput({ a: 1, b: 2 }));
  });
});
