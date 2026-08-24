import { describe, it, expect } from 'vitest';
import { mergeOcrWithTree, blockToScreenBox, normalize } from '../src/snapshot.js';
import type { AxTree, AxNode } from '../src/ax.js';
import type { VisionBlock } from '../src/index.js';

const frame = { x: 0, y: 0, w: 1000, h: 500 };

const node = (over: Partial<AxNode> & Pick<AxNode, 'id' | 'box'>): AxNode => ({
  depth: 1,
  role: 'StaticText',
  ...over,
});

const tree = (nodes: AxNode[], capped = false): AxTree => ({
  app: 'Test',
  pid: 1,
  source: 'ax',
  budget: {
    elements: nodes.length,
    capped,
    maxElements: 100,
    maxDepth: 40,
    elapsedMs: 1,
    culled: 0,
  },
  nodes,
});

/** A block occupying the given normalized rect, with the given text. */
const block = (
  text: string,
  x: number,
  y: number,
  over: Partial<VisionBlock> = {}
): VisionBlock => ({
  text,
  x,
  y,
  width: 0.1,
  height: 0.04,
  confidence: 0.95,
  ...over,
});

describe('normalize', () => {
  it('preserves ASCII — the whitespace class must not swallow it', () => {
    expect(normalize('80 Artifacts')).toBe('80 artifacts');
    for (let c = 0x21; c <= 0x7e; c++) {
      expect(normalize(String.fromCharCode(c))).not.toBe('');
    }
  });

  it('folds unicode spaces, dashes and quotes', () => {
    expect(normalize('Zapisz plik')).toBe('zapisz plik');
    expect(normalize('e‑mail')).toBe('e-mail');
    expect(normalize('“Cytat”')).toBe('"cytat"');
  });
});

describe('blockToScreenBox', () => {
  it('maps normalized image coordinates onto screen points', () => {
    expect(blockToScreenBox(block('x', 0.5, 0.5), frame)).toEqual([500, 250, 100, 20]);
  });

  it('offsets by the capture frame origin', () => {
    expect(blockToScreenBox(block('x', 0, 0), { x: 100, y: 50, w: 1000, h: 500 })).toEqual([
      100, 50, 100, 20,
    ]);
  });
});

describe('mergeOcrWithTree', () => {
  it('treats text as accounted for when a covering node says the same thing', () => {
    const t = tree([node({ id: 1, box: [400, 200, 200, 100], label: 'Zapisz' })]);
    const { unresolved, summary } = mergeOcrWithTree(t, [block('Zapisz', 0.45, 0.45)], frame);
    expect(unresolved).toHaveLength(0);
    expect(summary.axTextCoverage).toBe(1);
  });

  it('matches when the AX label is longer than the visible run', () => {
    const t = tree([node({ id: 1, box: [0, 0, 1000, 500], label: 'Zapisz zmiany w dokumencie' })]);
    const { unresolved } = mergeOcrWithTree(t, [block('Zapisz zmiany', 0.4, 0.4)], frame);
    expect(unresolved).toHaveLength(0);
  });

  it('reports text no node covers at all', () => {
    const t = tree([node({ id: 1, box: [0, 0, 10, 10], label: 'gdzie indziej' })]);
    const { unresolved, summary } = mergeOcrWithTree(t, [block('Kanwa', 0.5, 0.5)], frame);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].text).toBe('Kanwa');
    expect(unresolved[0].coveredByNode).toBeUndefined();
    expect(summary.axTextCoverage).toBe(0);
  });

  it('names the covering node when one exists but exposes no matching text', () => {
    const t = tree([node({ id: 7, box: [0, 0, 1000, 500], role: 'Group' })]);
    const { unresolved } = mergeOcrWithTree(t, [block('Nieopisany przycisk', 0.5, 0.5)], frame);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].coveredByNode).toBe(7);
  });

  it('prefers the smallest covering node as the candidate', () => {
    const t = tree([
      node({ id: 1, box: [0, 0, 1000, 500], role: 'Window' }),
      node({ id: 2, box: [450, 220, 120, 60], role: 'Button' }),
    ]);
    const { unresolved } = mergeOcrWithTree(t, [block('OK', 0.5, 0.5)], frame);
    expect(unresolved[0].coveredByNode).toBe(2);
  });

  it('ignores OCR noise below the confidence floor', () => {
    const t = tree([]);
    const { unresolved, summary } = mergeOcrWithTree(
      t,
      [block('szum', 0.5, 0.5, { confidence: 0.1 })],
      frame
    );
    expect(unresolved).toHaveLength(0);
    expect(summary.ocrBlocks).toBe(0);
  });

  it('withholds a coverage figure when the walk was capped', () => {
    // Otherwise the number measures how much of the tree we looked at, and reads
    // as an accusation that the app is inaccessible.
    const t = tree([node({ id: 1, box: [0, 0, 10, 10] })], true);
    const { summary } = mergeOcrWithTree(t, [block('cokolwiek', 0.5, 0.5)], frame);
    expect(summary.axTextCoverage).toBeNull();
    expect(summary.cappedWalk).toBe(true);
  });

  it('reports full coverage rather than dividing by zero on an empty screen', () => {
    const { summary } = mergeOcrWithTree(tree([]), [], frame);
    expect(summary.axTextCoverage).toBe(1);
  });

  it('counts labelled nodes for the summary', () => {
    const t = tree([
      node({ id: 1, box: [0, 0, 10, 10], label: 'a' }),
      node({ id: 2, box: [0, 0, 10, 10], value: 'b' }),
      node({ id: 3, box: [0, 0, 10, 10] }),
    ]);
    const { summary } = mergeOcrWithTree(t, [], frame);
    expect(summary.nodes).toBe(3);
    expect(summary.labelled).toBe(2);
  });
});
