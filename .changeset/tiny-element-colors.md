---
"macos-vision": patch
---

fix: no invented colours for elements too small to sample

A 1×1 pt element — the screen-reader anchors real pages are full of, "Skip to
content" and the like — has no interior left once the edge inset is applied, so
its "fill" was sampled from outside it and came back solid black. Seven such
nodes in a 439-node Safari window all reported `bg: #000000`, which reads to a
consumer as a black element that is not there.

Colour sampling now requires a box with a real interior, and the inset can no
longer exceed the box. Elements that are thin in one dimension only — a 5 pt
scrollbar or split handle — keep their colours.
