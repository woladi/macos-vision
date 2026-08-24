# Box model of a live UI — design notes

Goal: hand an LLM a compact JSON description of what is on screen — element boxes, hierarchy,
colours, borders, typography — complete enough that the model can reconstruct the layout, review
it, or write assertions against it, **without ever seeing the screenshot**.

Status: **phases 1–3 implemented** as `axTree()` (see the README). Phase 4 — merging with OCR to populate `unresolved` — is still open. Every number below was measured on this machine
(Apple M1 Pro, 16 GB, macOS 26.5.2) with throwaway probes, not estimated.

---

## 1. What macOS actually gives us

| Source | Provides | Measured cost | Coverage |
| --- | --- | --- | --- |
| **AX tree** (`AXUIElement`) | role, exact frame, hierarchy, `value`/`title`, enabled/focused | 0.10 s (528 el.) · 1.57 s (4001 el., Safari) · 11.34 s (4001 el., Finder) — batched | Finder **100%** of elements carry geometry; Electron 99%; Safari 99% |
| **AX attributed string** (`AXAttributedStringForRange`) | **real font family / name / size**, alignment, colours when explicitly set; `AXBoundsForRange` gives the pixel rect of any substring | per text element | text elements only |
| **Pixel sampling** of a capture | background / border / accent colours, corner radius, shadows | **90 ms decode once, then 0.009 ms per element** | anything visible |
| **Vision OCR** | text where AX is blind | ~1.04 s per window | canvas, WebGL, games, images, static mockups |
| **Vision contours / rectangles** | visual boxes with no AX counterpart | ~0.1–0.3 s | universal |

### Two findings worth stating plainly

**AX coverage is far better than assumed.** `docs/`-era notes elsewhere in this project guessed
that Electron apps expose little. They do not: the Claude desktop app returns 530 elements across
25 levels, and Safari exposes the full web content tree (`Link×227`, `CheckBox×400`, `Cell×1614`).
Geometry from AX is ground truth — not inferred from OCR bounding boxes.

**There is no styling in AX, with exactly one exception.** Enumerating every attribute name across
Finder, Safari, the Claude app and Messages returned no colour, border, background or font
attribute. But the *parameterised* attribute `AXAttributedStringForRange` does carry typography:

```
AXFont = { AXFontFamily = Menlo; AXFontName = "Menlo-Regular"; AXFontSize = 11 }
AXATextAlignmentValue = 0
```

So font family, PostScript name, size and alignment are available as fact for text elements —
no need to estimate point size from OCR box height. Colours appear here only when the app set
them explicitly; the general case still needs pixels.

---

## 2. The bottleneck is AX, not pixels

Colours are effectively free. Walking the tree is not, because **every attribute read is a
synchronous IPC round trip into the target application**:

| Application | one attribute per call | `AXUIElementCopyMultipleAttributeValues` |
| --- | --- | --- |
| Claude (Electron), 528 el. | 0.19 s | **0.10 s** |
| Safari, 4001 el. | 2.27 s | **1.57 s** |
| Finder, 4001 el. | 26.07 s | **11.34 s** |

Same element count, 7× spread between Safari and Finder: cost is a property of the target app's
accessibility implementation, not of tree size. A naive full walk is therefore not viable.

**Required mitigations, in order of payoff:**

1. **Batch attribute reads** — `AXUIElementCopyMultipleAttributeValues` for the fixed set
   (role, position, size, title, value, enabled). Free 1.4–2.3×.
2. **Cull by viewport** — skip subtrees whose frame does not intersect the window's visible rect.
   This is what saves Finder-style list views.
3. **Budget explicitly** — cap element count and depth, and report the cap in the output rather
   than truncating silently. A snapshot that quietly dropped half the tree is worse than one that
   says so.
4. **Set a messaging timeout** — `AXUIElementSetMessagingTimeout`; an unresponsive app must
   degrade to "AX unavailable, fall back to Vision", never hang the tool.

---

## 3. Proposed output shape

```jsonc
{
  "window": { "app": "MyApp", "frame": [0, 29, 1496, 867], "scale": 2, "theme": "dark" },
  "budget": { "elements": 412, "capped": false, "axMs": 190, "pixelMs": 94 },
  "nodes": [
    {
      "id": 12,
      "role": "button",
      "label": "Zapisz",
      "box": { "x": 812, "y": 540, "w": 96, "h": 32 },          // AX — ground truth
      "style": {                                                 // pixels — inferred
        "bg": "#2F6FEB",
        "fg": "#FFFFFF",
        "border": { "color": "#1B4FC4", "width": 1 },
        "radius": 6
      },
      "text": { "font": "SFPro-Semibold", "size": 13, "align": "center" }, // AX attributed
      "parent": 7,
      "z": 3,
      "enabled": true,
      "source": "ax+px"
    }
  ],
  "unresolved": [
    { "box": [40, 120, 300, 18], "text": "Nie udało się połączyć", "source": "ocr" }
  ]
}
```

`box` comes from AX, `style` from pixels, `text` from the AX attributed string, and `unresolved`
holds regions OCR can see that have no AX counterpart. That last array is not a leftover — it is
itself an accessibility finding, and the natural place to raise an `a11yMissing` flag.

Every field carries `source` so a consumer can tell measurement from inference.

---

## 4. Where this belongs

**In this package (`macos-vision`), not in `macos-vision-mcp`.**

The decisive reason is mechanical: reading the AX tree requires a compiled Swift helper, and this
package owns the native-helper pipeline — cross-compiled per arch, published as GitHub Release
assets, sha256-verified, with a `swiftc` fallback. `ui-helper` was moved here for exactly that
reason; shipping a second binary from the MCP server would repeat the problem that move fixed.

There is precedent for the split, too. `inferLayout` — the logic that assembles text blocks into
reading order — lives here, while the MCP server only shapes the result into a tool response
(`buildPageAnalysis`). The same division applies:

- **`macos-vision`** — `ax-helper` (tree walk, batched and culled), pixel probes, and the
  `boxModel()` composer that merges AX + pixels + Vision. Available to any consumer, including
  `macos-vision-md` and the CLI.
- **`macos-vision-mcp`** — one tool (`ui_snapshot`), its description, detail levels, and token
  budgeting. Stays a thin adapter.

**Naming tension, stated honestly:** the accessibility tree is not Vision, and this package is
drifting into "on-device macOS perception" generally — `ui-helper` already sits here and is not
Vision either. A separate `macos-ui` package would be cleaner by name and worse by cost: a second
release pipeline and a second version to keep in step, for a single consumer. Revisit only if a
second consumer appears.

---

## 5. Non-goals and honest limits

- **This is not the CSS box model.** CSS has four nested boxes; AX has one. Border thickness can
  be measured by an edge scan and padding inferred from the gap between an element's frame and its
  text bounds, but both are estimates. Do not name fields `padding`/`margin` as if they were
  measured; keep inferred values behind a flag or a clearly named field.
- **Gradients, shadows and translucency** are approximations from pixels.
- **Occluded elements** have trustworthy geometry from AX but untrustworthy colours — pixels show
  whatever is on top. Mark them rather than reporting a wrong colour.
- **Finder-class applications will be slow.** Without culling, seconds. Measure before promising.
- **A locked screen yields nothing useful** — window and region capture fail outright and a
  full-screen capture returns only the lock screen. `checkPermissions().screenLocked` already
  reports this; the box-model entry point should refuse early with that reason.

### Web pages are a solved problem elsewhere

For anything running in Chrome, the DevTools protocol already returns the real thing:
`DOM.getBoxModel` gives content / padding / border / margin quads and
`CSS.getComputedStyleForNode` gives exact colours and border widths. That is strictly better than
anything reconstructed from pixels. This work should target native apps, Electron, canvas/WebGL,
games and static mockups — and the README should say so, so nobody reaches for the weaker tool on
a web page.

---

## 6. What implementation actually cost

Built as `ax-helper` + `src/ax.ts`. Findings that only appeared once it ran:

- **The naive JSON was more expensive than the screenshot it replaces.** A
  250-node Safari tree came to ~12.8k tokens against ~6.9k for the image.
  Encoding `box` as `[x, y, w, h]` instead of a keyed object, and omitting
  `enabled: true` / `focused: false`, cut that by 44%. Pruning unlabelled
  containers (`detail: 'content'`) took another 48% — 600 → 289 nodes on Finder.
  Net: ~25 tokens per node instead of ~51.
- **A full tree still is not a token win over a screenshot** — a pruned Finder
  window is ~7.3k tokens against ~6.9k for the image. The case for it is
  capability (exact boxes, roles, enabled state, hierarchy) and the ability to
  take a slice, not raw token count. The README says so rather than implying a
  saving that does not exist.
- **Swift omits `nil` rather than encoding `null`**, so the root node has no
  `parent` key at all. The TypeScript type said `number | null`; a consumer
  checking `=== null` would have been wrong. Caught by a test, fixed in the type.
- **`AXAttributedStringForRange` is app-dependent.** TextEdit returns
  `Menlo-Regular` 11 pt; Safari's web `StaticText` returns alignment but no font.
  That is a limit of the source, not of the reader.

## 7. Suggested order of work

1. **`ax-helper` with tree walk only** — role, frame, hierarchy, label, enabled. Batched reads,
   viewport culling, explicit budget, messaging timeout. This alone is ~80% of the value, because
   exact geometry plus roles is what OCR cannot give.
2. **Colour sampling** over the capture that has already been taken — adds `style` for ~90 ms
   total.
3. **Typography** via `AXAttributedStringForRange`, plus `AXBoundsForRange` for precise text rects.
4. **Merge with OCR** — populate `unresolved`, flag `a11yMissing` where visible text has no AX node.

Each step is independently useful and independently shippable.

---

## Appendix — how the numbers above were obtained

Throwaway Swift probes, run against live applications:

- Tree walk and attribute survey: recursive `AXUIElementCopyAttributeValue`, capped at 4000
  elements and depth 25, counting elements with a resolvable `AXPosition`/`AXSize` pair and
  collecting the union of all attribute names to check for styling.
- Batching comparison: the same walk fetching the five needed attributes individually versus one
  `AXUIElementCopyMultipleAttributeValues` call per element.
- Pixel cost: decode a 2992×1734 PNG into an RGBA buffer once, then take a coarse 16×16-bin
  histogram over a sampled grid for 500 rectangles.

Reproduce before trusting: these are single-machine numbers and AX performance varies by
application and by macOS release.
