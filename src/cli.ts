import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  ocr, VisionBlock,
  detectFaces, Face,
  detectBarcodes, Barcode,
  detectRectangles, Rectangle,
  detectDocument, DocumentBounds,
  classify, Classification,
} from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const USAGE = `
Usage: vision-cli [options] <image>

Options:
  --ocr           OCR — plain text (default)
  --blocks        OCR — structured blocks with coordinates
  --faces         Face detection
  --barcodes      Barcode & QR code detection
  --rectangles    Rectangle detection
  --document      Document boundary detection
  --classify      Image classification
  --all           Run all of the above

  --help          Show this help

Examples:
  vision-cli photo.jpg
  vision-cli --blocks --faces photo.jpg
  vision-cli --all photo.jpg
`.trim();

const rawArgs = process.argv.slice(2);

if (rawArgs.includes('--help') || rawArgs.length === 0) {
  console.log(USAGE);
  process.exit(0);
}

const flags = new Set(rawArgs.filter(a => a.startsWith('--')));
const fileArgs = rawArgs.filter(a => !a.startsWith('--'));
const imagePath = fileArgs[0] || resolve(__dirname, '../test/fixtures/sample.png');

const runAll     = flags.has('--all');
const runOcr     = runAll || flags.has('--ocr');
const runBlocks  = runAll || flags.has('--blocks');
const runFaces   = runAll || flags.has('--faces');
const runBarcodes = runAll || flags.has('--barcodes');
const runRects   = runAll || flags.has('--rectangles');
const runDoc     = runAll || flags.has('--document');
const runClassify = runAll || flags.has('--classify');

// Default: OCR text when no feature flag is given
const anyFeatureFlag = runAll || flags.has('--ocr') || flags.has('--blocks') ||
  flags.has('--faces') || flags.has('--barcodes') || flags.has('--rectangles') ||
  flags.has('--document') || flags.has('--classify');

const useDefault = !anyFeatureFlag;

async function main() {
  try {
    if (useDefault || runOcr) {
      const text = await ocr(imagePath);
      console.log(text as string);
    }

    if (runBlocks) {
      const blocks = await ocr(imagePath, { format: 'blocks' }) as VisionBlock[];
      console.log(JSON.stringify(blocks, null, 2));
    }

    if (runFaces) {
      const faces = await detectFaces(imagePath) as Face[];
      console.log(JSON.stringify(faces, null, 2));
    }

    if (runBarcodes) {
      const barcodes = await detectBarcodes(imagePath) as Barcode[];
      console.log(JSON.stringify(barcodes, null, 2));
    }

    if (runRects) {
      const rectangles = await detectRectangles(imagePath) as Rectangle[];
      console.log(JSON.stringify(rectangles, null, 2));
    }

    if (runDoc) {
      const doc = await detectDocument(imagePath) as DocumentBounds | null;
      console.log(JSON.stringify(doc, null, 2));
    }

    if (runClassify) {
      const labels = await classify(imagePath) as Classification[];
      console.log(JSON.stringify(labels, null, 2));
    }
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();
