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
} from './index.js';

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

const flags = new Set(argv.filter((a) => a.startsWith('--')));
const fileArgs = argv.filter((a) => !a.startsWith('-'));

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
      outPath ??
      join(
        dirname(inputPath),
        basename(inputPath, extname(inputPath)) + '.md',
      );

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

  // Default: OCR text when no feature flag is given
  const anyFeatureFlag =
    runAll ||
    flags.has('--ocr') ||
    flags.has('--blocks') ||
    flags.has('--faces') ||
    flags.has('--barcodes') ||
    flags.has('--rectangles') ||
    flags.has('--document') ||
    flags.has('--classify');

  const useDefault = !anyFeatureFlag;

  (async () => {
    try {
      if (useDefault || runOcr) {
        const text = await ocr(inputPath);
        console.log(text as string);
      }

      if (runBlocks) {
        const blocks = (await ocr(inputPath, { format: 'blocks' })) as VisionBlock[];
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
    } catch (error) {
      console.error('Error:', error);
      process.exit(1);
    }
  })();
}
