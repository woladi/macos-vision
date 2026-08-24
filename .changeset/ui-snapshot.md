---
"macos-vision": minor
---

feat: `uiSnapshot()` — the accessibility tree plus the text it misses

Captures a window once, walks its accessibility tree, runs OCR over the same
region, and reports every piece of visible text that no node accounts for.

`unresolved` does double duty. It completes the box model for anything
custom-drawn — canvas, WebGL, games, images with text baked in — where AX is
blind. And each entry is an accessibility gap in the app under test:
`coveredByNode` present means a control is there but unlabelled, absent means
nothing is exposed at all.

`summary.axTextCoverage` is `null` whenever the walk was capped, with
`cappedWalk: true` alongside. A capped walk measures how much of the tree was
visited rather than how accessible the app is — measured on one Safari window the
figure reads 0.34 at `maxElements: 200` against 0.83 for the complete walk, and
reporting the former as coverage would blame the app for our own budget.

The capture is pinned to exactly the window being walked rather than letting the
capture and the tree each resolve a target independently, so colours and OCR
always describe the same region as the geometry.
