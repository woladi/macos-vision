---
"macos-vision": patch
---

fix: `axTree()` window and budget reporting say what actually happened

Asking for `window: 1` on an app with one window silently fell through to the
application element. That walks a larger, different tree and reports no window
frame — a different answer to the question that was asked, easily mistaken for a
real result. It now fails with how many windows the app actually exposes, and
says so separately when an app exposes none at all (minimised or hidden).

`budget` now also reports `walked` — the number of nodes visited before pruning,
which is what `maxElements` caps. Without it, a result showing `elements: 315`,
`maxElements: 400` and `capped: true` reads as a contradiction instead of
"the walk hit the cap and pruning then removed 85".
