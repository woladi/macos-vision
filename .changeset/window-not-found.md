---
"macos-vision": patch
---

fix: `axTree()` fails on an out-of-range window index instead of walking the whole app

Asking for `window: 1` on an app with one window silently fell through to the
application element. That walks a larger, different tree and reports no window
frame — a different answer to the question that was asked, easily mistaken for a
real result. It now fails with how many windows the app actually exposes, and
says so separately when an app exposes none at all (minimised or hidden).
