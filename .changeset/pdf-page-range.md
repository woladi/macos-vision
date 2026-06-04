---
"macos-vision": minor
---

Add `startPage` and `maxPages` options to `rasterizePdf()` and `ocr()`, plus
matching `--start-page` and `--max-pages` CLI flags. Lets callers process a
page range instead of the whole PDF — useful for long documents where only
the first few pages are needed (previews, classification, head-of-document
extraction).

User-facing input is 1-based; `PdfPage.page` / `VisionBlock.page` in the
response remain 0-based to preserve backward compatibility.
