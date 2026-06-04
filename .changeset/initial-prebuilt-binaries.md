---
"macos-vision": minor
---

Prebuilt native binaries: `vision-helper` and `pdf-helper` are now downloaded as
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
