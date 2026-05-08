import { describe, it, expect, vi } from 'vitest';
import { estimateTokens, chunkParagraphs } from '../src/markdown/chunker.js';
import type { ParagraphGroup } from '../src/markdown/prompt.js';

function para(id: number, text: string, page = 0): ParagraphGroup {
  return { paragraphId: id, y: id * 0.1, lines: [text], page };
}

describe('estimateTokens', () => {
  it('returns ceil(chars / 4)', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('')).toBe(0);
  });
});

describe('chunkParagraphs', () => {
  it('returns empty array for empty input', () => {
    expect(chunkParagraphs([], 1800)).toEqual([]);
  });

  it('puts single small paragraph in one chunk', () => {
    const result = chunkParagraphs([para(0, 'Hello')], 1800);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(1);
  });

  it('keeps paragraphs together when they fit in budget', () => {
    const paragraphs = [para(0, 'First'), para(1, 'Second')];
    const result = chunkParagraphs(paragraphs, 1800);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(2);
  });

  it('splits into two chunks when combined size exceeds budget', () => {
    // Use a very tight budget so each paragraph requires its own chunk
    const longText = 'x'.repeat(400);
    const p0 = para(0, longText);
    const p1 = para(1, longText);
    // Budget of 200 tokens: each paragraph alone is ~100+ tokens, together > 200
    const result = chunkParagraphs([p0, p1], 200);
    expect(result).toHaveLength(2);
    expect(result[0][0].paragraphId).toBe(0);
    expect(result[1][0].paragraphId).toBe(1);
  });

  it('oversized paragraph is emitted as singleton with a warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hugeText = 'x'.repeat(10_000);
    const result = chunkParagraphs([para(0, hugeText)], 10);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it('preserves page field across chunk boundaries', () => {
    const longText = 'x'.repeat(400);
    const p0 = para(0, longText, 0);
    const p1 = para(0, longText, 1);
    const result = chunkParagraphs([p0, p1], 200);
    expect(result[0][0].page).toBe(0);
    expect(result[1][0].page).toBe(1);
  });

  it('three paragraphs: first two fit, third spills into new chunk', () => {
    const small = 'hello world';
    const large = 'x'.repeat(500);
    const p0 = para(0, small);
    const p1 = para(1, small);
    const p2 = para(2, large);
    // System instruction ~210 tokens + 2 small paras ~12 tokens each = ~234 → fits in 300.
    // Adding large p2 (500 chars ~130 tokens) → ~364 > 300, so p2 spills to new chunk.
    const result = chunkParagraphs([p0, p1, p2], 300);
    expect(result).toHaveLength(2);
    expect(result[0].map(p => p.paragraphId)).toEqual([0, 1]);
    expect(result[1].map(p => p.paragraphId)).toEqual([2]);
  });
});
