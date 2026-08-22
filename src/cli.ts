#!/usr/bin/env node

import { resolve, dirname, basename, extname, join } from 'path';
import { writeFile } from 'fs/promises';
import {
  ocr,
  VisionBlock,
  detectFaces,
  Face,
  detectBarcodes,
  Barcode,
  detectRectangles,
  Rectangle,
  detectDocument,
  DocumentBounds,
  classify,
  Classification,
  recognizeDocument,
  extractEntities,
  detectTextRegions,
  detectHumans,
  detectFaceLandmarks,
  detectSaliency,
  imageAesthetics,
  imageInfo,
  visionCapabilities,
} from './index.js';
import type { TextRecognitionOptions } from './index.js';

const USAGE = `
Usage: macos-vision [options] <image-or-pdf>

Vision options:
  --ocr                  OCR — plain text (default)
  --blocks               OCR — structured blocks with coordinates
  --faces                Face detection
  --barcodes             Barcode & QR code detection
  --rectangles           Rectangle detection
  --document             Document boundary detection
  --classify             Image classification
  --all                  Run all of the above

OCR tuning:
  --lang <codes>         Recognition languages, comma-separated BCP-47 (e.g. pl-PL,en-US)
  --auto-lang            Let Vision detect the language automatically
  --no-correction        Disable language-model correction (IDs, codes, IBANs)
  --custom-words <w,w>   Domain vocabulary that should win over the language model
  --fast                 Fast recognition level (quicker, less accurate)
  --roi x,y,w,h          Only read inside this normalized region (top-left origin)
  --cache                Cache OCR results by file hash in ~/.cache/macos-vision/ocr

Extended analysis:
  --structure            Document structure: paragraphs, tables, lists, data (macOS 26+)
  --entities             Links / e-mails / phones / addresses / dates found in OCR text
  --text-regions         Where text is, without reading it
  --humans               Person bounding boxes
  --face-landmarks       Face landmarks, head pose, capture quality
  --saliency             Attention-based salient regions
  --aesthetics           Aesthetics score + utility flag (macOS 15+)
  --info                 Pixel dimensions and image metadata
  --capabilities         What this machine supports (no input file needed)
  --languages            Supported OCR languages (no input file needed)

PDF page range (PDFs only; ignored for images):
  --start-page <N>       First page to process, 1-based (default: 1)
  --max-pages <M>        Maximum number of pages to process (default: all)

Markdown options (requires Ollama running locally):
  --markdown             Convert image/PDF to Markdown via VisionScribe + Ollama
  --model <name>         Ollama model name (default: mistral-nemo)
  --ollama-url <url>     Ollama base URL (default: http://localhost:11434)
  -o, --output <path>    Write Markdown to specified file
  --stdout               Print Markdown to stdout instead of a file

  --help                 Show this help

Examples:
  macos-vision photo.jpg
  macos-vision --blocks --faces photo.jpg
  macos-vision --all photo.jpg
  macos-vision --start-page 1 --max-pages 2 report.pdf
  macos-vision --markdown invoice.pdf -o notes.md
  macos-vision --markdown receipt.jpg --stdout
`.trim();

const rawArgs = process.argv.slice(2);

if (rawArgs.includes('--help') || rawArgs.length === 0) {
  console.log(USAGE);
  process.exit(0);
}

// Strip value-bearing options first so the remaining tokens are either
// boolean flags (`--something`) or positional file paths.
function takeOpt(name: string, args: string[]): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

const argv = [...rawArgs];
const model = takeOpt('--model', argv);
const ollamaUrl = takeOpt('--ollama-url', argv);
const outPath = takeOpt('-o', argv) ?? takeOpt('--output', argv);
const startPageRaw = takeOpt('--start-page', argv);
const maxPagesRaw = takeOpt('--max-pages', argv);
const langRaw = takeOpt('--lang', argv);
const customWordsRaw = takeOpt('--custom-words', argv);
const roiRaw = takeOpt('--roi', argv);

function parsePageOpt(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`Error: ${name} must be an integer >= 1 (got "${raw}")`);
    process.exit(1);
  }
  return n;
}

const startPage = parsePageOpt('--start-page', startPageRaw);
const maxPages = parsePageOpt('--max-pages', maxPagesRaw);
const pageRange: { startPage?: number; maxPages?: number } = {};
if (startPage !== undefined) pageRange.startPage = startPage;
if (maxPages !== undefined) pageRange.maxPages = maxPages;

const flags = new Set(argv.filter((a) => a.startsWith('--')));
const fileArgs = argv.filter((a) => !a.startsWith('-'));

const textOptions: TextRecognitionOptions = {};
if (langRaw) textOptions.languages = langRaw.split(',');
if (customWordsRaw) textOptions.customWords = customWordsRaw.split(',');
if (flags.has('--auto-lang')) textOptions.autoDetectLanguage = true;
if (flags.has('--no-correction')) textOptions.languageCorrection = false;
if (flags.has('--fast')) textOptions.fast = true;
if (roiRaw) {
  const [x, y, width, height] = roiRaw.split(',').map(Number);
  if ([x, y, width, height].some((n) => !Number.isFinite(n))) {
    console.error(`Error: --roi expects x,y,w,h (got "${roiRaw}")`);
    process.exit(1);
  }
  textOptions.regionOfInterest = { x, y, width, height };
}
const ocrBase = { ...pageRange, ...textOptions, cache: flags.has('--cache') };

// Commands that need no input file.
if (flags.has('--capabilities') || flags.has('--languages')) {
  const caps = await visionCapabilities();
  if (flags.has('--capabilities')) console.log(JSON.stringify(caps, null, 2));
  if (flags.has('--languages')) console.log(JSON.stringify(caps.ocrLanguages, null, 2));
  process.exit(0);
}

if (!fileArgs[0]) {
  console.error('Error: no image or PDF path provided.\n');
  console.log(USAGE);
  process.exit(1);
}

const inputPath = resolve(fileArgs[0]);

// ─── Markdown pipeline ─────────────────────────────────────────────────────────────
if (flags.has('--markdown')) {
  const toStdout = flags.has('--stdout');
  const opts: { model?: string; ollamaUrl?: string } = {};
  if (model) opts.model = model;
  if (ollamaUrl) opts.ollamaUrl = ollamaUrl;

  (async () => {
    const { VisionScribe, OllamaUnavailableError } = await import('./markdown/index.js');
    const scribe = new VisionScribe(opts);

    if (!toStdout) process.stderr.write(`Converting ${fileArgs[0]}…\n`);

    let markdown: string;
    try {
      markdown = await scribe.toMarkdown(inputPath);
    } catch (err) {
      if (err instanceof OllamaUnavailableError) {
        console.error(err.message);
        process.exit(2);
      }
      throw err;
    }

    if (toStdout) {
      process.stdout.write(markdown);
      return;
    }

    const finalPath =
      outPath ?? join(dirname(inputPath), basename(inputPath, extname(inputPath)) + '.md');

    await writeFile(finalPath, markdown, 'utf8');
    process.stderr.write(`Saved: ${finalPath}\n`);
  })().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else {
  // ─── Vision pipeline (OCR / detections / classification) ───────────────────────
  const runAll = flags.has('--all');
  const runOcr = runAll || flags.has('--ocr');
  const runBlocks = runAll || flags.has('--blocks');
  const runFaces = runAll || flags.has('--faces');
  const runBarcodes = runAll || flags.has('--barcodes');
  const runRects = runAll || flags.has('--rectangles');
  const runDoc = runAll || flags.has('--document');
  const runClassify = runAll || flags.has('--classify');
  // One OCR pass shared by --ocr and --entities.
  let textPromise: Promise<string> | undefined;
  const getText = () => (textPromise ??= ocr(inputPath, ocrBase) as Promise<string>);

  const extended: Array<[string, () => Promise<unknown>]> = [
    ['--structure', () => recognizeDocument(inputPath, textOptions)],
    ['--entities', async () => extractEntities(await getText())],
    ['--text-regions', () => detectTextRegions(inputPath, textOptions)],
    ['--humans', () => detectHumans(inputPath)],
    ['--face-landmarks', () => detectFaceLandmarks(inputPath)],
    ['--saliency', () => detectSaliency(inputPath)],
    ['--aesthetics', () => imageAesthetics(inputPath)],
    ['--info', () => imageInfo(inputPath)],
  ];
  const runExtended = extended.filter(([flag]) => flags.has(flag));

  // Default: OCR text when no feature flag is given
  const CLASSIC_FLAGS = [
    '--ocr',
    '--blocks',
    '--faces',
    '--barcodes',
    '--rectangles',
    '--document',
    '--classify',
  ];
  const anyFeatureFlag =
    runAll || CLASSIC_FLAGS.some((f) => flags.has(f)) || runExtended.length > 0;

  const useDefault = !anyFeatureFlag;

  (async () => {
    try {
      if (useDefault || runOcr) {
        console.log(await getText());
      }

      if (runBlocks) {
        const blocks = (await ocr(inputPath, {
          ...ocrBase,
          format: 'blocks',
        })) as VisionBlock[];
        console.log(JSON.stringify(blocks, null, 2));
      }

      if (runFaces) {
        const faces = (await detectFaces(inputPath)) as Face[];
        console.log(JSON.stringify(faces, null, 2));
      }

      if (runBarcodes) {
        const barcodes = (await detectBarcodes(inputPath)) as Barcode[];
        console.log(JSON.stringify(barcodes, null, 2));
      }

      if (runRects) {
        const rectangles = (await detectRectangles(inputPath)) as Rectangle[];
        console.log(JSON.stringify(rectangles, null, 2));
      }

      if (runDoc) {
        const doc = (await detectDocument(inputPath)) as DocumentBounds | null;
        console.log(JSON.stringify(doc, null, 2));
      }

      if (runClassify) {
        const labels = (await classify(inputPath)) as Classification[];
        console.log(JSON.stringify(labels, null, 2));
      }

      for (const [, fn] of runExtended) {
        console.log(JSON.stringify(await fn(), null, 2));
      }
    } catch (error) {
      console.error('Error:', error);
      process.exit(1);
    }
  })();
}
