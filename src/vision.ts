// Extended Vision API: everything beyond the classic OCR/faces/barcodes set.
//
// All geometry is normalized 0–1 with a TOP-LEFT origin unless stated otherwise.
// Functions that produce pixels (masks, crops, heatmaps) write PNG files and
// return paths — never image bytes.

import { resolve } from 'path';
import {
  VISION_BIN,
  runHelper,
  runGated,
  tmpOutPath,
  UnsupportedOnThisMacOSError,
} from './helper.js';

export { UnsupportedOnThisMacOSError };

// ─── Shared types ────────────────────────────────────────────────────────────

/** Normalized rectangle, 0–1, top-left origin. */
export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A detection: where it is and how sure Vision is. */
export type Detection = NormalizedRect & { confidence: number };

/** Options shared by every text-recognition path (OCR, text regions, document structure). */
export interface TextRecognitionOptions {
  /** BCP-47 codes in priority order, e.g. `['pl-PL', 'en-US']`. See `supportedOcrLanguages()`. */
  languages?: string[];
  /** Let Vision pick the language per text run. Default false. */
  autoDetectLanguage?: boolean;
  /** Apply language-model correction. Default true. Disable for IDs, codes, IBANs, hashes. */
  languageCorrection?: boolean;
  /** Domain vocabulary that should win over the language model, e.g. product names. */
  customWords?: string[];
  /** `.fast` recognition level — noticeably quicker, lower accuracy. Default false. */
  fast?: boolean;
  /** Only look inside this region (normalized, top-left origin). Results are still reported in full-image space. */
  regionOfInterest?: NormalizedRect;
  /** Ignore text shorter than this fraction of image height (0–1). */
  minTextHeight?: number;
}

/** Serialises shared text options into helper flags. Canonical — also used as the OCR cache key. */
export function textOptionArgs(o: TextRecognitionOptions = {}): string[] {
  const args: string[] = [];
  if (o.languages?.length) args.push('--lang', o.languages.join(','));
  if (o.autoDetectLanguage) args.push('--auto-lang');
  if (o.languageCorrection === false) args.push('--no-correction');
  if (o.customWords?.length) args.push('--custom-words', o.customWords.join(','));
  if (o.fast) args.push('--fast');
  if (o.regionOfInterest) {
    const r = o.regionOfInterest;
    args.push('--roi', `${r.x},${r.y},${r.width},${r.height}`);
  }
  if (o.minTextHeight !== undefined) args.push('--min-text-height', String(o.minTextHeight));
  return args;
}

const run = <T>(args: string[], input?: string) =>
  runHelper<T>(VISION_BIN, args, { timeout: 60_000, input });
const gated = <T>(args: string[], feature: string, minVersion: string) =>
  runGated<T>(VISION_BIN, args, feature, minVersion, { timeout: 60_000 });

// ─── Capabilities ────────────────────────────────────────────────────────────

export interface VisionCapabilities {
  /** Version of the bundled `vision-helper` protocol */
  helperVersion: string;
  macosVersion: string;
  /** BCP-47 codes Vision can OCR on this machine */
  ocrLanguages: string[];
  /** Feature → available on this macOS. Gate agent plans on this. */
  features: Record<string, boolean>;
}

let capabilitiesPromise: Promise<VisionCapabilities> | undefined;

/** What this machine can do. Constant for the process lifetime, so memoized. */
export function visionCapabilities(): Promise<VisionCapabilities> {
  capabilitiesPromise ??= run<VisionCapabilities>(['--capabilities']).catch((err) => {
    capabilitiesPromise = undefined;
    throw err;
  });
  return capabilitiesPromise;
}

/** BCP-47 codes supported by the accurate OCR model. */
export function supportedOcrLanguages(): Promise<string[]> {
  return run<string[]>(['--languages']);
}

// ─── Image info ──────────────────────────────────────────────────────────────

export interface ImageInfo {
  width: number;
  height: number;
  hasAlpha: boolean;
  bitsPerComponent: number;
  colorSpace?: string;
  dpi?: number;
  /** EXIF orientation 1–8 when present */
  orientation?: number;
  /** UTI, e.g. 'public.png', 'public.jpeg' */
  format?: string;
}

/** Pixel dimensions and metadata without running any model. */
export function imageInfo(imagePath: string): Promise<ImageInfo> {
  return run<ImageInfo>(['--image-info', resolve(imagePath)]);
}

// ─── Text regions (no recognition) ───────────────────────────────────────────

export type TextRegion = Detection;

/** Where text is, without reading it. Much faster than OCR — use to pick regions of interest. */
export function detectTextRegions(
  imagePath: string,
  options: Pick<TextRecognitionOptions, 'regionOfInterest'> = {}
): Promise<TextRegion[]> {
  return run<TextRegion[]>(['--text-rects', ...textOptionArgs(options), resolve(imagePath)]);
}

// ─── Image similarity ────────────────────────────────────────────────────────

export interface ImageComparison {
  /** Feature-print distance. 0 = identical; < ~0.3 visually the same scene; > ~0.8 different content. */
  distance: number;
}

/** Compare two images semantically (Vision feature prints). Robust to small shifts and compression. */
export function compareImages(imagePathA: string, imagePathB: string): Promise<ImageComparison> {
  return run<ImageComparison>(['--compare', resolve(imagePathA), resolve(imagePathB)]);
}

// ─── Entities in text (NSDataDetector) ───────────────────────────────────────

export interface TextEntity {
  type: 'link' | 'email' | 'phone' | 'address' | 'date' | 'transit' | 'unknown';
  /** Matched substring */
  text: string;
  /** UTF-16 offsets into the input */
  start: number;
  end: number;
  /** Normalised value: absolute URL, e-mail, phone, ISO-8601 date, "street, city, zip" */
  value?: string;
  /** Structured parts (address components, event duration, transit info) */
  components?: Record<string, string>;
}

/** Links, e-mails, phones, addresses and dates in plain text. Pure Foundation — no model. */
export function extractEntities(text: string): Promise<TextEntity[]> {
  return run<TextEntity[]>(['--entities'], text);
}

// ─── Document structure (macOS 26+) ──────────────────────────────────────────

export interface DocLine {
  text: string;
  confidence: number;
  bbox: NormalizedRect;
}
export interface DocText {
  text: string;
  alignment?: 'leading' | 'center' | 'trailing';
  bbox: NormalizedRect;
  lines: DocLine[];
}
export interface DocCell {
  text: string;
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  bbox: NormalizedRect;
}
export interface DocTable {
  rowCount: number;
  columnCount: number;
  /** Cell texts by row; spanning cells repeat in every row they cover */
  rows: string[][];
  /** Unique cells with spans */
  cells: DocCell[];
  bbox: NormalizedRect;
}
export interface DocListItem {
  marker: string;
  text: string;
  bbox: NormalizedRect;
}
export interface DocList {
  items: DocListItem[];
  bbox: NormalizedRect;
}
export interface DocDetectedData {
  type:
    | 'link'
    | 'email'
    | 'phone'
    | 'address'
    | 'date'
    | 'money'
    | 'flight'
    | 'tracking'
    | 'measurement'
    | 'payment'
    | 'unknown';
  text: string;
  value?: string;
  bbox: NormalizedRect;
}
export interface DocBarcode {
  type: string;
  value: string;
  bbox: NormalizedRect;
}

export interface DocumentStructure {
  /** Detected title block, if any */
  title?: DocText;
  /** Full transcript in reading order */
  text: string;
  paragraphs: DocText[];
  tables: DocTable[];
  lists: DocList[];
  barcodes: DocBarcode[];
  /** Data detectors run on the transcript: links, e-mails, phones, money, dates… with positions */
  detectedData: DocDetectedData[];
}

/**
 * Native document understanding (macOS 26+): paragraphs, tables, lists, title,
 * barcodes and detected data with positions — no heuristics, no LLM.
 * Throws `UnsupportedOnThisMacOSError` on older systems; check `visionCapabilities().features.documentStructure`.
 */
export function recognizeDocument(
  imagePath: string,
  options: TextRecognitionOptions = {}
): Promise<DocumentStructure> {
  return gated<DocumentStructure>(
    ['--document-structure', ...textOptionArgs(options), resolve(imagePath)],
    'recognizeDocument',
    '26'
  );
}

// ─── Quality signals ─────────────────────────────────────────────────────────

export interface LensSmudge {
  /** 0–1 likelihood the lens was dirty/smudged */
  confidence: number;
  /** False when the smudge model is unavailable on this hardware — treat confidence as unknown */
  supported: boolean;
}

/** Was the photo taken through a dirty lens? macOS 26+. Returns `supported:false` instead of guessing. */
export async function detectLensSmudge(imagePath: string): Promise<LensSmudge> {
  try {
    return await gated<LensSmudge>(['--smudge', resolve(imagePath)], 'detectLensSmudge', '26');
  } catch (err) {
    if (err instanceof UnsupportedOnThisMacOSError) return { confidence: 0, supported: false };
    throw err;
  }
}

export interface AestheticsScore {
  /** -1…1, higher is nicer */
  overallScore: number;
  /** True for screenshots, receipts, documents — "utility" images rather than photos */
  isUtility: boolean;
}

/** Photo aesthetics + utility flag (macOS 15+). Good for "is this a screenshot or a photo?". */
export async function imageAesthetics(imagePath: string): Promise<AestheticsScore | null> {
  try {
    return await run<AestheticsScore | null>(['--aesthetics', resolve(imagePath)]);
  } catch (err) {
    if ((err as { code?: number }).code === 2)
      throw new UnsupportedOnThisMacOSError('imageAesthetics', '15');
    throw err;
  }
}

export interface Horizon {
  /** Tilt in degrees; positive = clockwise. */
  angleDegrees: number;
}

/** Horizon tilt for photos; null when no horizon is detected. */
export function detectHorizon(imagePath: string): Promise<Horizon | null> {
  return run<Horizon | null>(['--horizon', resolve(imagePath)]);
}

// ─── People, faces, poses, animals ───────────────────────────────────────────

export interface FaceLandmarks extends Detection {
  /** Head rotation in degrees, when available */
  roll?: number;
  yaw?: number;
  pitch?: number;
  /** 0–1 sharpness/exposure quality of the face crop */
  captureQuality?: number;
  /** Region name → polyline of [x, y] normalized points */
  landmarks: Record<string, [number, number][]>;
}

export function detectFaceLandmarks(imagePath: string): Promise<FaceLandmarks[]> {
  return run<FaceLandmarks[]>(['--face-landmarks', resolve(imagePath)]);
}

export type HumanBox = Detection;

/** Full-body person boxes. */
export function detectHumans(imagePath: string): Promise<HumanBox[]> {
  return run<HumanBox[]>(['--humans', resolve(imagePath)]);
}

export interface Keypoint {
  x: number;
  y: number;
  confidence: number;
}

export interface Pose {
  /** Joint name (Vision key, e.g. 'left_wrist_joint') → point. Only joints with confidence > 0. */
  joints: Record<string, Keypoint>;
  confidence: number;
  /** Hands only */
  chirality?: 'left' | 'right' | 'unknown';
}

export function detectBodyPose(imagePath: string): Promise<Pose[]> {
  return run<Pose[]>(['--body-pose', resolve(imagePath)]);
}

export function detectHandPose(imagePath: string): Promise<Pose[]> {
  return run<Pose[]>(['--hand-pose', resolve(imagePath)]);
}

/** macOS 14+. */
export async function detectAnimalPose(imagePath: string): Promise<Pose[]> {
  try {
    return await run<Pose[]>(['--animal-pose', resolve(imagePath)]);
  } catch (err) {
    if ((err as { code?: number }).code === 2)
      throw new UnsupportedOnThisMacOSError('detectAnimalPose', '14');
    throw err;
  }
}

export interface Animal extends Detection {
  /** e.g. [{ identifier: 'Cat', confidence: 0.98 }] */
  labels: Array<{ identifier: string; confidence: number }>;
}

/** Cats and dogs with boxes. */
export function detectAnimals(imagePath: string): Promise<Animal[]> {
  return run<Animal[]>(['--animals', resolve(imagePath)]);
}

// ─── Saliency, contours ──────────────────────────────────────────────────────

export interface SaliencyOptions {
  /** 'attention' = where a human would look; 'objectness' = where objects are. Default 'attention'. */
  mode?: 'attention' | 'objectness';
  /** Write the heatmap PNG here (optional). */
  heatmapPath?: string;
}

export interface Saliency {
  /** Up to 3 salient regions, sorted by the model */
  regions: Detection[];
  heatmapPath?: string;
}

export function detectSaliency(
  imagePath: string,
  options: SaliencyOptions = {}
): Promise<Saliency> {
  const args = ['--saliency', options.mode ?? 'attention'];
  if (options.heatmapPath) args.push('--out', resolve(options.heatmapPath));
  args.push(resolve(imagePath));
  return run<Saliency>(args);
}

export interface ContourOptions {
  /** Include up to N evenly-sampled points per top-level contour. Default 0 (boxes only). */
  maxPoints?: number;
  /** Detect light shapes on a dark background instead of dark-on-light. */
  lightOnDark?: boolean;
  regionOfInterest?: NormalizedRect;
}

export interface Contour extends NormalizedRect {
  index: number;
  pointCount: number;
  childCount: number;
  points?: [number, number][];
}

export interface Contours {
  totalContours: number;
  topLevel: Contour[];
}

/** Edge/shape contours — useful for charts, diagrams, UI boundaries. */
export async function detectContours(
  imagePath: string,
  options: ContourOptions = {}
): Promise<Contours> {
  const args = ['--contours'];
  if (options.maxPoints) args.push('--max-points', String(options.maxPoints));
  if (options.lightOnDark) args.push('--light-on-dark');
  args.push(...textOptionArgs({ regionOfInterest: options.regionOfInterest }), resolve(imagePath));
  const raw = await run<{
    totalContours: number;
    topLevel: Array<Omit<Contour, 'width' | 'height'> & { w: number; h: number }>;
  }>(args);
  return {
    totalContours: raw.totalContours,
    topLevel: raw.topLevel.map((c) => ({
      index: c.index,
      pointCount: c.pointCount,
      childCount: c.childCount,
      x: c.x,
      y: c.y,
      width: c.w,
      height: c.h,
      points: c.points,
    })),
  };
}

// ─── Pixel-producing operations (write PNG, return path) ─────────────────────

export interface CropResult {
  outPath: string;
  width: number;
  height: number;
}

/** Crop a normalized region (top-left origin) to a PNG. Cheap "zoom in" for a second OCR pass. */
export function cropImage(
  imagePath: string,
  region: NormalizedRect,
  out?: string
): Promise<CropResult> {
  return run<CropResult>([
    '--crop',
    `${region.x},${region.y},${region.width},${region.height}`,
    '--out',
    tmpOutPath('crop', out),
    resolve(imagePath),
  ]);
}

/** Detect the document in a photo and write a perspective-corrected, deskewed PNG. */
export function cropDocument(imagePath: string, out?: string): Promise<CropResult> {
  return run<CropResult>([
    '--document-crop',
    '--out',
    tmpOutPath('document', out),
    resolve(imagePath),
  ]);
}

export interface MaskResult {
  /** Number of foreground instances found (0 → nothing written) */
  instances: number;
  outPath: string;
}

export interface ForegroundOptions {
  /** Write only the alpha mask instead of the masked subject. */
  maskOnly?: boolean;
  /** Crop the output to the subject's extent. */
  tight?: boolean;
  out?: string;
}

/** Subject cutout (macOS 14+): transparent-background PNG of the main foreground object(s). */
export async function extractForeground(
  imagePath: string,
  options: ForegroundOptions = {}
): Promise<MaskResult> {
  const args = ['--foreground-mask', '--out', tmpOutPath('foreground', options.out)];
  if (options.maskOnly) args.push('--mask-only');
  if (options.tight) args.push('--tight');
  args.push(resolve(imagePath));
  try {
    return await run<MaskResult>(args);
  } catch (err) {
    if ((err as { code?: number }).code === 2)
      throw new UnsupportedOnThisMacOSError('extractForeground', '14');
    throw err;
  }
}

/** Person segmentation mask as an 8-bit grayscale PNG (white = person). */
export function personMask(imagePath: string, out?: string): Promise<MaskResult> {
  return run<MaskResult>([
    '--person-mask',
    '--out',
    tmpOutPath('person-mask', out),
    resolve(imagePath),
  ]);
}
