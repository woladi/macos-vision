# macos-vision

> Apple Vision for Node.js — native, fast, offline, no API keys required.

Uses macOS's built-in [Vision framework](https://developer.apple.com/documentation/vision) via a compiled Swift binary. Works completely offline. No cloud services, no API keys, no Python, zero runtime dependencies.

## Requirements

- macOS 12+
- Node.js 18+
- Xcode Command Line Tools

```bash
xcode-select --install
```

## Installation

```bash
npm install macos-vision
```

The native Swift binary is compiled automatically on install.

## CLI

```bash
# OCR — plain text (default)
npx macos-vision photo.jpg

# Structured OCR blocks with bounding boxes
npx macos-vision --blocks photo.jpg

# Detect faces
npx macos-vision --faces photo.jpg

# Detect barcodes and QR codes
npx macos-vision --barcodes photo.jpg

# Detect rectangular shapes
npx macos-vision --rectangles photo.jpg

# Find document boundary
npx macos-vision --document photo.jpg

# Classify image content
npx macos-vision --classify photo.jpg

# Run all detections at once
npx macos-vision --all photo.jpg
```

Multiple flags can be combined: `npx macos-vision --blocks --faces --classify photo.jpg`

Structured results are printed as JSON to stdout.

---

## API

```js
import { ocr, detectFaces, detectBarcodes, detectRectangles, detectDocument, classify } from 'macos-vision'

// OCR — plain text
const text = await ocr('photo.jpg')

// OCR — structured blocks with bounding boxes
const blocks = await ocr('photo.jpg', { format: 'blocks' })

// Detect faces
const faces = await detectFaces('photo.jpg')

// Detect barcodes and QR codes
const codes = await detectBarcodes('invoice.jpg')

// Detect rectangular shapes (tables, forms, cards)
const rects = await detectRectangles('document.jpg')

// Find document boundary in a photo
const doc = await detectDocument('photo.jpg') // DocumentBounds | null

// Classify image content
const labels = await classify('photo.jpg')
```

## API

### `ocr(imagePath, options?)`

Extracts text from an image.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `imagePath` | `string` | — | Path to image (PNG, JPG, JPEG, WEBP) |
| `options.format` | `'text' \| 'blocks'` | `'text'` | Plain text or structured blocks with coordinates |

Returns `Promise<string>` or `Promise<VisionBlock[]>`.

```ts
interface VisionBlock {
  text: string
  x: number       // 0–1 from left
  y: number       // 0–1 from top
  width: number   // 0–1
  height: number  // 0–1
}
```

---

### `detectFaces(imagePath)`

Detects human faces and returns their bounding boxes.

```ts
interface Face {
  x: number; y: number; width: number; height: number
  confidence: number  // 0–1
}
```

---

### `detectBarcodes(imagePath)`

Detects barcodes and QR codes and decodes their payload.

```ts
interface Barcode {
  type: string    // e.g. 'org.iso.QRCode', 'org.gs1.EAN-13'
  value: string   // decoded content
  x: number; y: number; width: number; height: number
}
```

---

### `detectRectangles(imagePath)`

Finds rectangular shapes (documents, tables, cards, forms).

```ts
interface Rectangle {
  topLeft: [number, number]; topRight: [number, number]
  bottomLeft: [number, number]; bottomRight: [number, number]
  confidence: number
}
```

---

### `detectDocument(imagePath)`

Finds the boundary of a document in a photo (e.g. paper on a desk). Returns `null` if no document is found.

```ts
interface DocumentBounds {
  topLeft: [number, number]; topRight: [number, number]
  bottomLeft: [number, number]; bottomRight: [number, number]
  confidence: number
}
```

---

### `classify(imagePath)`

Returns top image classification labels with confidence scores.

```ts
interface Classification {
  identifier: string   // e.g. 'document', 'outdoor', 'animal'
  confidence: number   // 0–1
}
```

---

## Why macos-vision?

| | macos-vision | Tesseract.js | Cloud APIs |
|---|---|---|---|
| Offline | ✅ | ✅ | ❌ |
| No API key | ✅ | ✅ | ❌ |
| Native speed | ✅ | ❌ | — |
| Zero runtime deps | ✅ | ❌ | ❌ |
| OCR with bounding boxes | ✅ | ✅ | ✅ |
| Face detection | ✅ | ❌ | ✅ |
| Barcode / QR | ✅ | ❌ | ✅ |
| Document detection | ✅ | ❌ | ✅ |
| Image classification | ✅ | ❌ | ✅ |
| macOS only | ✅ | ❌ | ❌ |

Apple Vision is the same engine used by macOS Spotlight, Live Text, and Shortcuts — highly optimized and accurate.

## License

MIT
