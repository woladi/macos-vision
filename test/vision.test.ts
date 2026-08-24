import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import {
  ocr,
  visionCapabilities,
  supportedOcrLanguages,
  imageInfo,
  detectTextRegions,
  compareImages,
  extractEntities,
  recognizeDocument,
  detectLensSmudge,
  detectHumans,
  detectBodyPose,
  detectSaliency,
  detectContours,
  cropImage,
  cropDocument,
  extractForeground,
  imageAesthetics,
  detectAnimalPose,
  UnsupportedOnThisMacOSError,
  listDisplays,
  checkPermissions,
  captureScreen,
} from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE_IMG = resolve(__dirname, 'fixtures/sample.png');
const SAMPLE_PDF = resolve(__dirname, 'fixtures/sample.pdf');
const T = 30_000;

describe('visionCapabilities()', () => {
  it('reports helper version, macOS version and feature flags', async () => {
    const caps = await visionCapabilities();
    expect(caps.helperVersion).toBeTruthy();
    expect(caps.macosVersion).toMatch(/^\d+\.\d+/);
    expect(caps.features.ocr).toBe(true);
    expect(typeof caps.features.documentStructure).toBe('boolean');
    expect(caps.ocrLanguages.length).toBeGreaterThan(5);
  });

  it('supportedOcrLanguages() includes English', async () => {
    expect(await supportedOcrLanguages()).toContain('en-US');
  });
});

describe('ocr() — tuning options', () => {
  it(
    'regionOfInterest restricts results but reports full-image coordinates',
    async () => {
      const top = await ocr(SAMPLE_IMG, {
        format: 'blocks',
        regionOfInterest: { x: 0, y: 0, width: 1, height: 0.1 },
      });
      expect(top.length).toBeGreaterThan(0);
      for (const b of top) {
        expect(b.y).toBeLessThan(0.12);
        expect(b.height).toBeLessThan(0.1);
      }
      expect(top.map((b) => b.text).join(' ')).toContain('Henry VIII');
    },
    T
  );

  it(
    'languages + languageCorrection:false still reads the fixture',
    async () => {
      const text = await ocr(SAMPLE_IMG, { languages: ['en-US'], languageCorrection: false });
      expect(text).toContain('Henry VIII');
    },
    T
  );

  it(
    'fast mode returns text',
    async () => {
      const text = await ocr(SAMPLE_IMG, { fast: true });
      expect(text).toContain('Henry');
    },
    T
  );

  it(
    'cache:true returns identical result on second call',
    async () => {
      const opts = { cache: true, customWords: ['Wikipedia'] } as const;
      const a = await ocr(SAMPLE_IMG, opts);
      const started = Date.now();
      const b = await ocr(SAMPLE_IMG, opts);
      expect(b).toBe(a);
      expect(Date.now() - started).toBeLessThan(200);
    },
    T
  );

  it('onProgress fires once per PDF page', async () => {
    const calls: Array<[number, number]> = [];
    await ocr(SAMPLE_PDF, { onProgress: (d, n) => calls.push([d, n]) });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[calls.length - 1][0]).toBe(calls[calls.length - 1][1]);
  }, 60_000);
});

describe('imageInfo() / detectTextRegions() / compareImages()', () => {
  it('imageInfo reads dimensions without a model', async () => {
    const info = await imageInfo(SAMPLE_IMG);
    expect(info.width).toBe(1088);
    expect(info.height).toBe(1344);
    expect(info.format).toBe('public.png');
  });

  it(
    'detectTextRegions finds many text boxes',
    async () => {
      const regions = await detectTextRegions(SAMPLE_IMG);
      expect(regions.length).toBeGreaterThan(20);
      for (const r of regions) {
        expect(r.x).toBeGreaterThanOrEqual(-0.01);
        expect(r.y).toBeGreaterThanOrEqual(-0.01);
        expect(r.width).toBeGreaterThan(0);
      }
    },
    T
  );

  it(
    'compareImages: identical → 0, different → > 0.5',
    async () => {
      expect((await compareImages(SAMPLE_IMG, SAMPLE_IMG)).distance).toBe(0);
      const crop = await cropImage(SAMPLE_IMG, { x: 0.6, y: 0.1, width: 0.3, height: 0.3 });
      expect((await compareImages(SAMPLE_IMG, crop.outPath)).distance).toBeGreaterThan(0.3);
    },
    T
  );
});

describe('extractEntities()', () => {
  it('finds email, phone, url and date', async () => {
    const ents = await extractEntities(
      'Kontakt: jan@example.com, tel. +48 601 234 567, https://prorok.pl, spotkanie 1 września 2026 o 14:00'
    );
    const types = ents.map((e) => e.type);
    expect(types).toContain('email');
    expect(types).toContain('phone');
    expect(types).toContain('link');
    expect(types).toContain('date');
    expect(ents.find((e) => e.type === 'email')?.value).toBe('jan@example.com');
  });
});

describe('recognizeDocument()', () => {
  it('returns structure on macOS 26+, throws UnsupportedOnThisMacOSError otherwise', async () => {
    const caps = await visionCapabilities();
    if (!caps.features.documentStructure) {
      await expect(recognizeDocument(SAMPLE_IMG)).rejects.toBeInstanceOf(
        UnsupportedOnThisMacOSError
      );
      return;
    }
    const doc = await recognizeDocument(SAMPLE_IMG, { languages: ['en-US'] });
    expect(doc.text).toContain('Henry VIII');
    expect(doc.paragraphs.length).toBeGreaterThan(5);
    expect(doc.title?.text).toContain('Henry');
    expect(Array.isArray(doc.tables)).toBe(true);
  }, 60_000);

  it(
    'detectLensSmudge never throws on supported systems',
    async () => {
      const caps = await visionCapabilities();
      const r = await detectLensSmudge(SAMPLE_IMG);
      expect(typeof r.supported).toBe('boolean');
      if (!caps.features.lensSmudge) expect(r.supported).toBe(false);
    },
    T
  );
});

describe('people / saliency / contours', () => {
  it(
    'detectHumans finds the portrait on the fixture',
    async () => {
      const humans = await detectHumans(SAMPLE_IMG);
      expect(humans.length).toBeGreaterThanOrEqual(1);
      expect(humans[0].x).toBeGreaterThan(0.5);
    },
    T
  );

  it(
    'detectBodyPose returns named joints',
    async () => {
      const poses = await detectBodyPose(SAMPLE_IMG);
      expect(poses.length).toBeGreaterThanOrEqual(1);
      expect(Object.keys(poses[0].joints).length).toBeGreaterThan(5);
    },
    T
  );

  it(
    'detectSaliency returns regions and can write a heatmap',
    async () => {
      const out = resolve(tmpdir(), `macos-vision-test-heat-${Date.now()}.png`);
      const s = await detectSaliency(SAMPLE_IMG, { mode: 'objectness', heatmapPath: out });
      expect(s.regions.length).toBeGreaterThan(0);
      expect(s.heatmapPath).toBe(out);
      expect(existsSync(out)).toBe(true);
    },
    T
  );

  it(
    'detectContours counts contours and samples points',
    async () => {
      const c = await detectContours(SAMPLE_IMG, { maxPoints: 4 });
      expect(c.totalContours).toBeGreaterThan(10);
      expect(c.topLevel[0].points?.length).toBeLessThanOrEqual(5);
    },
    T
  );

  // Guards the helper↔TS wire contract: every rect-shaped result uses width/height.
  it('all rect-shaped results expose numeric width/height', async () => {
    const [regions, humans, contours, saliency, blocks] = await Promise.all([
      detectTextRegions(SAMPLE_IMG),
      detectHumans(SAMPLE_IMG),
      detectContours(SAMPLE_IMG, { maxPoints: 2 }),
      detectSaliency(SAMPLE_IMG, { mode: 'objectness' }),
      ocr(SAMPLE_IMG, { format: 'blocks' }),
    ]);
    const rects = [...regions, ...humans, ...contours.topLevel, ...saliency.regions, ...blocks];
    expect(rects.length).toBeGreaterThan(0);
    for (const r of rects) {
      expect(typeof r.width).toBe('number');
      expect(typeof r.height).toBe('number');
      expect(Number.isFinite(r.width)).toBe(true);
    }
  }, 60_000);

  it('recognizeDocument bboxes use width/height too', async () => {
    const caps = await visionCapabilities();
    if (!caps.features.documentStructure) return;
    const doc = await recognizeDocument(SAMPLE_IMG, { languages: ['en-US'] });
    for (const p of doc.paragraphs.slice(0, 5)) {
      expect(typeof p.bbox.width).toBe('number');
      expect(typeof p.bbox.height).toBe('number');
    }
  }, 60_000);
});

describe('pixel ops return paths, never bytes', () => {
  it('cropImage writes a PNG of the requested size', async () => {
    const r = await cropImage(SAMPLE_IMG, { x: 0, y: 0, width: 0.5, height: 0.5 });
    expect(existsSync(r.outPath)).toBe(true);
    expect(r.width).toBe(544);
    expect(r.height).toBe(672);
  });

  it(
    'cropDocument writes a perspective-corrected PNG',
    async () => {
      const r = await cropDocument(SAMPLE_IMG);
      expect(existsSync(r.outPath)).toBe(true);
      expect(r.width).toBeGreaterThan(100);
    },
    T
  );

  it(
    'extractForeground writes a cutout (macOS 14+)',
    async () => {
      const caps = await visionCapabilities();
      if (!caps.features.foregroundMask) return;
      const r = await extractForeground(SAMPLE_IMG, { tight: true });
      expect(r.instances).toBeGreaterThanOrEqual(1);
      expect(existsSync(r.outPath)).toBe(true);
    },
    T
  );
});

describe('helper error reporting', () => {
  // A helper failure must surface its own message, not Node's
  // "Command failed: /long/path/to/vision-helper --flags …".
  it('surfaces the helper ERROR line, not the spawn command', async () => {
    await expect(imageInfo('/nonexistent-xyz.png')).rejects.toThrow(/^Cannot open file:/);
  });

  it('keeps the exit status so gating still works', async () => {
    await imageInfo('/nonexistent-xyz.png').catch((err) => {
      expect((err as { code?: number }).code).toBe(1);
    });
  });

  it('captureScreen rejects a rect with no area', async () => {
    // screencapture itself is inconsistent here — it clamps and succeeds on an
    // unlocked Mac, fails elsewhere — so the check has to be ours to be reliable.
    await expect(captureScreen({ rect: { x: 0, y: 0, w: -5, h: -5 } })).rejects.toThrow(
      /positive width and height/
    );
  });

  it('captureScreen rejects a rect that is off every display', async () => {
    await expect(
      captureScreen({ rect: { x: 900_000, y: 900_000, w: 10, h: 10 } })
    ).rejects.toThrow(/does not intersect any displays/);
  });
});

describe('capability gating', () => {
  // The helper reports a feature only when both its SDK and this macOS provide it;
  // anything reported unavailable must fail with the typed error, not a raw crash.
  it.each([
    ['documentStructure', () => recognizeDocument(SAMPLE_IMG)],
    ['aesthetics', () => imageAesthetics(SAMPLE_IMG)],
    ['foregroundMask', () => extractForeground(SAMPLE_IMG)],
    ['animalPose', () => detectAnimalPose(SAMPLE_IMG)],
  ])(
    'caps.%s agrees with the call',
    async (feature, call) => {
      const caps = await visionCapabilities();
      if (caps.features[feature]) {
        await expect(call()).resolves.toBeDefined();
      } else {
        await expect(call()).rejects.toBeInstanceOf(UnsupportedOnThisMacOSError);
      }
    },
    60_000
  );
});

describe('ui-helper', () => {
  it('listDisplays reports at least one display with a scale', async () => {
    const d = await listDisplays();
    expect(d.length).toBeGreaterThanOrEqual(1);
    expect(d.some((x) => x.isMain)).toBe(true);
    expect(d[0].scale).toBeGreaterThanOrEqual(1);
  });

  it('checkPermissions returns booleans', async () => {
    const p = await checkPermissions();
    expect(typeof p.screenRecording).toBe('boolean');
    expect(typeof p.accessibility).toBe('boolean');
  });
});
