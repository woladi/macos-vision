import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ocr, VisionBlock } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE_IMG = resolve(__dirname, 'fixtures/sample.png');

describe('ocr() — format: text', () => {
  it('returns a non-empty string', async () => {
    const text = await ocr(SAMPLE_IMG);
    expect(typeof text).toBe('string');
    expect((text as string).length).toBeGreaterThan(0);
  });

  it('contains known text from fixture', async () => {
    const text = await ocr(SAMPLE_IMG);
    expect(text as string).toContain('alicjadobosz');
  });
});

describe('ocr() — format: blocks', () => {
  it('returns an array of blocks', async () => {
    const blocks = await ocr(SAMPLE_IMG, { format: 'blocks' });
    expect(Array.isArray(blocks)).toBe(true);
    expect((blocks as VisionBlock[]).length).toBeGreaterThan(0);
  });

  it('every block has valid coordinates (0–1) and text', async () => {
    const blocks = await ocr(SAMPLE_IMG, { format: 'blocks' }) as VisionBlock[];
    for (const b of blocks) {
      expect(typeof b.text).toBe('string');
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x).toBeLessThanOrEqual(1);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeLessThanOrEqual(1);
      expect(b.width).toBeGreaterThan(0);
      expect(b.height).toBeGreaterThan(0);
    }
  });

  it('at least one block contains known text from fixture', async () => {
    const blocks = await ocr(SAMPLE_IMG, { format: 'blocks' }) as VisionBlock[];
    const texts = blocks.map(b => b.text);
    expect(texts.some(t => t.includes('alicjadobosz') || t.includes('Wyniki'))).toBe(true);
  });
});

describe('ocr() — error handling', () => {
  it('throws on non-existent file', async () => {
    await expect(ocr('/tmp/nonexistent-macos-vision-test.png')).rejects.toThrow();
  });
});
