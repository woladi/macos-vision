---
"macos-vision": minor
---

feat: ui-helper (windows / displays / permissions / captureScreen) and extended Vision API

- New native `ui-helper` (third prebuilt binary): `listWindows`, `listDisplays`, `checkPermissions`, `captureScreen` (returns path + geometry + sha256, never bytes).
- OCR tuning: `languages`, `autoDetectLanguage`, `languageCorrection`, `customWords`, `fast`, `regionOfInterest`, `minTextHeight`; opt-in content-hash `cache`; `onProgress` for PDFs.
- `recognizeDocument` (macOS 26+): native paragraphs, tables, lists, title, barcodes and detected data with positions.
- `extractEntities` (links, e-mails, phones, addresses, dates), `detectTextRegions`, `compareImages`, `imageInfo`, `visionCapabilities`, `supportedOcrLanguages`.
- People & scenes: `detectFaceLandmarks`, `detectHumans`, `detectBodyPose`, `detectHandPose`, `detectAnimals`, `detectAnimalPose`, `detectHorizon`, `detectSaliency`, `detectContours`, `imageAesthetics`, `detectLensSmudge`.
- Pixel ops that return paths: `cropImage`, `cropDocument` (perspective-corrected), `extractForeground`, `personMask`.
- Native helpers now target macOS 13 (newer features gate on `#available`). Node >= 20.
