import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolve, dirname, extname, dirname as pathDirname } from 'path';
import { fileURLToPath } from 'url';
import { open, readFile, writeFile, mkdir } from 'fs/promises';
import { createHash } from 'crypto';
import { homedir } from 'os';
import { textOptionArgs } from './vision.js';
import type { TextRecognitionOptions } from './vision.js';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN_PATH = resolve(__dirname, '../bin/vision-helper');
const PDF_BIN_PATH = resolve(__dirname, '../bin/pdf-helper');
const BINARY_TIMEOUT_MS = 30_000;
const PDF_RASTERIZE_TIMEOUT_MS = 120_000;
const OCR_CACHE_DIR = resolve(homedir(), '.cache', 'macos-vision', 'ocr');

async function run(flag: string, imagePath: string): Promise<string> {
  const { stdout } = await execFileAsync(BIN_PATH, [flag, resolve(imagePath)], {
    timeout: BINARY_TIMEOUT_MS,
  });
  return stdout;
}

// ─── PDF helpers ─────────────────────────────────────────────────────

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

export interface PdfPage {
  /** 0-based page index */
  page: number;
  /** Absolute path to the rasterized PNG file */
  path: string;
}

export interface PdfRasterizeResult {
  /** Pages in document order */
  pages: PdfPage[];
  /** Directory containing all rasterized PNGs */
  cacheDir: string;
}

export interface PdfPageRangeOptions {
  /** First page to process, 1-based. Default: 1. Ignored for non-PDF inputs. */
  startPage?: number;
  /** Maximum number of pages to process. Default: all pages from `startPage`. Ignored for non-PDF inputs. */
  maxPages?: number;
  /** Called after each page is OCR'd (PDF inputs only). `done` counts from 1. */
  onProgress?: (done: number, total: number) => void;
}

function buildPdfArgs(absPath: string, options: PdfPageRangeOptions): string[] {
  const args: string[] = [];
  if (options.startPage !== undefined) {
    if (!Number.isInteger(options.startPage) || options.startPage < 1) {
      throw new RangeError('startPage must be an integer >= 1');
    }
    args.push('--start-page', String(options.startPage));
  }
  if (options.maxPages !== undefined) {
    if (!Number.isInteger(options.maxPages) || options.maxPages < 1) {
      throw new RangeError('maxPages must be an integer >= 1');
    }
    args.push('--max-pages', String(options.maxPages));
  }
  args.push(absPath);
  return args;
}

/**
 * Rasterizes a PDF to 300 DPI PNG files using the native `pdf-helper` binary
 * (PDFKit-based). Files are saved persistently to `~/.cache/macos-vision/`
 * so they can be reused by downstream tools — **caller is responsible for cleanup**.
 *
 * @param pdfPath - Absolute or relative path to the PDF file.
 * @param options - Optional `{ startPage, maxPages }` to rasterize a page range. Both 1-based.
 * @returns An object with `pages` (sorted array of `{page, path}`) and `cacheDir`.
 */
export async function rasterizePdf(
  pdfPath: string,
  options: PdfPageRangeOptions = {}
): Promise<PdfRasterizeResult> {
  const absPath = resolve(pdfPath);
  const args = buildPdfArgs(absPath, options);
  const { stdout } = await execFileAsync(PDF_BIN_PATH, args, {
    timeout: PDF_RASTERIZE_TIMEOUT_MS,
  });
  const pages: PdfPage[] = JSON.parse(stdout);
  const cacheDir = pages.length > 0 ? pathDirname(pages[0].path) : '';
  return { pages, cacheDir };
}

/**
 * Internal PDF OCR pipeline: rasterize via pdf-helper → OCR each page → merge.
 * PNG files are NOT cleaned up — they persist in ~/.cache/macos-vision/.
 */
async function ocrPdf(
  pdfPath: string,
  format: 'text' | 'blocks',
  options: OcrOptions = {}
): Promise<string | VisionBlock[]> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { startPage, maxPages, onProgress, format: _format, ...textOptions } = options;
  const { pages } = await rasterizePdf(pdfPath, { startPage, maxPages });
  if (format === 'blocks') {
    const all: VisionBlock[] = [];
    for (const [i, { page, path: pagePath }] of pages.entries()) {
      const blocks = (await ocr(pagePath, { ...textOptions, format: 'blocks' })) as VisionBlock[];
      all.push(...blocks.map((b) => ({ ...b, page })));
      onProgress?.(i + 1, pages.length);
    }
    return all;
  }
  const texts: string[] = [];
  for (const [i, { path: pagePath }] of pages.entries()) {
    texts.push((await ocr(pagePath, { ...textOptions, format: 'text' })) as string);
    onProgress?.(i + 1, pages.length);
  }
  return texts.join('\n\n--- Page Break ---\n\n');
}

// ─── OCR result cache ────────────────────────────────────────────────────────

/** SHA-256 of a file's bytes, hex. */
export async function fileSha256(filePath: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex');
}

async function cacheKey(
  absPath: string,
  format: string,
  opts: TextRecognitionOptions
): Promise<string> {
  const content = await fileSha256(absPath);
  const optsKey = JSON.stringify({
    format,
    ...opts,
    regionOfInterest: opts.regionOfInterest ?? null,
  });
  return createHash('sha256').update(content).update(optsKey).digest('hex');
}

async function readCache<T>(key: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(resolve(OCR_CACHE_DIR, `${key}.json`), 'utf8')) as T;
  } catch {
    return undefined;
  }
}

async function writeCache(key: string, value: unknown): Promise<void> {
  try {
    await mkdir(OCR_CACHE_DIR, { recursive: true });
    await writeFile(resolve(OCR_CACHE_DIR, `${key}.json`), JSON.stringify(value));
  } catch {
    // cache is best-effort
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

export interface OcrOptions extends PdfPageRangeOptions, TextRecognitionOptions {
  /** Return plain text (default) or structured blocks with coordinates */
  format?: 'text' | 'blocks';
  /**
   * Cache results in `~/.cache/macos-vision/ocr/` keyed by file content hash + options.
   * Repeated OCR of the same bytes (e.g. an agent re-reading a screenshot) returns instantly.
   * Default false.
   */
  cache?: boolean;
}

export async function ocr(
  imagePath: string,
  options?: OcrOptions & { format?: 'text' }
): Promise<string>;
export async function ocr(
  imagePath: string,
  options: OcrOptions & { format: 'blocks' }
): Promise<VisionBlock[]>;
export async function ocr(
  imagePath: string,
  options: OcrOptions = {}
): Promise<string | VisionBlock[]> {
  const absPath = resolve(imagePath);
  const {
    format = 'text',
    cache = false,
    startPage,
    maxPages,
    onProgress,
    ...textOptions
  } = options;

  // ── PDF fast-path: rasterize via pdf-helper, then OCR each page ──────
  if (await isPdf(absPath)) {
    return ocrPdf(absPath, format, { ...textOptions, cache, startPage, maxPages, onProgress });
  }

  const key = cache ? await cacheKey(absPath, format, textOptions) : undefined;
  if (key) {
    const hit = await readCache<string | VisionBlock[]>(key);
    if (hit !== undefined) return hit;
  }
  const textArgs = textOptionArgs(textOptions);

  if (format === 'blocks') {
    const { stdout } = await execFileAsync(BIN_PATH, ['--json', ...textArgs, absPath], {
      timeout: BINARY_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    const raw: Array<{
      t: string;
      x: number;
      y: number;
      w: number;
      h: number;
      confidence: number;
    }> = JSON.parse(stdout);
    const blocks = raw.map((b) => ({
      text: b.t,
      x: b.x,
      y: b.y,
      width: b.w,
      height: b.h,
      confidence: b.confidence,
    }));
    if (key) await writeCache(key, blocks);
    return blocks;
  }

  const { stdout } = await execFileAsync(BIN_PATH, [...textArgs, absPath], {
    timeout: BINARY_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  const text = stdout.trim();
  if (key) await writeCache(key, text);
  return text;
}

// ─── Face detection ──────────────────────────────────────────────────────

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

// ─── Rectangle detection ───────────────────────────────────────────────────

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

// ─── Image classification ─────────────────────────────────────────────────────

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

// ─── Layout inference ────────────────────────────────────────────────────────────

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

// ─── Markdown pipeline (VisionScribe) ──────────────────────────────────────────
export { VisionScribe, OllamaUnavailableError } from './markdown/index.js';
export type { VisionScribeOptions, ParagraphGroup } from './markdown/index.js';

// ─── UI: screen capture, windows, displays, permissions ────────────────────────
export { listWindows, listDisplays, checkPermissions, captureScreen } from './ui.js';
export type {
  WindowInfo,
  DisplayInfo,
  PermissionsInfo,
  ScreenFrame,
  CaptureResult,
  CaptureOptions,
} from './ui.js';

// ─── Extended Vision API ───────────────────────────────────────────────────────
export {
  visionCapabilities,
  supportedOcrLanguages,
  imageInfo,
  detectTextRegions,
  compareImages,
  extractEntities,
  recognizeDocument,
  detectLensSmudge,
  imageAesthetics,
  detectHorizon,
  detectFaceLandmarks,
  detectHumans,
  detectBodyPose,
  detectHandPose,
  detectAnimalPose,
  detectAnimals,
  detectSaliency,
  detectContours,
  cropImage,
  cropDocument,
  extractForeground,
  personMask,
  UnsupportedOnThisMacOSError,
} from './vision.js';
export type {
  NormalizedRect,
  TextRecognitionOptions,
  VisionCapabilities,
  ImageInfo,
  TextRegion,
  ImageComparison,
  TextEntity,
  DocumentStructure,
  DocText,
  DocLine,
  DocBox,
  DocTable,
  DocCell,
  DocList,
  DocListItem,
  DocDetectedData,
  DocBarcode,
  LensSmudge,
  AestheticsScore,
  Horizon,
  FaceLandmarks,
  HumanBox,
  Keypoint,
  Pose,
  Animal,
  SaliencyOptions,
  Saliency,
  ContourOptions,
  Contour,
  Contours,
  CropResult,
  MaskResult,
  ForegroundOptions,
} from './vision.js';
