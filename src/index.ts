import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolve, dirname, extname, join } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { open, mkdir, readdir, rm } from 'fs/promises';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN_PATH = resolve(__dirname, '../bin/vision-helper');
const BINARY_TIMEOUT_MS = 30_000;
const SIPS_TIMEOUT_MS = 60_000;

async function run(flag: string, imagePath: string): Promise<string> {
  const { stdout } = await execFileAsync(BIN_PATH, [flag, resolve(imagePath)], {
    timeout: BINARY_TIMEOUT_MS,
  });
  return stdout;
}

// ─── PDF helpers ─────────────────────────────────────────────────────────────

/**
 * Returns true if the file at `filePath` is a PDF.
 * Uses extension as a fast path; falls back to magic bytes (`%PDF`) for
 * files whose extension does not match their actual content.
 */
async function isPdf(filePath: string): Promise<boolean> {
  if (extname(filePath).toLowerCase() === '.pdf') return true;
  let fh;
  try {
    fh = await open(filePath, 'r');
    const buf = Buffer.alloc(4);
    await fh.read(buf, 0, 4, 0);
    return buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;
  } finally {
    await fh?.close();
  }
}

/**
 * Rasterizes a PDF to PNG files in `outDir` using macOS `sips`.
 * Returns sorted list of absolute PNG paths (order = page order).
 *
 * sips names single-page output `{basename}.png` and multi-page output
 * `{basename}-1.png`, `{basename}-2.png`, etc. The numeric sort handles both.
 */
async function rasterizePdf(pdfPath: string, outDir: string): Promise<string[]> {
  await execFileAsync(
    'sips',
    ['-s', 'format', 'png', '--resampleHeight', '2000', pdfPath, '--out', outDir],
    { timeout: SIPS_TIMEOUT_MS }
  );
  const entries = await readdir(outDir);
  const pngs = entries.filter((n) => n.toLowerCase().endsWith('.png'));
  pngs.sort((a, b) => {
    const numA = parseInt(a.match(/-(\d+)\.png$/i)?.[1] ?? '0', 10);
    const numB = parseInt(b.match(/-(\d+)\.png$/i)?.[1] ?? '0', 10);
    return numA - numB;
  });
  return pngs.map((n) => join(outDir, n));
}

/**
 * Full PDF OCR pipeline: rasterize → per-page OCR → merge results.
 * Temporary PNG files are always cleaned up in the `finally` block.
 */
async function ocrPdf(pdfPath: string, format: 'text' | 'blocks'): Promise<string | VisionBlock[]> {
  const outDir = join(tmpdir(), `macos-vision-${globalThis.crypto.randomUUID()}`);
  await mkdir(outDir, { recursive: true });
  try {
    const pages = await rasterizePdf(pdfPath, outDir);
    if (format === 'blocks') {
      const all: VisionBlock[] = [];
      for (let i = 0; i < pages.length; i++) {
        const blocks = (await ocr(pages[i], { format: 'blocks' })) as VisionBlock[];
        all.push(...blocks.map((b) => ({ ...b, page: i })));
      }
      return all;
    }
    const texts: string[] = [];
    for (let i = 0; i < pages.length; i++) {
      texts.push((await ocr(pages[i])) as string);
    }
    return texts.join('\n\n--- Page Break ---\n\n');
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

// ─── OCR ─────────────────────────────────────────────────────────────────────

export interface VisionBlock {
  /** Recognized text */
  text: string;
  /** Horizontal position, 0–1 from left */
  x: number;
  /** Vertical position, 0–1 from top */
  y: number;
  /** Width, 0–1 relative to image */
  width: number;
  /** Height, 0–1 relative to image */
  height: number;
  /** OCR transcription confidence, 0–1 */
  confidence: number;
  /** 0-based page index. Present only when the source was a PDF. Absent for images. */
  page?: number;
}

export interface OcrOptions {
  /** Return plain text (default) or structured blocks with coordinates */
  format?: 'text' | 'blocks';
}

export async function ocr(imagePath: string, options?: { format?: 'text' }): Promise<string>;
export async function ocr(imagePath: string, options: { format: 'blocks' }): Promise<VisionBlock[]>;
export async function ocr(
  imagePath: string,
  options: OcrOptions = {}
): Promise<string | VisionBlock[]> {
  const absPath = resolve(imagePath);
  const { format = 'text' } = options;

  // ── PDF fast-path: rasterize via sips, then OCR each page ────────────────
  if (await isPdf(absPath)) {
    return ocrPdf(absPath, format);
  }

  // ── Existing image path (unchanged) ──────────────────────────────────────
  if (format === 'blocks') {
    const { stdout } = await execFileAsync(BIN_PATH, ['--json', absPath], {
      timeout: BINARY_TIMEOUT_MS,
    });
    const raw: Array<{
      t: string;
      x: number;
      y: number;
      w: number;
      h: number;
      confidence: number;
    }> = JSON.parse(stdout);
    return raw.map((b) => ({
      text: b.t,
      x: b.x,
      y: b.y,
      width: b.w,
      height: b.h,
      confidence: b.confidence,
    }));
  }

  const { stdout } = await execFileAsync(BIN_PATH, [absPath], { timeout: BINARY_TIMEOUT_MS });
  return stdout.trim();
}

// ─── Face detection ──────────────────────────────────────────────────────────

export interface Face {
  /** Horizontal position, 0–1 from left */
  x: number;
  /** Vertical position, 0–1 from top */
  y: number;
  /** Width, 0–1 relative to image */
  width: number;
  /** Height, 0–1 relative to image */
  height: number;
  /** Detection confidence, 0–1 */
  confidence: number;
}

export async function detectFaces(imagePath: string): Promise<Face[]> {
  const raw: Array<{ x: number; y: number; w: number; h: number; confidence: number }> = JSON.parse(
    await run('--faces', imagePath)
  );
  return raw.map((f) => ({ x: f.x, y: f.y, width: f.w, height: f.h, confidence: f.confidence }));
}

// ─── Barcode / QR detection ──────────────────────────────────────────────────

export interface Barcode {
  /** Symbology type, e.g. 'org.iso.QRCode', 'org.gs1.EAN-13', 'org.iso.Code128' */
  type: string;
  /** Decoded payload value */
  value: string;
  /** Horizontal position, 0–1 from left */
  x: number;
  /** Vertical position, 0–1 from top */
  y: number;
  /** Width, 0–1 relative to image */
  width: number;
  /** Height, 0–1 relative to image */
  height: number;
  /** Detection confidence, 0–1 */
  confidence: number;
}

export async function detectBarcodes(imagePath: string): Promise<Barcode[]> {
  const raw: Array<{
    type: string;
    value: string;
    x: number;
    y: number;
    w: number;
    h: number;
    confidence: number;
  }> = JSON.parse(await run('--barcodes', imagePath));
  return raw.map((b) => ({
    type: b.type,
    value: b.value,
    x: b.x,
    y: b.y,
    width: b.w,
    height: b.h,
    confidence: b.confidence,
  }));
}

// ─── Rectangle detection ─────────────────────────────────────────────────────

export interface Rectangle {
  /** Top-left corner [x, y], values 0–1 */
  topLeft: [number, number];
  /** Top-right corner [x, y], values 0–1 */
  topRight: [number, number];
  /** Bottom-left corner [x, y], values 0–1 */
  bottomLeft: [number, number];
  /** Bottom-right corner [x, y], values 0–1 */
  bottomRight: [number, number];
  /** Detection confidence, 0–1 */
  confidence: number;
}

export async function detectRectangles(imagePath: string): Promise<Rectangle[]> {
  const raw: Array<{
    topLeft: [number, number];
    topRight: [number, number];
    bottomLeft: [number, number];
    bottomRight: [number, number];
    confidence: number;
  }> = JSON.parse(await run('--rectangles', imagePath));
  return raw;
}

// ─── Document detection ──────────────────────────────────────────────────────

export interface DocumentBounds {
  /** Top-left corner [x, y], values 0–1 */
  topLeft: [number, number];
  /** Top-right corner [x, y], values 0–1 */
  topRight: [number, number];
  /** Bottom-left corner [x, y], values 0–1 */
  bottomLeft: [number, number];
  /** Bottom-right corner [x, y], values 0–1 */
  bottomRight: [number, number];
  /** Detection confidence, 0–1 */
  confidence: number;
}

/** Returns the detected document boundary, or null if no document found. */
export async function detectDocument(imagePath: string): Promise<DocumentBounds | null> {
  const raw: DocumentBounds[] = JSON.parse(await run('--document', imagePath));
  return raw.length > 0 ? raw[0] : null;
}

// ─── Image classification ────────────────────────────────────────────────────

export interface Classification {
  /** Category identifier, e.g. 'document', 'outdoor', 'animal' */
  identifier: string;
  /** Confidence score, 0–1 */
  confidence: number;
}

/** Returns top image classifications sorted by confidence (highest first). */
export async function classify(imagePath: string): Promise<Classification[]> {
  const raw: Classification[] = JSON.parse(await run('--classify', imagePath));
  return raw;
}

// ─── Layout inference ─────────────────────────────────────────────────────────

export type {
  BlockKind,
  BaseBlock,
  TextBlock,
  FaceBlock,
  BarcodeBlock,
  RectangleBlock,
  DocumentBlock,
  LayoutBlock,
  InferLayoutInput,
} from './layout.js';
export { inferLayout, sortBlocksByReadingOrder } from './layout.js';
