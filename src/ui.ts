// UI layer: screen capture + window/display/permission introspection.
//
// Privacy invariant: no function in this module ever returns image bytes.
// Captures land on disk; only paths, geometry, and metadata flow back.
// The library never synthesizes input — eyes, not hands.

import { readFile } from 'fs/promises';
import { UI_BIN, runHelper, execHelper, tmpOutPath, sha256 } from './helper.js';

const UI_HELPER_TIMEOUT_MS = 15_000;
const SCREENCAPTURE_TIMEOUT_MS = 15_000;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WindowInfo {
  /** CGWindowID — stable for the window's lifetime */
  windowId: number;
  /** Owning application name, e.g. 'Safari' */
  app: string;
  pid: number;
  /** Window title (may be empty) */
  title: string;
  /** Global screen points, top-left origin (CGEvent click space) */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0 = normal app window; menu bar / dock / overlays only with `listWindows(true)` */
  layer: number;
  isOnScreen: boolean;
}

export interface DisplayInfo {
  displayId: number;
  isMain: boolean;
  /** Global screen points, top-left origin */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Backing scale factor (2 on Retina) */
  scale: number;
}

export interface PermissionsInfo {
  screenRecording: boolean;
  accessibility: boolean;
  /** True while the login session is locked — no capture is useful until unlocked. */
  screenLocked: boolean;
}

/** Rectangle in global screen points, top-left origin (CGEvent click space). */
export interface ScreenFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CaptureResult {
  /** Absolute path to the PNG on disk */
  path: string;
  /** Pixel dimensions of the PNG. */
  pixelWidth: number;
  pixelHeight: number;
  /** Screen region the image covers, in global screen points (top-left origin). */
  frame: ScreenFrame;
  /** pixelWidth / frame.w — ≈2 on Retina */
  scale: number;
  /** SHA-256 of the PNG bytes — pin assertions to a specific capture, detect replaced files */
  sha256: string;
  /** ISO timestamp */
  capturedAt: string;
  /** Human-readable description of what was captured */
  target: string;
}

export interface CaptureOptions {
  windowId?: number;
  /** App name (exact or case-insensitive prefix) — its frontmost window wins. */
  app?: string;
  /** Region in global screen points, top-left origin. */
  rect?: ScreenFrame;
  displayId?: number;
  /** Where to write the PNG. Default: `$TMPDIR/macos-vision/capture-<ts>.png` */
  outPath?: string;
}

// ─── ui-helper ───────────────────────────────────────────────────────────────

const runUi = <T>(...args: string[]) =>
  runHelper<T>(UI_BIN, args, { timeout: UI_HELPER_TIMEOUT_MS });

/** On-screen windows, front-to-back. Pass `true` to include menu bar, dock and overlays. */
export function listWindows(includeAll = false): Promise<WindowInfo[]> {
  return runUi<WindowInfo[]>('--windows', ...(includeAll ? ['--all'] : []));
}

/** Online displays (including asleep ones) with bounds and backing scale. */
export function listDisplays(): Promise<DisplayInfo[]> {
  return runUi<DisplayInfo[]>('--displays');
}

/** Screen Recording / Accessibility status for the current host process. */
export function checkPermissions(): Promise<PermissionsInfo> {
  return runUi<PermissionsInfo>('--permissions');
}

// ─── Capture ─────────────────────────────────────────────────────────────────

/** Width/height straight from the PNG IHDR header (bytes 16–23). */
function pngPixelSize(png: Buffer): { w: number; h: number } {
  return { w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
}

async function resolveWindow(opts: CaptureOptions): Promise<WindowInfo> {
  const windows = await listWindows();
  if (opts.windowId != null) {
    const win = windows.find((w) => w.windowId === opts.windowId);
    if (!win) throw new Error(`Window ${opts.windowId} not found (use listWindows())`);
    return win;
  }
  if (opts.app) {
    const q = opts.app.toLowerCase();
    // CGWindowList is front-to-back — first match is the frontmost window of that app.
    // App-name matching only: title search would silently capture the wrong app.
    const win = windows.find((w) => w.app.toLowerCase() === q || w.app.toLowerCase().startsWith(q));
    if (!win) {
      const apps = [...new Set(windows.map((w) => w.app))].join(', ');
      throw new Error(`No on-screen window matches app "${opts.app}". Visible apps: ${apps}`);
    }
    return win;
  }
  throw new Error('window target requires windowId or app');
}

// Screen Recording can only change for this process via an app restart, so one
// successful preflight is valid for the process lifetime.
let screenRecordingOk = false;

/**
 * Captures a window (`windowId` / `app`), a region (`rect`) or a display
 * (`displayId`, default: main) to a PNG via `/usr/sbin/screencapture`.
 * Returns the file path and geometry — never the image bytes.
 */
export async function captureScreen(opts: CaptureOptions = {}): Promise<CaptureResult> {
  if (!screenRecordingOk) {
    const perms = await checkPermissions();
    if (!perms.screenRecording) {
      throw new Error(
        'Screen Recording permission missing. Grant it to the host application ' +
          '(Terminal / Claude Desktop / Cursor) in System Settings → Privacy & Security → Screen Recording, then restart it.'
      );
    }
    screenRecordingOk = true;
  }

  const out = tmpOutPath('capture', opts.outPath);
  const args = ['-x', '-t', 'png'];
  let frame: ScreenFrame;
  let targetDesc: string;

  if (opts.windowId != null || opts.app) {
    const win = await resolveWindow(opts);
    args.push('-o', '-l', String(win.windowId)); // -o: no window shadow
    frame = { x: win.x, y: win.y, w: win.w, h: win.h };
    targetDesc = `window ${win.windowId} (${win.app}${win.title ? `: ${win.title}` : ''})`;
  } else if (opts.rect) {
    const { x, y, w, h } = opts.rect;
    args.push(`-R${x},${y},${w},${h}`);
    frame = { x, y, w, h };
    targetDesc = `region ${x},${y} ${w}×${h}`;
  } else {
    const displays = await listDisplays();
    const display =
      opts.displayId != null
        ? displays.find((d) => d.displayId === opts.displayId)
        : (displays.find((d) => d.isMain) ?? displays[0]);
    if (!display) throw new Error(`Display ${opts.displayId} not found`);
    const idx = displays.indexOf(display) + 1; // screencapture -D is 1-based ordinal
    args.push('-D', String(idx));
    frame = { x: display.x, y: display.y, w: display.w, h: display.h };
    targetDesc = `display ${display.displayId}`;
  }

  args.push(out);
  try {
    await execHelper('/usr/sbin/screencapture', args, { timeout: SCREENCAPTURE_TIMEOUT_MS });
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    // Ask the system rather than guessing: on a locked Mac window and region
    // capture fail outright and a full-screen capture returns only the lock
    // screen, so retrying cannot succeed until someone unlocks.
    const locked = await checkPermissions()
      .then((p) => p.screenLocked)
      .catch(() => false);
    throw new Error(
      locked
        ? `screencapture failed for ${targetDesc}: the screen is locked. ` +
            'Window and region capture do not work on a locked Mac, and a full-screen ' +
            'capture would only show the lock screen. Ask the user to unlock, then retry — ' +
            'retrying while locked cannot succeed.'
        : `screencapture failed for ${targetDesc}${stderr ? ` (${stderr})` : ''}. ` +
            'The window may have closed, or the display may be asleep.'
    );
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(out);
  } catch {
    throw new Error(`screencapture produced no file for ${targetDesc} — is the window on screen?`);
  }
  const px = pngPixelSize(bytes);
  return {
    path: out,
    pixelWidth: px.w,
    pixelHeight: px.h,
    sha256: sha256(bytes),
    frame,
    scale: frame.w > 0 ? px.w / frame.w : 1,
    capturedAt: new Date().toISOString(),
    target: targetDesc,
  };
}
