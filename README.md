# macos-vision

> Apple Vision OCR for Node.js — native, fast, offline, no API keys required.

Uses macOS's built-in [Vision framework](https://developer.apple.com/documentation/vision) via a compiled Swift binary. Works completely offline. No cloud services, no API keys, no Python.

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

The native binary is compiled automatically on install.

## Usage

```js
import { ocr } from 'macos-vision'

// Plain text
const text = await ocr('/path/to/image.png')
console.log(text)

// Structured blocks with bounding box coordinates
const blocks = await ocr('/path/to/image.png', { format: 'blocks' })
console.log(blocks)
// [
//   { text: 'Hello', x: 0.05, y: 0.10, width: 0.2, height: 0.04 },
//   { text: 'World', x: 0.05, y: 0.15, width: 0.2, height: 0.04 },
//   ...
// ]
```

## API

### `ocr(imagePath, options?)`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `imagePath` | `string` | — | Absolute or relative path to image (PNG, JPG, JPEG, WEBP) |
| `options.format` | `'text' \| 'blocks'` | `'text'` | Return plain text or structured blocks |

**Returns:**
- `format: 'text'` → `Promise<string>`
- `format: 'blocks'` → `Promise<VisionBlock[]>`

### `VisionBlock`

```ts
interface VisionBlock {
  text: string    // Recognized text
  x: number       // Left position (0–1)
  y: number       // Top position (0–1), 0 = top of image
  width: number   // Width (0–1)
  height: number  // Height (0–1)
}
```

## Why macos-vision?

| | macos-vision | Tesseract.js | Cloud APIs |
|---|---|---|---|
| Offline | ✅ | ✅ | ❌ |
| No API key | ✅ | ✅ | ❌ |
| Native speed | ✅ | ❌ | — |
| Bounding boxes | ✅ | ✅ | ✅ |
| Zero runtime deps | ✅ | ❌ | ❌ |
| Polish language | ✅ | ✅ | ✅ |
| macOS only | ✅ | ❌ | ❌ |

Apple Vision is the same engine used by macOS Spotlight, Live Text, and Shortcuts — it's highly optimized and accurate.

## Supported languages

Recognition is optimized for **Polish** (`pl-PL`) and **English** (`en-US`) by default, which are natively supported by Apple Vision with high accuracy.

## License

MIT
