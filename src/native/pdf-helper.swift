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

let args = CommandLine.arguments
guard args.count >= 2 else {
    fail("Usage: pdf-helper <path-to-pdf>")
}

let pdfPath = args[1]
let pdfURL = URL(fileURLWithPath: pdfPath)

guard let pdf = PDFDocument(url: pdfURL) else {
    fail("Cannot open PDF: \(pdfPath)")
}

let pageCount = pdf.pageCount
guard pageCount > 0 else {
    fail("PDF has no pages: \(pdfPath)")
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

for pageIndex in 0..<pageCount {
    guard let page = pdf.page(at: pageIndex) else {
        fail("Cannot access page \(pageIndex) of \(pdfPath)")
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
