import { describe, expect, test } from 'bun:test';
import { isBareSkipText } from './skip-text';

// A false positive here silently swallows somebody's reply; a false negative posts
// a message reading `skip`. Both have happened, so pin the boundary down.
describe('isBareSkipText', () => {
  test('recognises a reply that is nothing but the token', () => {
    for (const text of [
      'skip',
      'Skip',
      'SKIP',
      ' skip ',
      '\nskip\n',
      'skip.',
      'skip!',
      '`skip`',
      '```skip```',
      'skip()',
    ]) {
      expect(isBareSkipText(text)).toBe(true);
    }
  });

  test('leaves real prose that merely mentions skipping alone', () => {
    for (const text of [
      'skip the first step',
      "i'll skip that",
      'skipped',
      'skipping',
      'skip\n\nactually here is the answer',
      'done — i had to skip',
      'no-skip',
    ]) {
      expect(isBareSkipText(text)).toBe(false);
    }
  });

  test('does not treat an empty reply as a skip', () => {
    // An empty attempt is a FAILURE that must fall back to another model, not a
    // deliberate silence — conflating them would make an empty response look
    // like a handled turn and leave the user with nothing.
    for (const text of ['', '   ', '\n']) {
      expect(isBareSkipText(text)).toBe(false);
    }
  });
});
