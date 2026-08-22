import Vision
import AppKit
import Foundation
import CoreGraphics
import CoreImage
import ImageIO
import UniformTypeIdentifiers

// ─── Result structs ──────────────────────────────────────────────────────────

struct OCRResult: Codable {
    let t: String
    let x: Double; let y: Double; let w: Double; let h: Double
    let confidence: Float
}

/// Normalized box, top-left origin. Wire keys match the public TS `NormalizedRect`.
struct Box: Codable {
    let x: Double; let y: Double; let width: Double; let height: Double
    let confidence: Float
    init(_ r: CGRect, _ confidence: Float) {
        x = Double(r.origin.x); y = flipY(Double(r.origin.y), Double(r.size.height))
        width = Double(r.size.width); height = Double(r.size.height)
        self.confidence = confidence
    }
}

struct BarcodeResult: Codable {
    let type: String
    let value: String
    let x: Double; let y: Double; let width: Double; let height: Double
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

struct CompareResult: Codable {
    let distance: Double
}

struct SmudgeResult: Codable {
    let confidence: Float
    let supported: Bool
}

struct EntityResult: Codable {
    let type: String
    let text: String
    let start: Int
    let end: Int
    let value: String?
    let components: [String: String]?
}

struct Capabilities: Codable {
    let helperVersion: String
    let macosVersion: String
    let ocrLanguages: [String]
    let features: [String: Bool]
}

// Document structure (macOS 26+, RecognizeDocumentsRequest)
struct DocRegion: Codable { let x: Double; let y: Double; let width: Double; let height: Double }
struct DocLine: Codable { let text: String; let confidence: Float; let bbox: DocRegion }
struct DocText: Codable {
    let text: String
    let alignment: String?
    let bbox: DocRegion
    let lines: [DocLine]
}
struct DocCell: Codable {
    let text: String
    let row: Int; let col: Int
    let rowSpan: Int; let colSpan: Int
    let bbox: DocRegion
}
struct DocTable: Codable {
    let rowCount: Int; let columnCount: Int
    let rows: [[String]]
    let cells: [DocCell]
    let bbox: DocRegion
}
struct DocListItem: Codable { let marker: String; let text: String; let bbox: DocRegion }
struct DocList: Codable { let items: [DocListItem]; let bbox: DocRegion }
struct DocData: Codable { let type: String; let text: String; let value: String?; let bbox: DocRegion }
struct DocBarcode: Codable { let type: String; let value: String; let bbox: DocRegion }
struct DocStructure: Codable {
    let title: DocText?
    let text: String
    let paragraphs: [DocText]
    let tables: [DocTable]
    let lists: [DocList]
    let barcodes: [DocBarcode]
    let detectedData: [DocData]
}

struct PointResult: Codable { let x: Double; let y: Double; let confidence: Float }
struct FaceLandmarksResult: Codable {
    let x: Double; let y: Double; let width: Double; let height: Double
    let confidence: Float
    let roll: Double?; let yaw: Double?; let pitch: Double?
    let captureQuality: Float?
    let landmarks: [String: [[Double]]]
}
struct PoseResult: Codable { let joints: [String: PointResult]; let confidence: Float; let chirality: String? }
struct AnimalResult: Codable {
    let labels: [ClassificationResult]
    let x: Double; let y: Double; let width: Double; let height: Double
    let confidence: Float
}
struct HorizonResult: Codable { let angleDegrees: Double }
struct ContourResult: Codable {
    let index: Int; let pointCount: Int; let childCount: Int
    let x: Double; let y: Double; let width: Double; let height: Double
    let points: [[Double]]?
}
struct ContoursResult: Codable { let totalContours: Int; let topLevel: [ContourResult] }
struct SaliencyResult: Codable {
    let regions: [Box]
    let heatmapPath: String?
}
struct MaskResult: Codable { let instances: Int; let outPath: String }
struct AestheticsResult: Codable { let overallScore: Float; let isUtility: Bool }
struct CropResult: Codable { let outPath: String; let width: Int; let height: Int }
struct ImageInfoResult: Codable {
    let width: Int; let height: Int
    let hasAlpha: Bool; let bitsPerComponent: Int
    let colorSpace: String?; let dpi: Double?; let orientation: Int?; let format: String?
}

let HELPER_VERSION = "2"

// VisionCore logs model-loading noise straight to fd 1 in some modes. Point fd 1 at
// stderr for the whole process and write our JSON to the original stdout instead,
// so callers always get exactly one clean payload.
let resultOut: FileHandle = {
    let saved = dup(STDOUT_FILENO)
    dup2(STDERR_FILENO, STDOUT_FILENO)
    return FileHandle(fileDescriptor: saved, closeOnDealloc: false)
}()

func emit(_ text: String) {
    resultOut.write((text + "\n").data(using: .utf8)!)
}

func macOSVersionString() -> String {
    let v = ProcessInfo.processInfo.operatingSystemVersion
    return "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
}

let macOS14 = ProcessInfo.processInfo.isOperatingSystemAtLeast(OperatingSystemVersion(majorVersion: 14, minorVersion: 0, patchVersion: 0))
let macOS15 = ProcessInfo.processInfo.isOperatingSystemAtLeast(OperatingSystemVersion(majorVersion: 15, minorVersion: 0, patchVersion: 0))
let macOS26 = ProcessInfo.processInfo.isOperatingSystemAtLeast(OperatingSystemVersion(majorVersion: 26, minorVersion: 0, patchVersion: 0))

// A symbol introduced in a newer SDK is simply absent when the helper is built
// against an older one — which is exactly what the swiftc fallback does on an
// older Mac. So each modern feature is gated twice: at compile time on the SDK
// (-DSDK_nn, set by the build scripts) and at runtime on #available.
#if SDK_14
let sdk14 = true
#else
let sdk14 = false
#endif
#if SDK_15
let sdk15 = true
#else
let sdk15 = false
#endif
#if SDK_26
let sdk26 = true
#else
let sdk26 = false
#endif
let iso8601 = ISO8601DateFormatter()

func supportedLanguages() -> [String] {
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    return (try? req.supportedRecognitionLanguages()) ?? []
}

/// Run Vision requests against the shared handler; any failure is fatal for a CLI.
func perform(_ requests: [VNRequest], _ what: String) {
    do {
        try handler.perform(requests)
    } catch {
        fail("Vision \(what) failed: \(error.localizedDescription)")
    }
}

func fail(_ message: String, code: Int32 = 1) -> Never {
    fputs("ERROR: \(message)\n", stderr)
    exit(code)
}

// ─── Argument parsing ─────────────────────────────────────────────────────────

let args = CommandLine.arguments
let isJsonMode   = args.contains("--json")
let isFaces      = args.contains("--faces")
let isBarcodes   = args.contains("--barcodes")
let isRectangles = args.contains("--rectangles")
let isDocument   = args.contains("--document")
let isClassify   = args.contains("--classify")
let isTextRects  = args.contains("--text-rects")
let isCompare    = args.contains("--compare")
let isSmudge     = args.contains("--smudge")
let isStructure  = args.contains("--document-structure")
let isEntities   = args.contains("--entities")
let isLandmarks  = args.contains("--face-landmarks")
let isHumans     = args.contains("--humans")
let isBodyPose   = args.contains("--body-pose")
let isHandPose   = args.contains("--hand-pose")
let isAnimals    = args.contains("--animals")
let isAnimalPose = args.contains("--animal-pose")
let isHorizon    = args.contains("--horizon")
let isContours   = args.contains("--contours")
let isSaliency   = args.contains("--saliency")
let isForeground = args.contains("--foreground-mask")
let isPersonMask = args.contains("--person-mask")
let isAesthetics = args.contains("--aesthetics")
let isDocCrop    = args.contains("--document-crop")
let isCrop       = args.contains("--crop")
let isImageInfo  = args.contains("--image-info")
let anyNewMode = isLandmarks || isHumans || isBodyPose || isHandPose || isAnimals || isAnimalPose || isHorizon
    || isContours || isSaliency || isForeground || isPersonMask || isAesthetics || isDocCrop || isCrop || isImageInfo

/// Value following a `--flag`, or nil.
func optValue(_ flag: String) -> String? {
    guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
    return args[i + 1]
}

// Flags that consume the next argument (so it is not mistaken for a file path).
let valueFlags: Set<String> = ["--lang", "--custom-words", "--roi", "--min-text-height", "--out", "--saliency", "--crop", "--max-points"]
var consumed = Set<Int>()
for (i, a) in args.enumerated() where valueFlags.contains(a) && i + 1 < args.count { consumed.insert(i + 1) }
let fileArgs = args.enumerated()
    .filter { i, a in i > 0 && !a.hasPrefix("--") && !consumed.contains(i) }
    .map { $0.element }

// ─── Modes that need no image ───────────────────────────────────────────────

if args.contains("--languages") {
    emit(encodeJSON(supportedLanguages()))
    exit(0)
}

if args.contains("--capabilities") {
    let caps = Capabilities(
        helperVersion: HELPER_VERSION,
        macosVersion: macOSVersionString(),
        ocrLanguages: supportedLanguages(),
        features: [
            "ocr": true, "ocrOptions": true, "faces": true, "barcodes": true,
            "rectangles": true, "document": true, "classify": true,
            "textRects": true, "compare": true, "entities": true,
            "documentStructure": macOS26 && sdk26, "lensSmudge": macOS26 && sdk26,
            "faceLandmarks": true, "humans": true, "bodyPose": true, "handPose": true,
            "animals": true, "animalPose": macOS14 && sdk14, "horizon": true, "contours": true,
            "saliency": true, "foregroundMask": macOS14 && sdk14, "personMask": true,
            "aesthetics": macOS15 && sdk15, "documentCrop": true, "crop": true, "imageInfo": true,
        ]
    )
    emit(encodeJSON(caps))
    exit(0)
}

// --entities: NSDataDetector over UTF-8 text read from stdin. No image involved.
if isEntities {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    let text = String(decoding: data, as: UTF8.self)
    let types: NSTextCheckingResult.CheckingType = [.link, .phoneNumber, .address, .date, .transitInformation]
    guard let detector = try? NSDataDetector(types: types.rawValue) else {
        fail("NSDataDetector unavailable")
    }
    let ns = text as NSString
    var results: [EntityResult] = []
    for m in detector.matches(in: text, options: [], range: NSRange(location: 0, length: ns.length)) {
        let matched = ns.substring(with: m.range)
        var type = "unknown"
        var value: String? = nil
        var comps: [String: String]? = nil
        switch m.resultType {
        case .link:
            type = "link"; value = m.url?.absoluteString
            if let u = m.url, u.scheme == "mailto" { type = "email"; value = String(u.absoluteString.dropFirst(7)) }
        case .phoneNumber:
            type = "phone"; value = m.phoneNumber
        case .address:
            type = "address"
            if let c = m.addressComponents {
                var d: [String: String] = [:]
                for (k, v) in c { d[k.rawValue] = v }
                comps = d
                value = c[.street].map { s in [s, c[.city], c[.zip]].compactMap { $0 }.joined(separator: ", ") }
            }
        case .date:
            type = "date"; value = m.date.map { iso8601.string(from: $0) }
            if m.duration > 0 { comps = ["durationSeconds": String(Int(m.duration))] }
        case .transitInformation:
            type = "transit"
            if let c = m.components { var d: [String: String] = [:]; for (k, v) in c { d[k.rawValue] = v }; comps = d }
        default: break
        }
        results.append(EntityResult(type: type, text: matched, start: m.range.location,
                                    end: m.range.location + m.range.length, value: value, components: comps))
    }
    emit(encodeJSON(results))
    exit(0)
}

guard let imagePath = fileArgs.first else {
    emit("Usage: vision-helper [--json|--faces|--barcodes|--rectangles|--document|--classify|--text-rects|--document-structure|--smudge|--compare <a> <b>] <path>")
    emit("       vision-helper --languages | --capabilities | --entities < text.txt")
    emit("OCR options: --lang pl,en --auto-lang --no-correction --custom-words a,b --fast --roi x,y,w,h --min-text-height f")
    exit(0)
}

// ─── Image compare (feature print distance) ──────────────────────────────────

if isCompare {
    guard fileArgs.count >= 2 else {
        fail("--compare needs two image paths")
    }
    func featurePrint(_ path: String) -> VNFeaturePrintObservation? {
        guard let img = NSImage(contentsOf: URL(fileURLWithPath: path)),
              let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            fail("Cannot open file: \(path)")
        }
        let req = VNGenerateImageFeaturePrintRequest()
        let h = VNImageRequestHandler(cgImage: cg, options: [:])
        try? h.perform([req])
        return req.results?.first as? VNFeaturePrintObservation
    }
    guard let a = featurePrint(fileArgs[0]), let b = featurePrint(fileArgs[1]) else {
        fail("Vision feature print failed")
    }
    var distance: Float = 0
    do { try a.computeDistance(&distance, to: b) } catch {
        fail("Vision feature print distance failed: \(error.localizedDescription)")
    }
    emit(encodeJSON(CompareResult(distance: Double(distance))))
    exit(0)
}

guard let image = NSImage(contentsOf: URL(fileURLWithPath: imagePath)),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    fail("Cannot open file: \(imagePath)")
}

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])

// ─── Shared OCR options ──────────────────────────────────────────────────────

let ocrLanguages: [String] = optValue("--lang")?.split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } ?? []
let ocrCustomWords: [String] = optValue("--custom-words")?.split(separator: ",").map { String($0) }.filter { !$0.isEmpty } ?? []
let ocrAutoLang = args.contains("--auto-lang")
let ocrNoCorrection = args.contains("--no-correction")
let ocrFast = args.contains("--fast")
let ocrMinHeight: Float? = optValue("--min-text-height").flatMap { Float($0) }

// Region of interest: normalized x,y,w,h with TOP-LEFT origin (same space as our output).
// Vision wants bottom-left origin, so flip. Results stay relative to the full image
// because the handler reports observations in full-image coordinates.
var roiRect: CGRect? = nil
if let roi = optValue("--roi") {
    let p = roi.split(separator: ",").compactMap { Double($0) }
    if p.count == 4 {
        roiRect = CGRect(x: p[0], y: 1.0 - p[1] - p[3], width: p[2], height: p[3])
    } else {
        fail("--roi expects x,y,w,h (normalized 0-1)")
    }
}

/// Vision reports observations relative to `regionOfInterest`; map back to full-image space.
func unROI(_ r: CGRect) -> CGRect {
    guard let roi = roiRect else { return r }
    return CGRect(x: roi.origin.x + r.origin.x * roi.width,
                  y: roi.origin.y + r.origin.y * roi.height,
                  width: r.width * roi.width, height: r.height * roi.height)
}

// ─── OCR (default + --json) ───────────────────────────────────────────────────

if isJsonMode || (!isFaces && !isBarcodes && !isRectangles && !isDocument && !isClassify && !isTextRects && !isSmudge && !isStructure && !anyNewMode) {
    var ocrResults: [OCRResult] = []
    var rawText = ""

    let request = VNRecognizeTextRequest { (req, _) in
        guard let obs = req.results as? [VNRecognizedTextObservation] else { return }
        for o in obs {
            guard let c = o.topCandidates(1).first else { continue }
            let box = unROI(o.boundingBox)
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
    request.recognitionLevel = ocrFast ? .fast : .accurate
    if !ocrLanguages.isEmpty { request.recognitionLanguages = ocrLanguages }
    if ocrAutoLang { request.automaticallyDetectsLanguage = true }
    request.usesLanguageCorrection = !ocrNoCorrection
    if !ocrCustomWords.isEmpty { request.customWords = ocrCustomWords }
    if let mh = ocrMinHeight { request.minimumTextHeight = mh }
    if let r = roiRect { request.regionOfInterest = r }

    perform([request], "OCR")
    emit(isJsonMode ? encodeJSON(ocrResults) : rawText.trimmingCharacters(in: .whitespacesAndNewlines))
    exit(0)
}

// ─── Text rectangles (fast "where is text" without recognition) ──────────────

if isTextRects {
    var results: [Box] = []
    let request = VNDetectTextRectanglesRequest { (req, _) in
        guard let obs = req.results as? [VNTextObservation] else { return }
        results = obs.map { Box(unROI($0.boundingBox), $0.confidence) }
    }
    if let r = roiRect { request.regionOfInterest = r }
    perform([request], "text rectangle detection")
    emit(encodeJSON(results))
    exit(0)
}

// ─── macOS 26+: document structure & lens smudge (new Vision Swift API) ──────

#if SDK_26
@available(macOS 26.0, *)
func region(_ r: NormalizedRegion) -> DocRegion {
    let b = r.boundingBox
    return DocRegion(x: Double(b.origin.x), y: flipY(Double(b.origin.y), Double(b.height)),
                     width: Double(b.width), height: Double(b.height))
}

@available(macOS 26.0, *)
func docText(_ t: DocumentObservation.Container.Text) -> DocText {
    let align: String?
    switch t.textAlignment {
    case .some(.leading): align = "leading"
    case .some(.trailing): align = "trailing"
    case .some(.center): align = "center"
    default: align = nil
    }
    return DocText(
        text: t.transcript,
        alignment: align,
        bbox: region(t.boundingRegion),
        lines: t.lines.map { DocLine(text: $0.transcript, confidence: $0.confidence, bbox: region($0.boundingRegion)) }
    )
}

@available(macOS 26.0, *)
func docData(_ d: DocumentObservation.Container.DataDetectorMatch, in text: String) -> DocData {
    var type = "unknown"
    var value: String? = nil
    switch d.match.details {
    case .link(let l): type = "link"; value = l.url.absoluteString
    case .emailAddress(let e): type = "email"; value = e.emailAddress
    case .phoneNumber(let p): type = "phone"; value = p.phoneNumber
    case .postalAddress(let a): type = "address"; value = a.fullAddress
    case .calendarEvent(let c): type = "date"; value = c.startDate.map { iso8601.string(from: $0) }
    case .moneyAmount(let m): type = "money"; value = "\(m.amount) \(m.currency.identifier)"
    case .flightNumber(let f): type = "flight"; value = "\(f.airlineCode)\(f.flightNumber)"
    case .shipmentTrackingNumber(let s): type = "tracking"; value = s.trackingNumber
    case .measurement(let m): type = "measurement"; value = String(m.value)
    case .paymentIdentifier(let p): type = "payment"; value = p.identifier
    @unknown default: break
    }
    let matched = d.match.range.map { String(text[$0]) } ?? ""
    return DocData(type: type, text: matched, value: value, bbox: region(d.boundingRegion))
}

@available(macOS 26.0, *)
func runDocumentStructure() -> DocStructure? {
    var req = RecognizeDocumentsRequest()
    var opts = req.textRecognitionOptions
    if !ocrLanguages.isEmpty { opts.recognitionLanguages = ocrLanguages.map { Locale.Language(identifier: $0) } }
    if ocrAutoLang { opts.automaticallyDetectLanguage = true }
    opts.useLanguageCorrection = !ocrNoCorrection
    if !ocrCustomWords.isEmpty { opts.customWords = ocrCustomWords }
    if let mh = ocrMinHeight { opts.minimumTextHeightFraction = mh }
    req.textRecognitionOptions = opts
    if let r = roiRect { req.regionOfInterest = NormalizedRect(normalizedRect: r) }

    let sema = DispatchSemaphore(value: 0)
    var result: DocStructure? = nil
    var failure: Error? = nil
    Task {
        do {
            let observations = try await req.perform(on: cgImage)
            if let doc = observations.first {
                let c = doc.document
                let full = c.text.transcript
                var tables: [DocTable] = []
                for t in c.tables {
                    var cells: [DocCell] = []
                    var rows: [[String]] = []
                    for (ri, row) in t.rows.enumerated() {
                        var rowTexts: [String] = []
                        for cell in row {
                            // A spanning cell appears in every row it covers; emit it once.
                            if cell.rowRange.lowerBound == ri {
                                cells.append(DocCell(
                                    text: cell.content.text.transcript,
                                    row: cell.rowRange.lowerBound, col: cell.columnRange.lowerBound,
                                    rowSpan: cell.rowRange.count, colSpan: cell.columnRange.count,
                                    bbox: region(cell.content.boundingRegion)
                                ))
                            }
                            rowTexts.append(cell.content.text.transcript)
                        }
                        rows.append(rowTexts)
                    }
                    tables.append(DocTable(rowCount: t.rows.count, columnCount: t.columns.count,
                                           rows: rows, cells: cells, bbox: region(t.boundingRegion)))
                }
                let lists = c.lists.map { l in
                    DocList(items: l.items.map { DocListItem(marker: $0.markerString, text: $0.itemString,
                                                            bbox: region($0.content.boundingRegion)) },
                            bbox: region(l.boundingRegion))
                }
                let barcodes = c.barcodes.map {
                    DocBarcode(type: String(describing: $0.symbology), value: $0.payloadString ?? "", bbox: region($0.boundingRegion))
                }
                result = DocStructure(
                    title: c.title.map(docText),
                    text: full,
                    paragraphs: c.paragraphs.map(docText),
                    tables: tables,
                    lists: lists,
                    barcodes: barcodes,
                    detectedData: c.text.detectedData.map { docData($0, in: full) }
                )
            } else {
                result = DocStructure(title: nil, text: "", paragraphs: [], tables: [], lists: [], barcodes: [], detectedData: [])
            }
        } catch {
            failure = error
        }
        sema.signal()
    }
    sema.wait()
    if let e = failure {
        fail("Vision document recognition failed: \(e.localizedDescription)")
    }
    return result
}

@available(macOS 26.0, *)
func runSmudge() -> SmudgeResult {
    let req = DetectLensSmudgeRequest()
    // VisionCore logs "Unable to find a valid E5 ..." straight to stdout on hardware
    // without the smudge model. Divert stdout to a temp file while the request runs
    // so the JSON we print afterwards stays clean, and use the noise to flag support.
    let tmp = NSTemporaryDirectory() + "vision-helper-smudge-\(getpid()).log"
    let savedStdout = dup(STDOUT_FILENO)
    fflush(stdout)
    let fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC, 0o600)
    if fd >= 0 { dup2(fd, STDOUT_FILENO); close(fd) }
    let sema = DispatchSemaphore(value: 0)
    var conf: Float = 0
    var failure: Error? = nil
    Task {
        do { conf = try await req.perform(on: cgImage).confidence } catch { failure = error }
        sema.signal()
    }
    sema.wait()
    fflush(stdout)
    dup2(savedStdout, STDOUT_FILENO)
    close(savedStdout)
    let noise = (try? String(contentsOfFile: tmp, encoding: .utf8)) ?? ""
    unlink(tmp)
    if let e = failure { fail("Vision lens smudge detection failed: \(e.localizedDescription)") }
    let supported = !noise.contains("Unable to find")
    return SmudgeResult(confidence: conf, supported: supported)
}
#endif

if isStructure {
#if SDK_26
    if #available(macOS 26.0, *) {
        if let s = runDocumentStructure() { emit(encodeJSON(s)) }
        exit(0)
    }
#endif
    fail("--document-structure requires macOS 26 or newer", code: 2)
}

if isSmudge {
#if SDK_26
    if #available(macOS 26.0, *) {
        emit(encodeJSON(runSmudge()))
        exit(0)
    }
#endif
    fail("--smudge requires macOS 26 or newer", code: 2)
}


// ─── Pixel output helpers ────────────────────────────────────────────────────

func writePNG(_ cg: CGImage, to path: String) -> Bool {
    let url = URL(fileURLWithPath: path) as CFURL
    guard let dest = CGImageDestinationCreateWithURL(url, UTType.png.identifier as CFString, 1, nil) else { return false }
    CGImageDestinationAddImage(dest, cg, nil)
    return CGImageDestinationFinalize(dest)
}

let ciContext = CIContext(options: nil)

func cgFromPixelBuffer(_ pb: CVPixelBuffer) -> CGImage? {
    let ci = CIImage(cvPixelBuffer: pb)
    return ciContext.createCGImage(ci, from: ci.extent)
}

func requireOut() -> String {
    guard let out = optValue("--out") else {
        fail("this mode requires --out <path.png>")
    }
    return out
}

func jointsDict(_ points: [VNRecognizedPointKey: VNRecognizedPoint]) -> [String: PointResult] {
    var d: [String: PointResult] = [:]
    for (k, p) in points where p.confidence > 0 {
        d[k.rawValue] = PointResult(x: Double(p.x), y: 1.0 - Double(p.y), confidence: p.confidence)
    }
    return d
}

// ─── Image info (no Vision) ──────────────────────────────────────────────────

if isImageInfo {
    var dpi: Double? = nil, orientation: Int? = nil, format: String? = nil
    if let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: imagePath) as CFURL, nil) {
        format = CGImageSourceGetType(src) as String?
        if let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any] {
            dpi = props[kCGImagePropertyDPIWidth] as? Double
            orientation = props[kCGImagePropertyOrientation] as? Int
        }
    }
    let info = ImageInfoResult(
        width: cgImage.width, height: cgImage.height,
        hasAlpha: cgImage.alphaInfo != .none && cgImage.alphaInfo != .noneSkipFirst && cgImage.alphaInfo != .noneSkipLast,
        bitsPerComponent: cgImage.bitsPerComponent,
        colorSpace: cgImage.colorSpace?.name as String?,
        dpi: dpi, orientation: orientation, format: format
    )
    emit(encodeJSON(info))
    exit(0)
}

// ─── Crop (normalized region, top-left origin) ───────────────────────────────

if isCrop {
    let out = requireOut()
    let p = optValue("--crop")?.split(separator: ",").compactMap { Double($0) } ?? []
    guard p.count == 4 else {
        fail("--crop expects x,y,w,h (normalized 0-1)")
    }
    let W = Double(cgImage.width), H = Double(cgImage.height)
    let rect = CGRect(x: p[0] * W, y: p[1] * H, width: p[2] * W, height: p[3] * H).integral
    guard let cropped = cgImage.cropping(to: rect), writePNG(cropped, to: out) else {
        fail("crop failed")
    }
    emit(encodeJSON(CropResult(outPath: out, width: cropped.width, height: cropped.height)))
    exit(0)
}

// ─── Document crop (perspective-corrected) ───────────────────────────────────

if isDocCrop {
    let out = requireOut()
    let request = VNDetectDocumentSegmentationRequest()
    try? handler.perform([request])
    guard let o = request.results?.first as? VNRectangleObservation else {
        fail("no document detected")
    }
    let ci = CIImage(cgImage: cgImage)
    let W = ci.extent.width, H = ci.extent.height
    func p(_ pt: CGPoint) -> CGPoint { CGPoint(x: pt.x * W, y: pt.y * H) }
    let filter = CIFilter(name: "CIPerspectiveCorrection")!
    filter.setValue(ci, forKey: kCIInputImageKey)
    filter.setValue(CIVector(cgPoint: p(o.topLeft)), forKey: "inputTopLeft")
    filter.setValue(CIVector(cgPoint: p(o.topRight)), forKey: "inputTopRight")
    filter.setValue(CIVector(cgPoint: p(o.bottomLeft)), forKey: "inputBottomLeft")
    filter.setValue(CIVector(cgPoint: p(o.bottomRight)), forKey: "inputBottomRight")
    guard let outCI = filter.outputImage,
          let outCG = ciContext.createCGImage(outCI, from: outCI.extent),
          writePNG(outCG, to: out) else {
        fail("perspective correction failed")
    }
    emit(encodeJSON(CropResult(outPath: out, width: outCG.width, height: outCG.height)))
    exit(0)
}

// ─── Face landmarks + capture quality ────────────────────────────────────────

if isLandmarks {
    let lm = VNDetectFaceLandmarksRequest()
    let cq = VNDetectFaceCaptureQualityRequest()
    perform([lm, cq], "face landmarks")
    let faces = (lm.results ?? [])
    let quals = (cq.results ?? [])
    var results: [FaceLandmarksResult] = []
    for (i, f) in faces.enumerated() {
        let b = Box(f.boundingBox, f.confidence)
        var marks: [String: [[Double]]] = [:]
        if let l = f.landmarks {
            let regions: [(String, VNFaceLandmarkRegion2D?)] = [
                ("faceContour", l.faceContour), ("leftEye", l.leftEye), ("rightEye", l.rightEye),
                ("leftEyebrow", l.leftEyebrow), ("rightEyebrow", l.rightEyebrow), ("nose", l.nose),
                ("noseCrest", l.noseCrest), ("medianLine", l.medianLine), ("outerLips", l.outerLips),
                ("innerLips", l.innerLips), ("leftPupil", l.leftPupil), ("rightPupil", l.rightPupil),
            ]
            for (name, r) in regions {
                guard let r = r else { continue }
                // pointsInImage gives pixel coords (bottom-left origin); normalize + flip.
                let pts = r.pointsInImage(imageSize: CGSize(width: cgImage.width, height: cgImage.height))
                marks[name] = pts.map { [Double($0.x) / Double(cgImage.width), 1.0 - Double($0.y) / Double(cgImage.height)] }
            }
        }
        let q: Float? = i < quals.count ? quals[i].faceCaptureQuality : nil
        results.append(FaceLandmarksResult(
            x: b.x, y: b.y, width: b.width, height: b.height, confidence: f.confidence,
            roll: f.roll.map { Double(truncating: $0) * 180 / .pi },
            yaw: f.yaw.map { Double(truncating: $0) * 180 / .pi },
            pitch: f.pitch.map { Double(truncating: $0) * 180 / .pi },
            captureQuality: q, landmarks: marks
        ))
    }
    emit(encodeJSON(results))
    exit(0)
}

// ─── Human rectangles ────────────────────────────────────────────────────────

if isHumans {
    let request = VNDetectHumanRectanglesRequest()
    request.upperBodyOnly = false
    perform([request], "human detection")
    let results = (request.results ?? []).map { Box($0.boundingBox, $0.confidence) }
    emit(encodeJSON(results))
    exit(0)
}

// ─── Body / hand / animal pose ───────────────────────────────────────────────

if isBodyPose {
    let request = VNDetectHumanBodyPoseRequest()
    perform([request], "body pose")
    let results = (request.results ?? []).map { o in
        PoseResult(joints: jointsDict((try? o.recognizedPoints(forGroupKey: .all)) ?? [:]), confidence: o.confidence, chirality: nil)
    }
    emit(encodeJSON(results))
    exit(0)
}

if isHandPose {
    let request = VNDetectHumanHandPoseRequest()
    request.maximumHandCount = 4
    perform([request], "hand pose")
    let results = (request.results ?? []).map { o -> PoseResult in
        let ch: String
        switch o.chirality { case .left: ch = "left"; case .right: ch = "right"; default: ch = "unknown" }
        return PoseResult(joints: jointsDict((try? o.recognizedPoints(forGroupKey: .all)) ?? [:]), confidence: o.confidence, chirality: ch)
    }
    emit(encodeJSON(results))
    exit(0)
}

if isAnimalPose {
#if SDK_14
    if #available(macOS 14.0, *) {
        let request = VNDetectAnimalBodyPoseRequest()
        perform([request], "animal pose")
        let results = (request.results ?? []).map { o in
            PoseResult(joints: jointsDict((try? o.recognizedPoints(forGroupKey: .all)) ?? [:]), confidence: o.confidence, chirality: nil)
        }
        emit(encodeJSON(results))
        exit(0)
    }
#endif
    fail("--animal-pose requires macOS 14 or newer", code: 2)
}

// ─── Animals (cat / dog) ─────────────────────────────────────────────────────

if isAnimals {
    let request = VNRecognizeAnimalsRequest()
    perform([request], "animal recognition")
    let results = (request.results ?? []).map { o -> AnimalResult in
        let b = Box(o.boundingBox, o.confidence)
        return AnimalResult(
            labels: o.labels.map { ClassificationResult(identifier: $0.identifier, confidence: $0.confidence) },
            x: b.x, y: b.y, width: b.width, height: b.height, confidence: o.confidence
        )
    }
    emit(encodeJSON(results))
    exit(0)
}

// ─── Horizon ─────────────────────────────────────────────────────────────────

if isHorizon {
    let request = VNDetectHorizonRequest()
    perform([request], "horizon detection")
    guard let o = request.results?.first as? VNHorizonObservation else {
        emit("null")
        exit(0)
    }
    emit(encodeJSON(HorizonResult(angleDegrees: Double(o.angle) * 180 / .pi)))
    exit(0)
}

// ─── Contours ────────────────────────────────────────────────────────────────

if isContours {
    let request = VNDetectContoursRequest()
    request.detectsDarkOnLight = !args.contains("--light-on-dark")
    if let r = roiRect { request.regionOfInterest = r }
    perform([request], "contour detection")
    guard let o = request.results?.first as? VNContoursObservation else {
        emit(encodeJSON(ContoursResult(totalContours: 0, topLevel: [])))
        exit(0)
    }
    let maxPoints = optValue("--max-points").flatMap { Int($0) } ?? 0
    var top: [ContourResult] = []
    for (i, c) in o.topLevelContours.enumerated() {
        let b = Box(unROI(c.normalizedPath.boundingBox), 1)
        var pts: [[Double]]? = nil
        if maxPoints > 0 {
            let all = c.normalizedPoints
            let stride = max(1, all.count / maxPoints)
            pts = Swift.stride(from: 0, to: all.count, by: stride).map {
                let q = unROI(CGRect(x: CGFloat(all[$0].x), y: CGFloat(all[$0].y), width: 0, height: 0))
                return [Double(q.origin.x), 1.0 - Double(q.origin.y)]
            }
        }
        top.append(ContourResult(index: i, pointCount: c.pointCount, childCount: c.childContourCount,
                                 x: b.x, y: b.y, width: b.width, height: b.height, points: pts))
    }
    emit(encodeJSON(ContoursResult(totalContours: o.contourCount, topLevel: top)))
    exit(0)
}

// ─── Saliency (attention | objectness) ───────────────────────────────────────

if isSaliency {
    let kind = optValue("--saliency") ?? "attention"
    let request: VNImageBasedRequest = kind == "objectness"
        ? VNGenerateObjectnessBasedSaliencyImageRequest()
        : VNGenerateAttentionBasedSaliencyImageRequest()
    perform([request], "saliency")
    guard let o = request.results?.first as? VNSaliencyImageObservation else {
        emit(encodeJSON(SaliencyResult(regions: [], heatmapPath: nil)))
        exit(0)
    }
    let regions = (o.salientObjects ?? []).map { Box($0.boundingBox, $0.confidence) }
    var heat: String? = nil
    if let out = optValue("--out"), let cg = cgFromPixelBuffer(o.pixelBuffer), writePNG(cg, to: out) { heat = out }
    emit(encodeJSON(SaliencyResult(regions: regions, heatmapPath: heat)))
    exit(0)
}

// ─── Foreground subject cutout / person mask ─────────────────────────────────

if isForeground {
#if SDK_14
    if #available(macOS 14.0, *) {
        let out = requireOut()
        let request = VNGenerateForegroundInstanceMaskRequest()
        perform([request], "foreground mask")
        guard let o = request.results?.first as? VNInstanceMaskObservation else {
            emit(encodeJSON(MaskResult(instances: 0, outPath: "")))
            exit(0)
        }
        let maskOnly = args.contains("--mask-only")
        do {
            let pb = maskOnly
                ? try o.generateScaledMaskForImage(forInstances: o.allInstances, from: handler)
                : try o.generateMaskedImage(ofInstances: o.allInstances, from: handler, croppedToInstancesExtent: args.contains("--tight"))
            guard let cg = cgFromPixelBuffer(pb), writePNG(cg, to: out) else { throw NSError(domain: "vision-helper", code: 1) }
        } catch {
            fail("could not write foreground image: \(error.localizedDescription)")
        }
        emit(encodeJSON(MaskResult(instances: o.allInstances.count, outPath: out)))
        exit(0)
    }
#endif
    fail("--foreground-mask requires macOS 14 or newer", code: 2)
}

if isPersonMask {
    let out = requireOut()
    let request = VNGeneratePersonSegmentationRequest()
    request.qualityLevel = .accurate
    request.outputPixelFormat = kCVPixelFormatType_OneComponent8
    perform([request], "person segmentation")
    guard let o = request.results?.first as? VNPixelBufferObservation,
          let cg = cgFromPixelBuffer(o.pixelBuffer), writePNG(cg, to: out) else {
        fail("could not write person mask")
    }
    emit(encodeJSON(MaskResult(instances: 1, outPath: out)))
    exit(0)
}

// ─── Aesthetics (macOS 15+) ──────────────────────────────────────────────────

if isAesthetics {
#if SDK_15
    if #available(macOS 15.0, *) {
        let request = VNCalculateImageAestheticsScoresRequest()
        perform([request], "aesthetics")
        guard let o = request.results?.first as? VNImageAestheticsScoresObservation else {
            emit("null")
            exit(0)
        }
        emit(encodeJSON(AestheticsResult(overallScore: o.overallScore, isUtility: o.isUtility)))
        exit(0)
    }
#endif
    fail("--aesthetics requires macOS 15 or newer", code: 2)
}

// ─── Faces ───────────────────────────────────────────────────────────────────

if isFaces {
    var results: [Box] = []
    let request = VNDetectFaceRectanglesRequest { (req, _) in
        guard let obs = req.results as? [VNFaceObservation] else { return }
        results = obs.map { Box($0.boundingBox, $0.confidence) }
    }
    perform([request], "face detection")
    emit(encodeJSON(results))
    exit(0)
}

// ─── Barcodes ────────────────────────────────────────────────────────────────

if isBarcodes {
    var results: [BarcodeResult] = []
    let request = VNDetectBarcodesRequest { (req, _) in
        guard let obs = req.results as? [VNBarcodeObservation] else { return }
        for o in obs {
            let b = Box(o.boundingBox, o.confidence)
            results.append(BarcodeResult(
                type: o.symbology.rawValue, value: o.payloadStringValue ?? "",
                x: b.x, y: b.y, width: b.width, height: b.height, confidence: o.confidence
            ))
        }
    }
    perform([request], "barcode detection")
    emit(encodeJSON(results))
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
    request.maximumObservations = 0
    perform([request], "rectangle detection")
    emit(encodeJSON(results))
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
    perform([request], "document detection")
    emit(encodeJSON(results))
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
    perform([request], "classification")
    emit(encodeJSON(results))
    exit(0)
}
