import Vision
import AppKit
import Foundation

// ─── Result structs ──────────────────────────────────────────────────────────

struct OCRResult: Codable {
    let t: String
    let x: Double; let y: Double; let w: Double; let h: Double
    let confidence: Float
}

struct FaceResult: Codable {
    let x: Double; let y: Double; let w: Double; let h: Double
    let confidence: Float
}

struct BarcodeResult: Codable {
    let type: String
    let value: String
    let x: Double; let y: Double; let w: Double; let h: Double
    let confidence: Float
}

struct RectangleResult: Codable {
    let topLeft: [Double]; let topRight: [Double]
    let bottomLeft: [Double]; let bottomRight: [Double]
    let confidence: Float
}

struct DocumentResult: Codable {
    let topLeft: [Double]; let topRight: [Double]
    let bottomLeft: [Double]; let bottomRight: [Double]
    let confidence: Float
}

struct ClassificationResult: Codable {
    let identifier: String
    let confidence: Float
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Vision: 0,0 = bottom-left. We flip Y so 0,0 = top-left (web standard).
func flipY(_ y: Double, _ h: Double) -> Double { 1.0 - y - h }

func pt(_ p: CGPoint) -> [Double] { [Double(p.x), 1.0 - Double(p.y)] }

func encodeJSON<T: Encodable>(_ value: T) -> String {
    guard let data = try? JSONEncoder().encode(value),
          let str = String(data: data, encoding: .utf8) else { return "[]" }
    return str
}

// ─── Argument parsing ─────────────────────────────────────────────────────────

let args = CommandLine.arguments
let isJsonMode   = args.contains("--json")
let isFaces      = args.contains("--faces")
let isBarcodes   = args.contains("--barcodes")
let isRectangles = args.contains("--rectangles")
let isDocument   = args.contains("--document")
let isClassify   = args.contains("--classify")

let fileArgs = args.filter { !$0.hasPrefix("--") && !$0.contains("vision-helper") }

guard let imagePath = fileArgs.first else {
    print("Usage: vision-helper [--json|--faces|--barcodes|--rectangles|--document|--classify] <path>")
    exit(0)
}

guard let image = NSImage(contentsOf: URL(fileURLWithPath: imagePath)),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    fputs("ERROR: Cannot open file: \(imagePath)\n", stderr)
    exit(1)
}

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])

// ─── OCR (default + --json) ───────────────────────────────────────────────────

if isJsonMode || (!isFaces && !isBarcodes && !isRectangles && !isDocument && !isClassify) {
    var ocrResults: [OCRResult] = []
    var rawText = ""

    let request = VNRecognizeTextRequest { (req, _) in
        guard let obs = req.results as? [VNRecognizedTextObservation] else { return }
        for o in obs {
            guard let c = o.topCandidates(1).first else { continue }
            let box = o.boundingBox
            if isJsonMode {
                ocrResults.append(OCRResult(
                    t: c.string,
                    x: Double(box.origin.x),
                    y: flipY(Double(box.origin.y), Double(box.size.height)),
                    w: Double(box.size.width),
                    h: Double(box.size.height),
                    confidence: c.confidence
                ))
            } else {
                rawText += c.string + "\n"
            }
        }
    }
    request.recognitionLevel = .accurate

    do {
        try handler.perform([request])
    } catch {
        fputs("ERROR: Vision OCR failed: \(error.localizedDescription)\n", stderr)
        exit(1)
    }
    print(isJsonMode ? encodeJSON(ocrResults) : rawText.trimmingCharacters(in: .whitespacesAndNewlines))
    exit(0)
}

// ─── Faces ───────────────────────────────────────────────────────────────────

if isFaces {
    var results: [FaceResult] = []
    let request = VNDetectFaceRectanglesRequest { (req, _) in
        guard let obs = req.results as? [VNFaceObservation] else { return }
        for o in obs {
            let box = o.boundingBox
            results.append(FaceResult(
                x: Double(box.origin.x),
                y: flipY(Double(box.origin.y), Double(box.size.height)),
                w: Double(box.size.width),
                h: Double(box.size.height),
                confidence: o.confidence
            ))
        }
    }
    do {
        try handler.perform([request])
    } catch {
        fputs("ERROR: Vision face detection failed: \(error.localizedDescription)\n", stderr)
        exit(1)
    }
    print(encodeJSON(results))
    exit(0)
}

// ─── Barcodes ────────────────────────────────────────────────────────────────

if isBarcodes {
    var results: [BarcodeResult] = []
    let request = VNDetectBarcodesRequest { (req, _) in
        guard let obs = req.results as? [VNBarcodeObservation] else { return }
        for o in obs {
            let box = o.boundingBox
            results.append(BarcodeResult(
                type: o.symbology.rawValue,
                value: o.payloadStringValue ?? "",
                x: Double(box.origin.x),
                y: flipY(Double(box.origin.y), Double(box.size.height)),
                w: Double(box.size.width),
                h: Double(box.size.height),
                confidence: o.confidence
            ))
        }
    }
    do {
        try handler.perform([request])
    } catch {
        fputs("ERROR: Vision barcode detection failed: \(error.localizedDescription)\n", stderr)
        exit(1)
    }
    print(encodeJSON(results))
    exit(0)
}

// ─── Rectangles ──────────────────────────────────────────────────────────────

if isRectangles {
    var results: [RectangleResult] = []
    let request = VNDetectRectanglesRequest { (req, _) in
        guard let obs = req.results as? [VNRectangleObservation] else { return }
        for o in obs {
            results.append(RectangleResult(
                topLeft: pt(o.topLeft), topRight: pt(o.topRight),
                bottomLeft: pt(o.bottomLeft), bottomRight: pt(o.bottomRight),
                confidence: o.confidence
            ))
        }
    }
    (request as VNDetectRectanglesRequest).maximumObservations = 0
    do {
        try handler.perform([request])
    } catch {
        fputs("ERROR: Vision rectangle detection failed: \(error.localizedDescription)\n", stderr)
        exit(1)
    }
    print(encodeJSON(results))
    exit(0)
}

// ─── Document ────────────────────────────────────────────────────────────────

if isDocument {
    var results: [DocumentResult] = []
    let request = VNDetectDocumentSegmentationRequest { (req, _) in
        guard let obs = req.results as? [VNRectangleObservation] else { return }
        for o in obs {
            results.append(DocumentResult(
                topLeft: pt(o.topLeft), topRight: pt(o.topRight),
                bottomLeft: pt(o.bottomLeft), bottomRight: pt(o.bottomRight),
                confidence: o.confidence
            ))
        }
    }
    do {
        try handler.perform([request])
    } catch {
        fputs("ERROR: Vision document detection failed: \(error.localizedDescription)\n", stderr)
        exit(1)
    }
    print(encodeJSON(results))
    exit(0)
}

// ─── Classify ────────────────────────────────────────────────────────────────

if isClassify {
    var results: [ClassificationResult] = []
    let request = VNClassifyImageRequest { (req, _) in
        guard let obs = req.results as? [VNClassificationObservation] else { return }
        let top = obs.filter { $0.confidence > 0.01 }.prefix(10)
        for o in top {
            results.append(ClassificationResult(identifier: o.identifier, confidence: o.confidence))
        }
    }
    do {
        try handler.perform([request])
    } catch {
        fputs("ERROR: Vision classification failed: \(error.localizedDescription)\n", stderr)
        exit(1)
    }
    print(encodeJSON(results))
    exit(0)
}
