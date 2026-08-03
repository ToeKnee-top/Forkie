import { describe, expect, test } from 'bun:test';
import {
  allowanceForAge,
  MAX_TURN_CHARS,
  renderThinking,
  selectWithinBudget,
  tail,
} from './thinking-render';

const turn = (label: string, size: number) => `${label}${'x'.repeat(size)}END`;

describe('allowanceForAge', () => {
  test('the newest turn keeps its full stored length', () => {
    expect(allowanceForAge(0)).toBe(MAX_TURN_CHARS);
  });

  test('older turns decay', () => {
    expect(allowanceForAge(1)).toBeLessThan(allowanceForAge(0));
    expect(allowanceForAge(2)).toBeLessThan(allowanceForAge(1));
    expect(allowanceForAge(3)).toBeLessThan(allowanceForAge(2));
  });

  test('decay bottoms out rather than shrinking to nothing', () => {
    // A 40-turn thread must not reduce its oldest kept turn to a fragment that
    // costs tokens and says nothing.
    const floor = allowanceForAge(4);
    expect(allowanceForAge(40)).toBe(floor);
    expect(floor).toBeGreaterThan(0);
  });
});

describe('tail', () => {
  test('keeps the END of a turn, not the start', () => {
    // The tail is where a turn worked out what was going on; the head is the
    // tool output it was reasoning from.
    const result = tail('abcdefghij', 4);
    expect(result).toContain('ghij');
    expect(result).not.toContain('abcd');
  });

  test('says so when it truncated, and stays silent when it did not', () => {
    expect(tail('short', 100)).toBe('short');
    expect(tail('abcdefghij', 4)).toContain('dropped');
  });
});

describe('selectWithinBudget', () => {
  test('decays older turns while keeping the newest whole', () => {
    const turns = [turn('oldest', 19_000), turn('newest', 19_000)];
    const [oldest, newest] = selectWithinBudget(turns);
    expect(newest).toBe(turns[1] as string);
    expect((oldest as string).length).toBeLessThan((turns[0] as string).length);
  });

  test('decay is what lets more turns fit the same budget', () => {
    // Ten full-size turns are ~190k chars; under the old no-decay rule only the
    // first few fit the 60k budget and the rest were dropped entirely.
    const turns = Array.from({ length: 10 }, (_, i) => turn(`t${i}`, 19_000));
    expect(selectWithinBudget(turns).length).toBeGreaterThan(3);
  });

  test('returns turns oldest-first', () => {
    const turns = ['first', 'second', 'third'];
    expect(selectWithinBudget(turns)).toEqual(turns);
  });

  test('always keeps the most recent turn, even alone over budget', () => {
    expect(selectWithinBudget([turn('a', 5), turn('b', 5)], 1)).toHaveLength(1);
  });

  test('survives a sparse array', () => {
    const sparse = ['a', undefined as unknown as string, 'b'];
    expect(selectWithinBudget(sparse)).toEqual(['a', 'b']);
  });
});

describe('renderThinking', () => {
  test('empty in, empty out — no bare block header', () => {
    expect(renderThinking([])).toBe('');
  });

  test('labels turns by age', () => {
    const block = renderThinking(['old', 'recent']);
    expect(block).toContain('[2 turns ago]');
    expect(block).toContain('[your previous turn]');
  });

  test('tells the model abbreviated turns are abbreviated', () => {
    // Otherwise it treats a truncated head as evidence the tool returned
    // nothing, and re-derives from a gap it cannot see.
    expect(renderThinking(['a'])).toContain('abbreviated');
  });
});
