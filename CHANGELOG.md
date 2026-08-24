# Changelog

## 1.8.2

### Patch Changes

- 1d5a994: fix: no invented colours for elements too small to sample

  A 1×1 pt element — the screen-reader anchors real pages are full of, "Skip to
  content" and the like — has no interior left once the edge inset is applied, so
  its "fill" was sampled from outside it and came back solid black. Seven such
  nodes in a 439-node Safari window all reported `bg: #000000`, which reads to a
  consumer as a black element that is not there.

  Colour sampling now requires a box with a real interior, and the inset can no
  longer exceed the box. Elements that are thin in one dimension only — a 5 pt
  scrollbar or split handle — keep their colours.

## 1.8.1

### Patch Changes

- 77422c3: fix: survive cycles in the accessibility tree, and enumerate windows from both sources

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

- 77422c3: fix(ci): build the Swift helpers from source instead of testing last release's binaries

  `postinstall` downloads prebuilt helpers for the package's current version. Once
  that version is published, CI on a branch that changes Swift finds those assets,
  downloads them, and runs the whole suite against the **previous** release —
  so native changes were never actually tested. It surfaced when two tests for
  freshly added helper behaviour failed on CI while passing locally: the runner was
  executing a binary that predated them.

  CI now sets `MACOS_VISION_SKIP_DOWNLOAD=1` and asserts every helper exists and is
  newer than its source, so a stale download cannot slip through unnoticed.

- 34d1a2b: fix: `axTree()` window and budget reporting say what actually happened

  Asking for `window: 1` on an app with one window silently fell through to the
  application element. That walks a larger, different tree and reports no window
  frame — a different answer to the question that was asked, easily mistaken for a
  real result. It now fails with how many windows the app actually exposes, and
  says so separately when an app exposes none at all (minimised or hidden).

  `budget` now also reports `walked` — the number of nodes visited before pruning,
  which is what `maxElements` caps. Without it, a result showing `elements: 315`,
  `maxElements: 400` and `capped: true` reads as a contradiction instead of
  "the walk hit the cap and pruning then removed 85".

## 1.8.0

### Minor Changes

- 50ee48d: feat: `uiSnapshot()` — the accessibility tree plus the text it misses

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

## 1.7.0

### Minor Changes

- 6d11ec0: feat: `axTree()` — box model of a live application from the accessibility tree

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

## 1.6.0

### Minor Changes

- 2b576bf: feat: ui-helper (windows / displays / permissions / captureScreen) and extended Vision API
  - New native `ui-helper` (third prebuilt binary): `listWindows`, `listDisplays`, `checkPermissions`, `captureScreen` (returns path + geometry + sha256, never bytes). `checkPermissions` also reports `screenLocked`; capture failures consult it so a locked Mac is diagnosed outright rather than guessed at.
  - OCR tuning: `languages`, `autoDetectLanguage`, `languageCorrection`, `customWords`, `fast`, `regionOfInterest`, `minTextHeight`; opt-in content-hash `cache`; `onProgress` for PDFs.
  - `recognizeDocument` (macOS 26+): native paragraphs, tables, lists, title, barcodes and detected data with positions.
  - `extractEntities` (links, e-mails, phones, addresses, dates), `detectTextRegions`, `compareImages`, `imageInfo`, `visionCapabilities`, `supportedOcrLanguages`.
  - People & scenes: `detectFaceLandmarks`, `detectHumans`, `detectBodyPose`, `detectHandPose`, `detectAnimals`, `detectAnimalPose`, `detectHorizon`, `detectSaliency`, `detectContours`, `imageAesthetics`, `detectLensSmudge`.
  - Pixel ops that return paths: `cropImage`, `cropDocument` (perspective-corrected), `extractForeground`, `personMask`.
  - Native helpers still target macOS 12. Modern features are gated twice — at compile time on the SDK (`-DSDK_14/15/26`, set automatically by the build scripts) and at runtime on `#available` — so the `swiftc` fallback also builds on older macOS, with unavailable features reported as `false` by `visionCapabilities()` and raising `UnsupportedOnThisMacOSError`. Release builds refuse to run on an SDK too old to compile in every gated feature.
  - Helper failures now surface their own message (`Cannot open file: …`) instead of Node's `Command failed: /path/to/vision-helper …`.
  - Opt-in OCR cache is keyed on helper and macOS version, so results never survive an upgrade that changes them.

## 1.5.0

### Minor Changes

- e2fb65a: Prebuilt native binaries: `vision-helper` and `pdf-helper` are now downloaded as
  prebuilt artifacts from the matching GitHub Release on install instead of being
  compiled from source. Xcode Command Line Tools are no longer required for the
  common path; they are still used as an offline fallback when the download
  cannot succeed (no network, custom registry, unpublished version, or
  `MACOS_VISION_SKIP_DOWNLOAD=1`).

  Both `arm64` and `x86_64` macOS are supported. Tarballs are SHA-256-verified
  against the matching `.sha256` file in the release.

  Also: release pipeline migrated from `release-it` to `@changesets/cli` +
  `changesets/action`, publishing to npm via OIDC Trusted Publishing with
  Sigstore provenance.

- e2fb65a: Add `startPage` and `maxPages` options to `rasterizePdf()` and `ocr()`, plus
  matching `--start-page` and `--max-pages` CLI flags. Lets callers process a
  page range instead of the whole PDF — useful for long documents where only
  the first few pages are needed (previews, classification, head-of-document
  extraction).

  User-facing input is 1-based; `PdfPage.page` / `VisionBlock.page` in the
  response remain 0-based to preserve backward compatibility.

## [1.2.0](https://github.com/woladi/macos-vision/compare/v1.1.0...v1.2.0) (2026-04-09)

### Features

- replace sips with PDFKit-based pdf-helper binary for PDF rasterization ([4a223e2](https://github.com/woladi/macos-vision/commit/4a223e2de79571794d866452fd5e87b84590ff0d))

## [1.1.0](https://github.com/woladi/macos-vision/compare/v1.0.3...v1.1.0) (2026-04-09)

### Features

- add PDF support via sips rasterization ([a48bf17](https://github.com/woladi/macos-vision/commit/a48bf17579a6df11aed6eadbde4fa5041ccaa981))

## [1.0.3](https://github.com/woladi/macos-vision/compare/v1.0.2...v1.0.3) (2026-04-08)

### Reverts

- remove socket.ignore field — worsens supply chain risk score ([a1827ad](https://github.com/woladi/macos-vision/commit/a1827ad489220ebb7a2e8c85632945fe969438db))

## [1.0.2](https://github.com/woladi/macos-vision/compare/v1.0.1...v1.0.2) (2026-04-08)

## [1.0.1](https://github.com/woladi/macos-vision/compare/v0.3.1...v1.0.1) (2026-04-08)

## [0.3.1](https://github.com/woladi/macos-vision/compare/v0.3.0...v0.3.1) (2026-04-08)

## [0.3.0](https://github.com/woladi/macos-vision/compare/v0.2.0...v0.3.0) (2026-04-08)

### Features

- add inferLayout() — unified reading-order LayoutBlock representation ([aec507e](https://github.com/woladi/macos-vision/commit/aec507eb7cf133ec1e56759c0945563a48d871ee))

## [0.2.0](https://github.com/woladi/macos-vision/compare/v0.1.4...v0.2.0) (2026-04-08)

### Features

- add confidence to VisionBlock and Barcode ([a87df27](https://github.com/woladi/macos-vision/commit/a87df275e51dec4b57fbff6e3bffc4220b96b4d7))

### Bug Fixes

- correct mkdirSync, CLI error on missing file, execFile timeout, README scope ([1cef2c7](https://github.com/woladi/macos-vision/commit/1cef2c7078430c9182fcd39792cf0c002833203f))
- replace try? with do/catch in Swift helper — surface Vision errors properly ([f287065](https://github.com/woladi/macos-vision/commit/f2870655225806070be3db462ea15923201fecbf))

## 0.1.4 (2026-04-08)
