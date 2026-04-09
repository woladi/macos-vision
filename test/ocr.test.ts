import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  ocr, VisionBlock, rasterizePdf, PdfPage, inferLayout,
  detectFaces, Face,
  detectBarcodes, Barcode,
  detectRectangles, Rectangle,
  detectDocument,
  classify, Classification,
} from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE_IMG = resolve(__dirname, 'fixtures/sample.png');
const SAMPLE_PDF = resolve(__dirname, 'fixtures/sample.pdf');
const MULTIPAGE_PDF = resolve(__dirname, 'fixtures/test-multipage.pdf');

// ─── OCR ─────────────────────────────────────────────────────────────────────

describe('ocr() — format: text', () => {
  it('returns a non-empty string', async () => {
    const text = await ocr(SAMPLE_IMG);
    expect(typeof text).toBe('string');
    expect((text as string).length).toBeGreaterThan(0);
  });

  it('contains known text from fixture', async () => {
    const text = await ocr(SAMPLE_IMG);
    expect(text as string).toContain('Henry VIII');
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
      expect(b.confidence).toBeGreaterThanOrEqual(0);
      expect(b.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('at least one block contains known text from fixture', async () => {
    const blocks = await ocr(SAMPLE_IMG, { format: 'blocks' }) as VisionBlock[];
    const texts = blocks.map(b => b.text);
    expect(texts.some(t => t.includes('Henry VIII') || t.includes('Wikipedia'))).toBe(true);
  });
});

describe('ocr() — error handling', () => {
  it('throws on non-existent file', async () => {
    await expect(ocr('/tmp/nonexistent-macos-vision-test.png')).rejects.toThrow();
  });
});

// ─── Face detection ──────────────────────────────────────────────────────────

describe('detectFaces()', () => {
  it('returns an array', async () => {
    const faces = await detectFaces(SAMPLE_IMG);
    expect(Array.isArray(faces)).toBe(true);
  });

  it('face objects have valid structure and coordinates', async () => {
    const faces = await detectFaces(SAMPLE_IMG) as Face[];
    for (const f of faces) {
      expect(typeof f.x).toBe('number');
      expect(typeof f.y).toBe('number');
      expect(typeof f.width).toBe('number');
      expect(typeof f.height).toBe('number');
      expect(f.x).toBeGreaterThanOrEqual(0);
      expect(f.y).toBeGreaterThanOrEqual(0);
      expect(f.confidence).toBeGreaterThanOrEqual(0);
      expect(f.confidence).toBeLessThanOrEqual(1);
    }
  });
});

// ─── Barcode detection ───────────────────────────────────────────────────────

describe('detectBarcodes()', () => {
  it('returns an array', async () => {
    const codes = await detectBarcodes(SAMPLE_IMG);
    expect(Array.isArray(codes)).toBe(true);
  });

  it('barcode objects have valid structure', async () => {
    const codes = await detectBarcodes(SAMPLE_IMG) as Barcode[];
    for (const c of codes) {
      expect(typeof c.type).toBe('string');
      expect(typeof c.value).toBe('string');
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.width).toBeGreaterThan(0);
      expect(c.height).toBeGreaterThan(0);
      expect(c.confidence).toBeGreaterThanOrEqual(0);
      expect(c.confidence).toBeLessThanOrEqual(1);
    }
  });
});

// ─── Rectangle detection ─────────────────────────────────────────────────────

describe('detectRectangles()', () => {
  it('returns an array', async () => {
    const rects = await detectRectangles(SAMPLE_IMG);
    expect(Array.isArray(rects)).toBe(true);
  });

  it('rectangle objects have four corners and confidence', async () => {
    const rects = await detectRectangles(SAMPLE_IMG) as Rectangle[];
    for (const r of rects) {
      expect(Array.isArray(r.topLeft)).toBe(true);
      expect(r.topLeft).toHaveLength(2);
      expect(Array.isArray(r.topRight)).toBe(true);
      expect(Array.isArray(r.bottomLeft)).toBe(true);
      expect(Array.isArray(r.bottomRight)).toBe(true);
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
    }
  });
});

// ─── Document detection ──────────────────────────────────────────────────────

describe('detectDocument()', () => {
  it('returns DocumentBounds or null', async () => {
    const doc = await detectDocument(SAMPLE_IMG);
    expect(doc === null || typeof doc === 'object').toBe(true);
  });

  it('DocumentBounds has valid structure when present', async () => {
    const doc = await detectDocument(SAMPLE_IMG);
    if (doc !== null) {
      expect(Array.isArray(doc.topLeft)).toBe(true);
      expect(doc.topLeft).toHaveLength(2);
      expect(doc.confidence).toBeGreaterThanOrEqual(0);
      expect(doc.confidence).toBeLessThanOrEqual(1);
    }
  });
});

// ─── Image classification ────────────────────────────────────────────────────

describe('classify()', () => {
  it('returns a non-empty array', async () => {
    const labels = await classify(SAMPLE_IMG);
    expect(Array.isArray(labels)).toBe(true);
    expect((labels as Classification[]).length).toBeGreaterThan(0);
  });

  it('classifications have identifier and valid confidence', async () => {
    const labels = await classify(SAMPLE_IMG) as Classification[];
    for (const l of labels) {
      expect(typeof l.identifier).toBe('string');
      expect(l.identifier.length).toBeGreaterThan(0);
      expect(l.confidence).toBeGreaterThan(0);
      expect(l.confidence).toBeLessThanOrEqual(1);
    }
  });
});

// ─── PDF support ─────────────────────────────────────────────────────────────

describe('ocr() — PDF, format: text', () => {
  it('returns a non-empty string for a PDF', async () => {
    const text = await ocr(SAMPLE_PDF);
    expect(typeof text).toBe('string');
    expect((text as string).length).toBeGreaterThan(0);
  });

  it('contains known text from fixture PDF', async () => {
    const text = await ocr(SAMPLE_PDF) as string;
    expect(text).toMatch(/Henry VIII|Wikipedia/);
  });
});

describe('ocr() — PDF, format: blocks', () => {
  it('returns a flat VisionBlock[] with page field', async () => {
    const blocks = await ocr(SAMPLE_PDF, { format: 'blocks' }) as VisionBlock[];
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) {
      expect(b.page).toBe(0);
      expect(b.confidence).toBeGreaterThanOrEqual(0);
      expect(b.confidence).toBeLessThanOrEqual(1);
    }
  });
});

describe('rasterizePdf()', () => {
  it('returns pages array and cacheDir', async () => {
    const result = await rasterizePdf(SAMPLE_PDF);
    expect(Array.isArray(result.pages)).toBe(true);
    expect(result.pages.length).toBeGreaterThan(0);
    expect(typeof result.cacheDir).toBe('string');
    expect(result.cacheDir.length).toBeGreaterThan(0);
  });

  it('each page has 0-based index and existing PNG path', async () => {
    const { pages } = await rasterizePdf(SAMPLE_PDF);
    for (const p of pages as PdfPage[]) {
      expect(typeof p.page).toBe('number');
      expect(p.page).toBeGreaterThanOrEqual(0);
      expect(p.path).toMatch(/\.png$/i);
      expect(existsSync(p.path)).toBe(true);
    }
  });

  it('single-page PDF produces page index 0', async () => {
    const { pages } = await rasterizePdf(SAMPLE_PDF);
    expect(pages[0].page).toBe(0);
  });
});

// ─── Multi-page PDF ───────────────────────────────────────────────────────────

describe('rasterizePdf() — multi-page PDF', () => {
  it('returns exactly 3 pages', async () => {
    const { pages } = await rasterizePdf(MULTIPAGE_PDF);
    expect(pages.length).toBe(3);
  });

  it('pages are 0-indexed sequentially (0, 1, 2)', async () => {
    const { pages } = await rasterizePdf(MULTIPAGE_PDF);
    expect(pages.map((p) => p.page)).toEqual([0, 1, 2]);
  });

  it('all PNG files physically exist on disk', async () => {
    const { pages } = await rasterizePdf(MULTIPAGE_PDF);
    for (const p of pages as PdfPage[]) {
      expect(existsSync(p.path)).toBe(true);
    }
  });

  it('filenames are zero-padded (page-001, page-002, page-003)', async () => {
    const { pages } = await rasterizePdf(MULTIPAGE_PDF);
    expect(pages[0].path).toMatch(/page-001\.png$/);
    expect(pages[1].path).toMatch(/page-002\.png$/);
    expect(pages[2].path).toMatch(/page-003\.png$/);
  });

  it('all pages share the same cacheDir', async () => {
    const { pages, cacheDir } = await rasterizePdf(MULTIPAGE_PDF);
    for (const p of pages as PdfPage[]) {
      expect(p.path.startsWith(cacheDir)).toBe(true);
    }
  });
});

describe('ocr() — multi-page PDF, format: blocks', () => {
  it('returns blocks from all 3 pages', async () => {
    const blocks = (await ocr(MULTIPAGE_PDF, { format: 'blocks' })) as VisionBlock[];
    const pageIndices = [...new Set(blocks.map((b) => b.page))].sort();
    expect(pageIndices).toEqual([0, 1, 2]);
  }, 30_000);

  it('each block has a valid page field (0–2)', async () => {
    const blocks = (await ocr(MULTIPAGE_PDF, { format: 'blocks' })) as VisionBlock[];
    for (const b of blocks) {
      expect(b.page).toBeGreaterThanOrEqual(0);
      expect(b.page).toBeLessThanOrEqual(2);
    }
  }, 30_000);

  it('result is a flat array with text on every block', async () => {
    const blocks = (await ocr(MULTIPAGE_PDF, { format: 'blocks' })) as VisionBlock[];
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.every((b) => typeof b.text === 'string')).toBe(true);
  }, 30_000);
});

describe('ocr() — multi-page PDF, format: text', () => {
  it('contains exactly 2 page break markers for 3 pages', async () => {
    const text = (await ocr(MULTIPAGE_PDF)) as string;
    const segments = text.split('\n\n--- Page Break ---\n\n');
    expect(segments.length).toBe(3);
  }, 30_000);

  it('each page segment is non-empty', async () => {
    const text = (await ocr(MULTIPAGE_PDF)) as string;
    const segments = text.split('\n\n--- Page Break ---\n\n');
    for (const segment of segments) {
      expect(segment.trim().length).toBeGreaterThan(0);
    }
  }, 30_000);
});

describe('inferLayout() — multi-page awareness', () => {
  it('page-filtered blocks produce locally 0-based lineId per page', async () => {
    const blocks = (await ocr(MULTIPAGE_PDF, { format: 'blocks' })) as VisionBlock[];
    for (let pageIdx = 0; pageIdx < 3; pageIdx++) {
      const pageBlocks = blocks.filter((b) => b.page === pageIdx);
      const layout = inferLayout({ textBlocks: pageBlocks });
      const lineIds = layout.flatMap((b) => (b.kind === 'text' ? [b.lineId] : []));
      if (lineIds.length > 0) {
        expect(Math.min(...lineIds)).toBe(0);
      }
    }
  }, 30_000);
});
