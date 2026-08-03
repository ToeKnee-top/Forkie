import { describe, expect, test } from 'bun:test';
import type { ModelAttempt } from '@repo/ai';
import {
  attemptKey,
  buildFallbackQueue,
  isPromptConstructionError,
  selectNextAttempt,
} from './routing';

function hackclub(model: string): ModelAttempt {
  return {
    apiKey: 'k',
    baseURL: 'https://ai.hackclub.com/proxy/v1',
    model,
    provider: 'hackclub',
  };
}

function gemini(model: string): ModelAttempt {
  return { apiKey: 'k', baseURL: 'https://gemini', model, provider: 'gemini' };
}

// Mirrors the shape of LEADERBOARD_FALLBACK: HackClub rungs in rank order,
// Gemini appended at the bottom.
const leaderboard: ModelAttempt[] = [
  hackclub('openai/gpt-5.6-sol'),
  hackclub('anthropic/claude-opus-4.8'),
  hackclub('anthropic/claude-sonnet-5'),
  gemini('gemini-3.1-flash-lite'),
  gemini('gemini-2.5-flash'),
];

describe('buildFallbackQueue', () => {
  test('walks HackClub first, in leaderboard order', () => {
    expect(buildFallbackQueue(leaderboard).map((a) => a.model)).toEqual([
      'openai/gpt-5.6-sol',
      'anthropic/claude-opus-4.8',
      'anthropic/claude-sonnet-5',
      'gemini-3.1-flash-lite',
      'gemini-2.5-flash',
    ]);
  });

  test('BEST FIRST — the top rung leads, never the bottom', () => {
    // The regression this guards: the queue once pivoted on the primary's index
    // and walked "up", which reversed the leaderboard and put the junk tier
    // first. A model streamed "@devansh" several hundred times into a public
    // channel as a result.
    const queue = buildFallbackQueue(leaderboard);
    expect(queue[0]?.model).toBe('openai/gpt-5.6-sol');
    expect(queue.at(-1)?.provider).toBe('gemini');
  });

  test('Gemini is last, after every HackClub rung', () => {
    const queue = buildFallbackQueue(leaderboard);
    const firstGemini = queue.findIndex((a) => a.provider === 'gemini');
    const lastHackclub = queue.map((a) => a.provider).lastIndexOf('hackclub');
    expect(firstGemini).toBeGreaterThan(lastHackclub);
  });

  test('drops a provider the leaderboard does not have', () => {
    const queue = buildFallbackQueue([
      hackclub('a'),
      { apiKey: 'k', baseURL: 'x', model: 'ghost', provider: 'retired-tier' },
    ]);
    expect(queue.map((a) => a.model)).toEqual(['a']);
  });

  test('an empty leaderboard produces an empty queue, not a throw', () => {
    expect(buildFallbackQueue([])).toEqual([]);
  });
});

describe('selectNextAttempt', () => {
  const queue = buildFallbackQueue(leaderboard);

  test('takes the first untried rung', () => {
    const next = selectNextAttempt({
      failedKeys: new Set(),
      queue,
      skipHackclub: false,
    });
    expect(next?.model).toBe('openai/gpt-5.6-sol');
  });

  test('skips rungs already tried', () => {
    const next = selectNextAttempt({
      failedKeys: new Set(['hackclub:openai/gpt-5.6-sol']),
      queue,
      skipHackclub: false,
    });
    expect(next?.model).toBe('anthropic/claude-opus-4.8');
  });

  test('skipHackclub jumps the whole tier in one step', () => {
    // A shared budget or a dead proxy dooms every HackClub rung identically —
    // walking them one at a time only buys another "Thinking · fallback" card.
    const next = selectNextAttempt({
      failedKeys: new Set(),
      queue,
      skipHackclub: true,
    });
    expect(next?.provider).toBe('gemini');
  });

  test('returns undefined when the whole chain is spent', () => {
    const next = selectNextAttempt({
      failedKeys: new Set(queue.map(attemptKey)),
      queue,
      skipHackclub: false,
    });
    expect(next).toBeUndefined();
  });

  test('the tier skip is applied at selection time, not baked in', () => {
    // The tier can go out MID-walk, so the same queue object must answer
    // differently once the flag flips.
    const failedKeys = new Set(['hackclub:openai/gpt-5.6-sol']);
    expect(
      selectNextAttempt({ failedKeys, queue, skipHackclub: false })?.provider
    ).toBe('hackclub');
    expect(
      selectNextAttempt({ failedKeys, queue, skipHackclub: true })?.provider
    ).toBe('gemini');
  });
});

describe('attemptKey', () => {
  test('keys on provider AND model', () => {
    // The same slug served by two providers is two distinct rungs; keying on
    // model alone would write both off together.
    expect(attemptKey(hackclub('kimi'))).not.toBe(attemptKey(gemini('kimi')));
  });
});

describe('isPromptConstructionError', () => {
  // The failure this exists for: a prompt kyto assembled that the SDK refused
  // to send. Every rung fails identically and instantly, so walking the queue
  // spends the shared daily cap and answers nobody.
  test('recognises the SDK marker symbol', () => {
    const error = new Error('Invalid prompt: The messages do not match…');
    (error as unknown as Record<PropertyKey, unknown>)[
      Symbol.for('vercel.ai.error.AI_InvalidPromptError')
    ] = true;
    expect(isPromptConstructionError(error)).toBe(true);
  });

  test('recognises the error name when the marker is missing', () => {
    // Two @ai-sdk/provider copies are installed, so `instanceof` and even the
    // marker can miss; the name is the fallback.
    const error = new Error('Invalid prompt');
    error.name = 'AI_InvalidPromptError';
    expect(isPromptConstructionError(error)).toBe(true);
  });

  test('digs through the cause chain', () => {
    const inner = new Error('conversion failed');
    inner.name = 'AI_MessageConversionError';
    expect(
      isPromptConstructionError(new Error('wrapped', { cause: inner }))
    ).toBe(true);
  });

  test('a provider rejecting the prompt over the wire still falls back', () => {
    // A 400 from ONE provider says nothing about the next one — this must stay
    // a normal per-model failure.
    const error = new Error('400 invalid_request_error: bad prompt');
    error.name = 'AI_APICallError';
    expect(isPromptConstructionError(error)).toBe(false);
  });

  test('ignores non-errors and self-referential causes', () => {
    expect(isPromptConstructionError(undefined)).toBe(false);
    expect(isPromptConstructionError('AI_InvalidPromptError')).toBe(false);
    const loop = new Error('loop') as Error & { cause?: unknown };
    loop.cause = loop;
    expect(isPromptConstructionError(loop)).toBe(false);
  });
});
