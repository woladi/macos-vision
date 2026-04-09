/**
 * @module layout
 *
 * Pure TypeScript layout inference layer for macos-vision.
 *
 * Takes raw Vision framework results and produces a unified, reading-order-sorted
 * `LayoutBlock[]` that downstream tools (Markdown generators, LLM pipelines, etc.)
 * can consume directly.
 *
 * **Limitations & intended usage**
 * - This is a heuristic layer, not a full document parser. Line and paragraph
 *   grouping uses simple geometric proximity — it will not be perfect for
 *   multi-column layouts, rotated text, or unusual document structures.
 * - No LLMs, no external dependencies, no I/O. Pure data-in → data-out.
 * - Treat the output as a structured starting point, not ground truth.
 */

import type { VisionBlock, Face, Barcode, Rectangle, DocumentBounds } from './index.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export type BlockKind = 'text' | 'face' | 'barcode' | 'rectangle' | 'document';

export interface BaseBlock {
  kind: BlockKind;
  /** Horizontal position, 0–1 from left */
  x: number;
  /** Vertical position, 0–1 from top */
  y: number;
  /** Width, 0–1 relative to image */
  width: number;
  /** Height, 0–1 relative to image */
  height: number;
  /** Detection/recognition confidence, 0–1 (omitted when unavailable) */
  confidence?: number;
}

export interface TextBlock extends BaseBlock {
  kind: 'text';
  /** Recognized text string */
  text: string;
  /**
   * 0-based index of the visual line this block belongs to.
   * Blocks sharing the same `lineId` are on the same horizontal line.
   */
  lineId: number;
  /**
   * 0-based index of the paragraph this block belongs to.
   * A new paragraph begins when the vertical gap between lines exceeds
   * ~1.5× the average line height.
   */
  paragraphId: number;
}

export interface FaceBlock extends BaseBlock {
  kind: 'face';
}

export interface BarcodeBlock extends BaseBlock {
  kind: 'barcode';
  /** Decoded barcode / QR payload */
  value: string;
  /** Symbology, e.g. 'org.iso.QRCode', 'org.gs1.EAN-13' */
  type: string;
}

export interface RectangleBlock extends BaseBlock {
  kind: 'rectangle';
}

export interface DocumentBlock extends BaseBlock {
  kind: 'document';
}

export type LayoutBlock = TextBlock | FaceBlock | BarcodeBlock | RectangleBlock | DocumentBlock;

export interface InferLayoutInput {
  textBlocks: VisionBlock[];
  faces?: Face[];
  barcodes?: Barcode[];
  rectangles?: Rectangle[];
  document?: DocumentBounds | null;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Compute an axis-aligned bounding box from four corner points [x, y]. */
function cornersToRect(corners: {
  topLeft: [number, number];
  topRight: [number, number];
  bottomLeft: [number, number];
  bottomRight: [number, number];
}): { x: number; y: number; width: number; height: number } {
  const xs = [
    corners.topLeft[0],
    corners.topRight[0],
    corners.bottomLeft[0],
    corners.bottomRight[0],
  ];
  const ys = [
    corners.topLeft[1],
    corners.topRight[1],
    corners.bottomLeft[1],
    corners.bottomRight[1],
  ];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/**
 * Group text blocks into visual lines using y-center proximity.
 *
 * Two blocks are considered to be on the same line when the distance between
 * their vertical centers is less than 60% of the taller block's height.
 * Blocks within each line are sorted left-to-right by `x`.
 */
function groupTextIntoLines(blocks: VisionBlock[]): VisionBlock[][] {
  if (blocks.length === 0) return [];

  const sorted = [...blocks].sort((a, b) => a.y + a.height / 2 - (b.y + b.height / 2));

  const lines: VisionBlock[][] = [];
  let currentLine: VisionBlock[] = [sorted[0]];
  let lineYCenter = sorted[0].y + sorted[0].height / 2;

  for (let i = 1; i < sorted.length; i++) {
    const block = sorted[i];
    const blockYCenter = block.y + block.height / 2;
    const threshold = Math.max(block.height, sorted[i - 1].height) * 0.6;

    if (Math.abs(blockYCenter - lineYCenter) <= threshold) {
      currentLine.push(block);
      // Recompute line center as the mean of all members so far.
      lineYCenter =
        currentLine.reduce((sum, b) => sum + b.y + b.height / 2, 0) / currentLine.length;
    } else {
      lines.push(currentLine.sort((a, b) => a.x - b.x));
      currentLine = [block];
      lineYCenter = blockYCenter;
    }
  }
  lines.push(currentLine.sort((a, b) => a.x - b.x));

  return lines;
}

/**
 * Assign a paragraph index to each line.
 *
 * A new paragraph begins when the vertical gap between the bottom of one line
 * and the top of the next exceeds 1.5× the average line height across all lines.
 */
function assignParagraphIds(lines: VisionBlock[][]): number[] {
  if (lines.length === 0) return [];

  const lineHeights = lines.map((line) => Math.max(...line.map((b) => b.height)));
  const avgLineHeight = lineHeights.reduce((s, h) => s + h, 0) / lineHeights.length;

  const ids: number[] = [0];
  let paragraphId = 0;

  for (let i = 1; i < lines.length; i++) {
    const prevBottom = Math.max(...lines[i - 1].map((b) => b.y + b.height));
    const currTop = Math.min(...lines[i].map((b) => b.y));
    const gap = currTop - prevBottom;

    if (gap > avgLineHeight * 1.5) paragraphId++;
    ids.push(paragraphId);
  }

  return ids;
}

/**
 * Sort any LayoutBlock array into reading order: top-to-bottom, then
 * left-to-right within blocks that share the same approximate vertical band.
 *
 * Uses a 1% image-height tolerance so that blocks on the same visual row
 * are ordered by `x` rather than by the tiny y differences between them.
 */
export function sortBlocksByReadingOrder(blocks: LayoutBlock[]): LayoutBlock[] {
  return [...blocks].sort((a, b) => {
    const dy = a.y - b.y;
    // Treat blocks as being on the same row when y-difference < 1% of image height.
    if (Math.abs(dy) > 0.01) return dy;
    return a.x - b.x;
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Merge raw Apple Vision results into a unified, reading-order-sorted
 * `LayoutBlock[]`.
 *
 * Text blocks are grouped into **lines** (`lineId`) and **paragraphs**
 * (`paragraphId`) using simple bounding-box heuristics. All other block types
 * are placed into the sorted sequence by their top-left coordinate.
 *
 * **Multi-page PDFs**: `VisionBlock` items from PDF OCR carry an optional `page` field (0-based).
 * Because all coordinates are page-local (0–1 relative to each page), mixing blocks from
 * different pages produces meaningless geometry. Pre-filter by page before calling inferLayout:
 * ```ts
 * const pageBlocks = pdfBlocks.filter(b => b.page === 0);
 * const layout = inferLayout({ textBlocks: pageBlocks });
 * ```
 *
 * @example
 * ```ts
 * const blocks  = await ocr('page.png', { format: 'blocks' });
 * const faces   = await detectFaces('page.png');
 * const barcodes = await detectBarcodes('page.png');
 *
 * const layout = inferLayout({ textBlocks: blocks, faces, barcodes });
 * // Feed `layout` into a Markdown renderer or an LLM context window.
 * ```
 */
export function inferLayout(input: InferLayoutInput): LayoutBlock[] {
  const result: LayoutBlock[] = [];

  // ── Text blocks (with line / paragraph grouping) ──────────────────────────
  const lines = groupTextIntoLines(input.textBlocks);
  const paragraphIds = assignParagraphIds(lines);

  lines.forEach((line, lineId) => {
    const paragraphId = paragraphIds[lineId];
    for (const b of line) {
      result.push({
        kind: 'text',
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
        confidence: b.confidence,
        text: b.text,
        lineId,
        paragraphId,
      });
    }
  });

  // ── Faces ─────────────────────────────────────────────────────────────────
  for (const f of input.faces ?? []) {
    result.push({
      kind: 'face',
      x: f.x,
      y: f.y,
      width: f.width,
      height: f.height,
      confidence: f.confidence,
    });
  }

  // ── Barcodes ──────────────────────────────────────────────────────────────
  for (const b of input.barcodes ?? []) {
    result.push({
      kind: 'barcode',
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      confidence: b.confidence,
      value: b.value,
      type: b.type,
    });
  }

  // ── Rectangles ────────────────────────────────────────────────────────────
  for (const r of input.rectangles ?? []) {
    const bbox = cornersToRect(r);
    result.push({ kind: 'rectangle', ...bbox, confidence: r.confidence });
  }

  // ── Document boundary ─────────────────────────────────────────────────────
  if (input.document) {
    const bbox = cornersToRect(input.document);
    result.push({ kind: 'document', ...bbox, confidence: input.document.confidence });
  }

  return sortBlocksByReadingOrder(result);
}
