---
"macos-vision": patch
---

fix: survive cycles in the accessibility tree, and enumerate windows from both sources

The AX tree is a graph, not a tree. Safari was observed listing the application
element as its own child and answering `kAXWindows` with it. Without cycle
protection the walk descends into the application repeatedly and returns menu
bars at the depth limit instead of the window's contents — which is what
produced an occasional two-node result. Visited elements are now tracked by
`CFHash`/`CFEqual` and never revisited.

Windows are taken from the union of `kAXWindows` and the application element's
children, filtered to real windows and never the application element itself,
because apps differ in which of the two they populate.

The `axTree` tests no longer assume a particular app has a window. They probe
until they find an app the accessibility API actually answers for and skip when
none does: `CGWindowList` still lists windows on a locked Mac while AX exposes
none, and a CI runner has neither — so the previous fixed target passed locally
and failed there.
