# macos-vision

> Apple Vision for Node.js — native, fast, offline. Now with an optional Ollama-driven Markdown pipeline.

Uses macOS's built-in [Vision framework](https://developer.apple.com/documentation/vision) via a compiled Swift binary. Works completely offline. No cloud services, no API keys, no Python, zero runtime dependencies.

## Requirements

- macOS 12+
- Node.js 18+
- Xcode Command Line Tools (`xcode-select --install`)
- [Ollama](https://ollama.com) running locally — only if you use the Markdown pipeline

## Installation

```bash
npm install macos-vision
```

The native Swift binaries (`vision-helper`, `pdf-helper`) are compiled automatically on install.

## What you get

| Capability | Engine | Network |
|---|---|---|
| OCR (text + bounding boxes) | Apple Vision | offline |
| Face / barcode / rectangle / document detection | Apple Vision | offline |
| Image classification | Apple Vision | offline |
| Layout inference (lines, paragraphs, reading order) | heuristic in TypeScript | offline |
| PDF rasterization | PDFKit (`pdf-helper`) | offline |
| **Image / PDF → Markdown** | Apple Vision OCR + local LLM via Ollama | local LLM call |

---

## CLI

```bash
# OCR — plain text (default)
npx macos-vision photo.jpg

# Structured OCR blocks with bounding boxes
npx macos-vision --blocks photo.jpg

# Detections
npx macos-vision --faces photo.jpg
npx macos-vision --barcodes photo.jpg
npx macos-vision --rectangles photo.jpg
npx macos-vision --document photo.jpg
npx macos-vision --classify photo.jpg

# Run all detections at once
npx macos-vision --all photo.jpg

# Image / PDF → Markdown via VisionScribe + Ollama
npx macos-vision --markdown invoice.pdf -o notes.md
npx macos-vision --markdown receipt.jpg --stdout
npx macos-vision --markdown scan.png --model llama3.2
```

Multiple Vision flags can be combined: `npx macos-vision --blocks --faces --classify photo.jpg`. Structured results are printed as JSON to stdout.

### CLI flags

| Flag | Description |
|---|---|
| `--ocr` | Plain text OCR (default when no flag is given) |
| `--blocks` | OCR with bounding boxes (JSON) |
| `--faces` / `--barcodes` / `--rectangles` / `--document` / `--classify` | Vision detections (JSON) |
| `--all` | Run every Vision detection at once |
| `--markdown` | Convert image / PDF to Markdown via VisionScribe + Ollama |
| `--model <name>` | Ollama model (default: `mistral-nemo`). Only used with `--markdown` |
| `--ollama-url <url>` | Ollama base URL (default: `http://localhost:11434`). Only used with `--markdown` |
| `-o`, `--output <path>` | Write Markdown to a file. Only used with `--markdown` |
| `--stdout` | Print Markdown to stdout instead of a file. Only used with `--markdown` |
| `--help` | Show usage |

---

## API — Vision

```js
import {
  ocr,
  detectFaces,
  detectBarcodes,
  detectRectangles,
  detectDocument,
  classify,
  inferLayout,
} from 'macos-vision';

// OCR — plain text
const text = await ocr('photo.jpg');

// OCR — structured blocks with bounding boxes
const blocks = await ocr('photo.jpg', { format: 'blocks' });

// Detect faces / barcodes / rectangles / document boundary
const faces = await detectFaces('photo.jpg');
const codes = await detectBarcodes('invoice.jpg');
const rects = await detectRectangles('document.jpg');
const doc = await detectDocument('photo.jpg'); // DocumentBounds | null

// Classify image content
const labels = await classify('photo.jpg');

// Layout inference — unified reading-order-sorted representation
const layout = inferLayout({ textBlocks: blocks, faces, barcodes: codes });
```

### Layout inference

`inferLayout` merges raw Vision results into a unified `LayoutBlock[]` sorted in reading order (top-to-bottom, left-to-right). Text blocks are grouped into **lines** and **paragraphs** using geometric heuristics.

```ts
import { ocr, detectFaces, detectBarcodes, inferLayout } from 'macos-vision';

const blocks   = await ocr('page.png', { format: 'blocks' });
const faces    = await detectFaces('page.png');
const barcodes = await detectBarcodes('page.png');

const layout = inferLayout({ textBlocks: blocks, faces, barcodes });

for (const block of layout) {
  if (block.kind === 'text') {
    console.log(`[p${block.paragraphId} l${block.lineId}] ${block.text}`);
  } else {
    console.log(`[${block.kind}] at (${block.x.toFixed(2)}, ${block.y.toFixed(2)})`);
  }
}
```

`LayoutBlock` is a discriminated union — use `block.kind` to narrow the type:

| `kind` | Extra fields |
|--------|-------------|
| `'text'` | `text`, `lineId`, `paragraphId` |
| `'barcode'` | `value`, `type` |
| `'face'` | — |
| `'rectangle'` | — |
| `'document'` | — |

> **Note:** Layout inference is a heuristic layer. It does not understand multi-column layouts or rotated text. Treat it as structured input for downstream tools, not as ground truth.

---

## API — Markdown pipeline (VisionScribe)

`VisionScribe` converts an image or PDF to Markdown by combining Apple Vision OCR with a local LLM (via Ollama). The LLM never sees the image — it only formats text that Vision already extracted, which keeps the pipeline deterministic and prevents the hallucinations typical of cloud vision APIs.

### Prerequisites

```bash
brew install ollama
ollama serve            # keep this running
ollama pull mistral-nemo
```

### Quick start

```ts
import { VisionScribe } from 'macos-vision';

const scribe = new VisionScribe();
const markdown = await scribe.toMarkdown('receipt.png');
console.log(markdown);
```

For a narrower import surface that pulls in only the markdown sub-module:

```ts
import { VisionScribe } from 'macos-vision/markdown';
```

### How it works

```
Image / PDF
  │
  ▼
Apple Vision OCR          ← macOS native, deterministic, zero hallucination
  │  VisionBlock[] per page
  ▼
Per-page layout inference ← each page processed independently (page-local coords)
  │  paragraphId, lineId, y
  ▼
Chunker                   ← batches paragraphs to fit the LLM output window
  │  ParagraphGroup[][]
  ▼
Ollama /api/chat          ← system prompt as role:"system", OCR text as role:"user"
  │  temperature=0, top_p=1, num_predict=-1
  ▼
Markdown string           ← chunk results joined with blank lines
```

The LLM never sees the raw image; it only formats text that Apple Vision has already extracted. The system prompt instructs the model to act as a high-fidelity document parser and explicitly forbids summarising, paraphrasing, or adding content. OCR text is wrapped in `<ocr_source>` tags so the model cannot mistake it for a user asking a question. Per-page processing keeps paragraph coordinates from different pages from being mixed.

### `new VisionScribe(options?)`

| Option | Type | Default | Description |
|---|---|---|---|
| `model` | `string` | `'mistral-nemo'` | Ollama model name |
| `ollamaUrl` | `string` | `'http://localhost:11434'` | Base URL of the Ollama server |
| `skipPing` | `boolean` | `false` | Skip per-call Ollama health check (useful in batch loops) |
| `chunkSizeTokens` | `number` | `1800` | Max estimated output tokens per LLM chunk. Lower = more chunks (safer for small models); higher = fewer calls but risks hitting model output limits |

### `scribe.toMarkdown(imagePath)`

- Accepts PNG, JPEG, HEIC, HEIF, TIFF, GIF, BMP, WebP and **PDF**
- Returns an empty string `''` if no text is detected
- Throws `OllamaUnavailableError` if the Ollama server is not reachable (unless `skipPing: true`)

### Batch processing

```ts
import { VisionScribe, OllamaUnavailableError } from 'macos-vision';

const scribe = new VisionScribe({ skipPing: true });

for (const file of files) {
  try {
    const md = await scribe.toMarkdown(file);
    // …
  } catch (e) {
    if (e instanceof OllamaUnavailableError) {
      console.error(e.message);
      break;
    }
    throw e;
  }
}
```

### Known limitations

- **Local model fidelity**: small models (`mistral-nemo`, `gemma`) may occasionally summarise or paraphrase long, dense documents. Larger models (`llama3.1:70b`, `qwen2.5:32b`) produce significantly better fidelity.
- **Tables**: multi-column table layouts are partially supported. OCR reads cells in reading order but the LLM may not always reconstruct correct Markdown table syntax.
- **Images / charts**: non-textual content (photos, diagrams, charts) is ignored — only text blocks extracted by Apple Vision are processed.

---

## Migrating from `macos-vision-md`

The standalone [`macos-vision-md`](https://github.com/woladi/macos-vision-md) package has been merged into `macos-vision` as of v2.0.0. The old package will keep working as a thin re-export shim, but new projects should depend on `macos-vision` directly.

```diff
- import { VisionScribe } from 'macos-vision-md';
+ import { VisionScribe } from 'macos-vision';
```

```diff
- macos-vision-md invoice.pdf -o notes.md
+ macos-vision --markdown invoice.pdf -o notes.md
```

The `VisionScribe` API, the system prompt, and the chunking strategy are unchanged. `OllamaUnavailableError`, `VisionScribeOptions`, and `ParagraphGroup` are now exported from `macos-vision`.

---

## API reference — types

### `ocr(imagePath, options?)`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `imagePath` | `string` | — | Path to image (PNG, JPG, JPEG, WEBP) or PDF |
| `options.format` | `'text' \| 'blocks'` | `'text'` | Plain text or structured blocks with coordinates |

Returns `Promise<string>` or `Promise<VisionBlock[]>`.

```ts
interface VisionBlock {
  text: string
  x: number       // 0–1 from left
  y: number       // 0–1 from top
  width: number   // 0–1
  height: number  // 0–1
  confidence: number
  page?: number   // 0-based, only for PDFs
}
```

### `detectFaces(imagePath)` / `detectBarcodes(imagePath)` / `detectRectangles(imagePath)` / `detectDocument(imagePath)` / `classify(imagePath)`

See `src/index.ts` for full type declarations.

---

## Why macos-vision?

| | macos-vision | Tesseract.js | Cloud APIs |
|---|---|---|---|
| Offline OCR | ✅ | ✅ | ❌ |
| Offline image → Markdown | ✅ (with local Ollama) | ❌ | ❌ |
| No API key | ✅ | ✅ | ❌ |
| Native speed | ✅ | ❌ | — |
| Zero runtime deps | ✅ | ❌ | ❌ |
| OCR with bounding boxes | ✅ | ✅ | ✅ |
| Face / barcode / document detection | ✅ | ❌ | ✅ |
| Image classification | ✅ | ❌ | ✅ |
| macOS only | ✅ | ❌ | ❌ |

Apple Vision is the same engine used by macOS Spotlight, Live Text, and Shortcuts — highly optimized and accurate.

## License

MIT
