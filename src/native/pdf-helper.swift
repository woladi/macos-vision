import PDFKit
import AppKit
import Foundation

// ─── Result struct ────────────────────────────────────────────────────────────

struct PageResult: Codable {
    let page: Int    // 0-based
    let path: String
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

func fail(_ message: String) -> Never {
    fputs("ERROR: \(message)\n", stderr)
    exit(1)
}

func encodeJSON<T: Encodable>(_ value: T) -> String {
    guard let data = try? JSONEncoder().encode(value),
          let str = String(data: data, encoding: .utf8) else { return "[]" }
    return str
}

// ─── Argument parsing ─────────────────────────────────────────────────────────

// Flags may appear in any order relative to the positional <path>.
//   pdf-helper [--start-page N] [--max-pages M] <path-to-pdf>
// `startPage` is 1-based for user-facing CLI; `PageResult.page` stays 0-based.

var pdfPath: String?
var startPage: Int = 1
var maxPages: Int = Int.max

let argv = CommandLine.arguments
var i = 1
while i < argv.count {
    let arg = argv[i]
    switch arg {
    case "--start-page":
        guard i + 1 < argv.count, let v = Int(argv[i + 1]) else {
            fail("--start-page requires a positive integer")
        }
        guard v >= 1 else { fail("--start-page must be >= 1") }
        startPage = v
        i += 2
    case "--max-pages":
        guard i + 1 < argv.count, let v = Int(argv[i + 1]) else {
            fail("--max-pages requires a positive integer")
        }
        guard v >= 1 else { fail("--max-pages must be >= 1") }
        maxPages = v
        i += 2
    default:
        if pdfPath == nil {
            pdfPath = arg
        } else {
            fail("Unexpected argument: \(arg)")
        }
        i += 1
    }
}

guard let resolvedPath = pdfPath else {
    fail("Usage: pdf-helper [--start-page N] [--max-pages M] <path-to-pdf>")
}

let pdfURL = URL(fileURLWithPath: resolvedPath)

guard let pdf = PDFDocument(url: pdfURL) else {
    fail("Cannot open PDF: \(resolvedPath)")
}

let pageCount = pdf.pageCount
guard pageCount > 0 else {
    fail("PDF has no pages: \(resolvedPath)")
}

// Convert 1-based startPage to 0-based; clamp endIdx to pageCount.
let startIdx = startPage - 1
let endIdx = min(startIdx + maxPages, pageCount)

// startPage past the end → empty array, not an error.
if startIdx >= pageCount {
    print(encodeJSON([PageResult]()))
    exit(0)
}

// ─── Output directory: ~/.cache/macos-vision/{basename}-{uuid}/ ───────────────

let basename = pdfURL.deletingPathExtension().lastPathComponent
let uuid = UUID().uuidString.lowercased()
let cacheBase = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent(".cache/macos-vision")
let outDir = cacheBase.appendingPathComponent("\(basename)-\(uuid)")

do {
    try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
} catch {
    fail("Cannot create output directory \(outDir.path): \(error.localizedDescription)")
}

// ─── Rasterize each page at 300 DPI ──────────────────────────────────────────

// PDF points are 72 pt/inch. Scale factor for 300 DPI = 300/72 ≈ 4.167
let scale: CGFloat = 300.0 / 72.0

var results: [PageResult] = []

for pageIndex in startIdx..<endIdx {
    guard let page = pdf.page(at: pageIndex) else {
        fail("Cannot access page \(pageIndex) of \(resolvedPath)")
    }

    let mediaBox = page.bounds(for: .mediaBox)
    let width  = Int((mediaBox.width  * scale).rounded())
    let height = Int((mediaBox.height * scale).rounded())

    guard let bitmapRep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: width,
        pixelsHigh: height,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .calibratedRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ) else {
        fail("Cannot create bitmap for page \(pageIndex)")
    }

    guard let ctx = NSGraphicsContext(bitmapImageRep: bitmapRep) else {
        fail("Cannot create graphics context for page \(pageIndex)")
    }

    // Fill white background (PDFs are transparent by default)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = ctx
    NSColor.white.setFill()
    NSRect(x: 0, y: 0, width: width, height: height).fill()

    ctx.cgContext.scaleBy(x: scale, y: scale)
    page.draw(with: .mediaBox, to: ctx.cgContext)
    NSGraphicsContext.restoreGraphicsState()

    guard let pngData = bitmapRep.representation(using: .png, properties: [:]) else {
        fail("Cannot encode page \(pageIndex) to PNG")
    }

    // Zero-pad page number to 3 digits: page-001.png, page-002.png, …
    let filename = String(format: "%@-page-%03d.png", basename, pageIndex + 1)
    let outPath = outDir.appendingPathComponent(filename)

    do {
        try pngData.write(to: outPath)
    } catch {
        fail("Cannot write \(outPath.path): \(error.localizedDescription)")
    }

    results.append(PageResult(page: pageIndex, path: outPath.path))
}

// ─── Output JSON ──────────────────────────────────────────────────────────────

print(encodeJSON(results))
