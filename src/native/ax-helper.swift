import AppKit
import ApplicationServices
import Foundation

// ax-helper — accessibility tree of a running application, as a box model.
//
// Read-only: reads attributes, never sets them and never synthesises input.
//
// Every attribute read is a synchronous IPC round trip into the target app, so a
// naive walk is unusably slow (measured: 4001 elements cost 1.57s in Safari but
// 26s in Finder, one attribute at a time). Three things keep it bounded:
// batched reads, viewport culling, and a hard element/depth budget that is
// reported rather than applied silently.

// ─── Wire types ──────────────────────────────────────────────────────────────

/// Encoded as [x, y, w, h] — the same four numbers cost ~4x fewer tokens than
/// a keyed object repeated across a whole tree, and read just as clearly.
typealias Box = [Double]

struct Style: Codable {
    let bg: String?
    let border: String?
    let borderWidth: Int?
}

struct Typography: Codable {
    let font: String?
    let family: String?
    let size: Double?
    let align: String?
}

struct Node: Codable {
    let id: Int
    let parent: Int?
    let depth: Int
    let role: String
    let subrole: String?
    let label: String?
    let value: String?
    /// Present only when false — enabled is the overwhelming default.
    let enabled: Bool?
    /// Present only when true.
    let focused: Bool?
    /// Global screen points, top-left origin — the space click drivers use.
    let box: Box
    let style: Style?
    let text: Typography?
}

struct Budget: Codable {
    let elements: Int
    let capped: Bool
    let maxElements: Int
    let maxDepth: Int
    let elapsedMs: Int
    /// Elements skipped because their frame fell outside the culling rect.
    let culled: Int
}

struct TreeResult: Codable {
    let app: String
    let pid: Int
    let window: Box?
    /// "ax" for geometry only, "ax+px" once colours were sampled.
    let source: String
    let budget: Budget
    let nodes: [Node]
}

func encodeJSON<T: Encodable>(_ value: T) -> String {
    let enc = JSONEncoder()
    guard let data = try? enc.encode(value), let s = String(data: data, encoding: .utf8) else { return "{}" }
    return s
}

func fail(_ message: String, code: Int32 = 1) -> Never {
    fputs("ERROR: \(message)\n", stderr)
    exit(code)
}

// ─── Argument parsing ────────────────────────────────────────────────────────

let args = CommandLine.arguments
func opt(_ flag: String) -> String? {
    guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
    return args[i + 1]
}
func intOpt(_ flag: String, _ fallback: Int) -> Int { Int(opt(flag) ?? "") ?? fallback }

let maxElements = intOpt("--max-elements", 1500)
let maxDepth = intOpt("--max-depth", 40)
let visibleOnly = !args.contains("--include-offscreen")
let wantTypography = args.contains("--typography")
let colorsPath = opt("--colors")
// "content" (default) drops unlabelled structural containers; "full" keeps the
// raw tree. Boxes are absolute, so nesting adds little for a reader — but it
// adds a lot of tokens: on a Safari window it is roughly half the payload.
let detailFull = (opt("--detail") ?? "content") == "full"

// ─── Target application ──────────────────────────────────────────────────────

let running = NSWorkspace.shared.runningApplications
var target: NSRunningApplication?
if let pidStr = opt("--pid"), let pid = Int32(pidStr) {
    target = running.first { $0.processIdentifier == pid }
    if target == nil { fail("no running application with pid \(pidStr)") }
} else if let name = opt("--app") {
    let q = name.lowercased()
    target = running.first { ($0.localizedName ?? "").lowercased() == q }
        ?? running.first { ($0.localizedName ?? "").lowercased().hasPrefix(q) }
    if target == nil {
        let visible = running.compactMap { $0.activationPolicy == .regular ? $0.localizedName : nil }
        fail("no running application matches \"\(name)\". Running: \(visible.joined(separator: ", "))")
    }
} else {
    fail("usage: ax-helper --app <name> | --pid <n> [--window <index>] [--detail content|full] [--max-elements N] [--max-depth N] [--include-offscreen] [--typography] [--colors <png> --frame x,y,w,h]")
}

guard AXIsProcessTrusted() else {
    fail("Accessibility permission missing. Grant it to the host application in System Settings → Privacy & Security → Accessibility, then restart it.", code: 3)
}

let app = target!
let axApp = AXUIElementCreateApplication(app.processIdentifier)
// An unresponsive app must degrade, never hang the caller.
AXUIElementSetMessagingTimeout(axApp, 2.0)

// ─── Attribute plumbing ──────────────────────────────────────────────────────

let wanted: [CFString] = [
    kAXRoleAttribute as CFString,
    kAXSubroleAttribute as CFString,
    kAXTitleAttribute as CFString,
    kAXValueAttribute as CFString,
    kAXDescriptionAttribute as CFString,
    kAXPositionAttribute as CFString,
    kAXSizeAttribute as CFString,
    kAXEnabledAttribute as CFString,
    kAXFocusedAttribute as CFString,
]

/// One IPC round trip for every attribute we need. Measured 1.4–2.3x faster than
/// reading them one at a time, and the gap widens on slow apps.
func readAttributes(_ el: AXUIElement) -> [Any?] {
    var out: CFArray?
    let err = AXUIElementCopyMultipleAttributeValues(el, wanted as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &out)
    guard err == .success, let arr = out as? [Any] else { return Array(repeating: nil, count: wanted.count) }
    // Unset attributes come back as AXValue of type .axError; map those to nil.
    return arr.map { v -> Any? in
        if CFGetTypeID(v as CFTypeRef) == AXValueGetTypeID(),
           AXValueGetType(v as! AXValue) == .axError { return nil }
        return v
    }
}

func point(_ v: Any?) -> CGPoint? {
    guard let v = v, CFGetTypeID(v as CFTypeRef) == AXValueGetTypeID() else { return nil }
    var p = CGPoint.zero
    return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil
}
func size(_ v: Any?) -> CGSize? {
    guard let v = v, CFGetTypeID(v as CFTypeRef) == AXValueGetTypeID() else { return nil }
    var s = CGSize.zero
    return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil
}
func text(_ v: Any?) -> String? {
    guard let s = v as? String else { return nil }
    let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
    return t.isEmpty ? nil : t
}

func children(_ el: AXUIElement) -> [AXUIElement] {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &v) == .success,
          let kids = v as? [AXUIElement] else { return [] }
    return kids
}

// ─── Typography (text elements only) ─────────────────────────────────────────

/// AX carries no styling on ordinary elements, but AXAttributedStringForRange on
/// a text element does return real font data. Costs an extra round trip, so it is
/// opt-in and limited to roles that can actually answer.
func typography(_ el: AXUIElement) -> Typography? {
    var r = CFRange(location: 0, length: 1)
    guard let rangeValue = AXValueCreate(.cfRange, &r) else { return nil }
    var out: CFTypeRef?
    guard AXUIElementCopyParameterizedAttributeValue(el, "AXAttributedStringForRange" as CFString, rangeValue, &out) == .success,
          let s = out as? NSAttributedString, s.length > 0 else { return nil }
    let attrs = s.attributes(at: 0, effectiveRange: nil)
    var family: String?, name: String?, pt: Double?
    if let f = attrs[NSAttributedString.Key("AXFont")] as? [String: Any] {
        family = f["AXFontFamily"] as? String
        name = f["AXFontName"] as? String
        pt = (f["AXFontSize"] as? NSNumber)?.doubleValue
    }
    var align: String?
    if let a = attrs[NSAttributedString.Key("AXATextAlignmentValue")] as? NSNumber {
        align = ["natural", "left", "right", "center", "justified"][safe: a.intValue] ?? nil
    }
    if family == nil && name == nil && pt == nil && align == nil { return nil }
    return Typography(font: name, family: family, size: pt, align: align)
}

extension Array {
    subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}

// ─── Pixels: background and border colour ────────────────────────────────────

final class Pixels {
    private let buf: [UInt8]
    private let w: Int, h: Int
    /// Screen rect the image covers, and pixels per point.
    private let frame: CGRect, scale: Double

    init?(path: String, frame: CGRect) {
        guard let img = NSImage(contentsOfFile: path),
              let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
        w = cg.width; h = cg.height
        var data = [UInt8](repeating: 0, count: w * h * 4)
        guard let ctx = CGContext(data: &data, width: w, height: h, bitsPerComponent: 8,
                                  bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        buf = data
        self.frame = frame
        scale = frame.width > 0 ? Double(w) / Double(frame.width) : 1
    }

    private func rgb(_ x: Int, _ y: Int) -> (Int, Int, Int) {
        let i = (y * w + x) * 4
        return (Int(buf[i]), Int(buf[i + 1]), Int(buf[i + 2]))
    }

    private func hex(_ c: (Int, Int, Int)) -> String { String(format: "#%02X%02X%02X", c.0, c.1, c.2) }

    /// Screen points → image pixels, clamped to the bitmap.
    private func toPixels(_ b: Box) -> (Int, Int, Int, Int)? {
        let px = Int((b[0] - Double(frame.origin.x)) * scale)
        let py = Int((b[1] - Double(frame.origin.y)) * scale)
        let pw = Int(b[2] * scale), ph = Int(b[3] * scale)
        let x0 = max(0, px), y0 = max(0, py)
        let x1 = min(w - 1, px + pw), y1 = min(h - 1, py + ph)
        if x1 - x0 < 2 || y1 - y0 < 2 { return nil }
        return (x0, y0, x1, y1)
    }

    /// Most common colour inside the rect, on a coarse grid — the element's fill.
    private func dominant(_ x0: Int, _ y0: Int, _ x1: Int, _ y1: Int) -> (Int, Int, Int) {
        var hist: [Int: Int] = [:]
        let sx = max(1, (x1 - x0) / 16), sy = max(1, (y1 - y0) / 16)
        var y = y0
        while y <= y1 {
            var x = x0
            while x <= x1 {
                let c = rgb(x, y)
                hist[(c.0 / 16) << 10 | (c.1 / 16) << 5 | (c.2 / 16), default: 0] += 1
                x += sx
            }
            y += sy
        }
        guard let k = hist.max(by: { $0.value < $1.value })?.key else { return (0, 0, 0) }
        return (((k >> 10) & 31) * 16, ((k >> 5) & 31) * 16, (k & 31) * 16)
    }

    /// Fill colour, plus a border when the outline differs from the fill.
    /// Border width is *inferred* by walking inward until the colour settles —
    /// it is an estimate, not a measured CSS value.
    func style(_ b: Box) -> Style? {
        guard let (x0, y0, x1, y1) = toPixels(b) else { return nil }
        let inset = max(2, min((x1 - x0) / 4, (y1 - y0) / 4))
        let fill = dominant(x0 + inset, y0 + inset, x1 - inset, y1 - inset)
        let edge = dominant(x0, y0, x1, min(y0 + 1, y1))
        func near(_ a: (Int, Int, Int), _ c: (Int, Int, Int)) -> Bool {
            abs(a.0 - c.0) + abs(a.1 - c.1) + abs(a.2 - c.2) < 48
        }
        if near(edge, fill) { return Style(bg: hex(fill), border: nil, borderWidth: nil) }
        var width = 1
        let midX = (x0 + x1) / 2
        var y = y0 + 1
        while y < y1 && width < 12 && near(rgb(midX, y), edge) { width += 1; y += 1 }
        return Style(bg: hex(fill), border: hex(edge), borderWidth: max(1, Int((Double(width) / scale).rounded())))
    }
}

// ─── Walk ────────────────────────────────────────────────────────────────────

var nodes: [Node] = []
var nextId = 0
var culled = 0
var capped = false
let started = Date()

// Window frame, used both as the culling rect and as output metadata.
var windowBox: Box?
var cullRect: CGRect?

let windows = children(axApp).filter { el in
    let a = readAttributes(el)
    return (a[0] as? String) == "AXWindow"
}
let windowIndex = intOpt("--window", 0)
if let win = windows[safe: windowIndex] {
    let a = readAttributes(win)
    if let p = point(a[5]), let s = size(a[6]) {
        windowBox = [Double(p.x), Double(p.y), Double(s.width), Double(s.height)]
        if visibleOnly { cullRect = CGRect(origin: p, size: s) }
    }
}

var pixels: Pixels?
if let cp = colorsPath {
    guard let fs = opt("--frame") else { fail("--colors requires --frame x,y,w,h (the capture's screen rect)") }
    let f = fs.split(separator: ",").compactMap { Double($0) }
    guard f.count == 4 else { fail("--frame expects x,y,w,h") }
    pixels = Pixels(path: cp, frame: CGRect(x: f[0], y: f[1], width: f[2], height: f[3]))
    if pixels == nil { fail("cannot read image for --colors: \(cp)") }
}

func walk(_ el: AXUIElement, parent: Int?, depth: Int) {
    if depth > maxDepth { capped = true; return }
    if nodes.count >= maxElements { capped = true; return }

    let a = readAttributes(el)
    guard let role = a[0] as? String else { return }
    guard let p = point(a[5]), let s = size(a[6]), s.width > 0, s.height > 0 else {
        // No geometry of its own (menus before they open, transient containers) —
        // still descend, since children often do have frames.
        for c in children(el) { walk(c, parent: parent, depth: depth + 1) }
        return
    }

    let rect = CGRect(origin: p, size: s)
    if let cull = cullRect, !cull.intersects(rect) {
        culled += 1
        return
    }

    let id = nextId
    nextId += 1
    let box: Box = [Double(p.x), Double(p.y), Double(s.width), Double(s.height)]
    let style = pixels?.style(box)
    let isTextRole = role == "AXStaticText" || role == "AXTextField" || role == "AXTextArea"

    nodes.append(Node(
        id: id,
        parent: parent,
        depth: depth,
        role: String(role.dropFirst(2)),  // AXButton → Button
        subrole: (a[1] as? String).map { String($0.dropFirst(2)) },
        label: text(a[2]) ?? text(a[4]),
        value: text(a[3]),
        enabled: (a[7] as? Bool) == false ? false : nil,
        focused: (a[8] as? Bool) == true ? true : nil,
        box: box,
        style: style,
        text: (wantTypography && isTextRole) ? typography(el) : nil
    ))

    for c in children(el) { walk(c, parent: id, depth: depth + 1) }
}

if let win = windows[safe: windowIndex] {
    walk(win, parent: nil, depth: 0)
} else {
    walk(axApp, parent: nil, depth: 0)
}

/// Roles worth keeping even with no label — they are actionable or structural
/// landmarks a reader needs.
let keepRoles: Set<String> = [
    "Button", "Link", "CheckBox", "RadioButton", "TextField", "TextArea", "ComboBox",
    "PopUpButton", "MenuItem", "MenuButton", "Slider", "Stepper", "Tab", "Window",
    "Sheet", "Toolbar", "Image", "Table", "Outline",
]

if !detailFull {
    // Keep anything that carries meaning; re-parent survivors onto their nearest
    // surviving ancestor so the hierarchy stays walkable.
    var keep = Set<Int>()
    for n in nodes where n.label != nil || n.value != nil || keepRoles.contains(n.role) || n.parent == nil {
        keep.insert(n.id)
    }
    var parentOf: [Int: Int?] = [:]
    for n in nodes { parentOf[n.id] = n.parent }
    func nearestKept(_ id: Int?) -> Int? {
        var cur = id
        while let c = cur {
            if keep.contains(c) { return c }
            cur = parentOf[c] ?? nil
        }
        return nil
    }
    nodes = nodes.filter { keep.contains($0.id) }.map { n in
        Node(id: n.id, parent: nearestKept(n.parent), depth: n.depth, role: n.role,
             subrole: n.subrole, label: n.label, value: n.value, enabled: n.enabled,
             focused: n.focused, box: n.box, style: n.style, text: n.text)
    }
}

let result = TreeResult(
    app: app.localizedName ?? "",
    pid: Int(app.processIdentifier),
    window: windowBox,
    source: pixels == nil ? "ax" : "ax+px",
    budget: Budget(
        elements: nodes.count,
        capped: capped,
        maxElements: maxElements,
        maxDepth: maxDepth,
        elapsedMs: Int(Date().timeIntervalSince(started) * 1000),
        culled: culled
    ),
    nodes: nodes
)
print(encodeJSON(result))
