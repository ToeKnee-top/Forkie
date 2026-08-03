import { describe, expect, test } from 'bun:test';
import { createSegmenter, isVisibleText } from './segmentation';

const card = { type: 'task_update' };

describe('isVisibleText', () => {
  test('real prose is visible', () => {
    expect(isVisibleText('hello')).toBe(true);
  });

  test('whitespace-only fragments are not', () => {
    // createReply never posts these, so treating them as "the model replied"
    // opened an empty collapsible plan block for every stretch of tools.
    for (const fragment of ['', '\n', '  ', '\n\n', '\t']) {
      expect(isVisibleText(fragment)).toBe(false);
    }
  });
});

describe('createSegmenter', () => {
  test('task cards accumulate in one block before any text', () => {
    const segmenter = createSegmenter();
    expect(segmenter.next(card)).toBe('emit');
    expect(segmenter.next(card)).toBe('emit');
    expect(segmenter.next(card)).toBe('emit');
  });

  test('the first card after visible text splits the block', () => {
    const segmenter = createSegmenter();
    expect(segmenter.next(card)).toBe('emit');
    expect(segmenter.next('here is what i found')).toBe('append');
    expect(segmenter.next(card)).toBe('split');
  });

  test('whitespace between tool calls does NOT split the block', () => {
    // The "three plan blocks, nothing written between them" bug.
    const segmenter = createSegmenter();
    expect(segmenter.next(card)).toBe('emit');
    expect(segmenter.next('\n')).toBe('append');
    expect(segmenter.next('  ')).toBe('append');
    expect(segmenter.next(card)).toBe('emit');
    expect(segmenter.sawText()).toBe(false);
  });

  test('whitespace after real text does not un-set the split', () => {
    const segmenter = createSegmenter();
    expect(segmenter.next('done')).toBe('append');
    expect(segmenter.next('\n')).toBe('append');
    expect(segmenter.next(card)).toBe('split');
  });

  test('text is always appended, never dropped', () => {
    const segmenter = createSegmenter();
    for (const value of ['a', '\n', 'b', '   ']) {
      expect(segmenter.next(value)).toBe('append');
    }
  });

  test('a fresh segmenter starts a new block clean', () => {
    // Each block gets its own, so the previous block's text must not make the
    // next one split on its very first card.
    const first = createSegmenter();
    first.next('text');
    expect(first.next(card)).toBe('split');
    const second = createSegmenter();
    expect(second.next(card)).toBe('emit');
  });
});
