---
"macos-vision": patch
---

fix(ci): build the Swift helpers from source instead of testing last release's binaries

`postinstall` downloads prebuilt helpers for the package's current version. Once
that version is published, CI on a branch that changes Swift finds those assets,
downloads them, and runs the whole suite against the **previous** release —
so native changes were never actually tested. It surfaced when two tests for
freshly added helper behaviour failed on CI while passing locally: the runner was
executing a binary that predated them.

CI now sets `MACOS_VISION_SKIP_DOWNLOAD=1` and asserts every helper exists and is
newer than its source, so a stale download cannot slip through unnoticed.
