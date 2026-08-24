---
"macos-vision": minor
---

feat: `axTree()` — box model of a live application from the accessibility tree

Returns element boxes, hierarchy, roles and labels for a running app, with
optional colours sampled from a capture and typography from the AX attributed
string. Geometry is measured rather than inferred from OCR, so it is exact.

Shipped as a fourth prebuilt native helper (`ax-helper`) through the existing
pipeline, so nothing needs compiling on the user's machine.

Cost is bounded deliberately, because every attribute read is a synchronous IPC
round trip into the target app and that app's implementation — not tree size —
dominates: the same 4000 elements measured 1.6s in Safari and 11s in Finder.
Attribute reads are batched, offscreen subtrees are culled, `maxElements` and
`maxDepth` cap the walk, and `budget` reports what happened including
`capped: true` — a truncated tree is never presented as a complete one.

`detail: 'content'` (default) drops unlabelled structural containers and
re-parents their children, halving the payload on a Finder window (600 → 289
nodes). Boxes are encoded as `[x, y, w, h]` and default-valued fields are
omitted, for the same reason.

Also fixes `captureScreen()` silently accepting an invalid region: given a
negative or fully offscreen rect, `screencapture` clamps and returns a tiny
image with exit 0 on an unlocked Mac while failing elsewhere, so a caller's
mistake surfaced as corrupt output. The rect is now validated against the actual
display bounds before capture.
