import { describe, expect, test } from 'bun:test';
import { createInlineReasoningSplitter } from './inline-reasoning';

// Feed a whole string one chunk at a time and collect the split halves.
function run(chunks: string[]) {
  const splitter = createInlineReasoningSplitter();
  let text = '';
  let reasoning = '';
  for (const chunk of chunks) {
    const part = splitter.push(chunk);
    text += part.text;
    reasoning += part.reasoning;
  }
  const rest = splitter.flush();
  return { reasoning: reasoning + rest.reasoning, text: text + rest.text };
}

describe('createInlineReasoningSplitter', () => {
  test('passes ordinary text straight through', () => {
    expect(run(['hello ', 'world']).text).toBe('hello world');
  });

  test('pulls a think block out of the reply', () => {
    const result = run(['before <think>secret</think> after']);
    expect(result.text).toBe('before  after');
    expect(result.reasoning).toBe('secret');
  });

  test('handles a tag split across chunk boundaries', () => {
    // The real failure mode: `<thi` arrives in one delta and `nk>` in the next.
    const result = run(['a<thi', 'nk>hid', 'den</thin', 'k>b']);
    expect(result.text).toBe('ab');
    expect(result.reasoning).toBe('hidden');
  });

  test('handles several blocks and the <thinking>/<reasoning> spellings', () => {
    const result = run([
      '<thinking>one</thinking>x<reasoning>two</reasoning>y',
    ]);
    expect(result.text).toBe('xy');
    expect(result.reasoning).toBe('onetwo');
  });

  test('an unterminated block stays reasoning, never becomes the reply', () => {
    // This is the whole point: a model cut off mid-thought must not have its
    // deliberation posted to a public thread as the answer.
    const result = run(['answer <think>still thinking about it']);
    expect(result.text).toBe('answer ');
    expect(result.reasoning).toBe('still thinking about it');
  });

  test('does not swallow a real Slack mention', () => {
    expect(run(['hey <@U085KKYFA6Q> there']).text).toBe(
      'hey <@U085KKYFA6Q> there'
    );
  });

  test('releases a stray angle bracket instead of stalling on it', () => {
    expect(run(['if a < b then', ' c']).text).toBe('if a < b then c');
    expect(run(['trailing <']).text).toBe('trailing <');
  });

  test('does not hold back a long tail after an unrelated bracket', () => {
    // A `<` further back than any tag could reach must not delay the stream.
    const splitter = createInlineReasoningSplitter();
    const emitted = splitter.push('a < bbbbbbbbbbbbbbbbbbbbbb');
    expect(emitted.text).toBe('a < bbbbbbbbbbbbbbbbbbbbbb');
  });

  test('is case-insensitive', () => {
    expect(run(['<THINK>x</THINK>y']).text).toBe('y');
  });
});
