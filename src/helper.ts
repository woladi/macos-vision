// Shared plumbing for the native helpers (vision-helper, pdf-helper, ui-helper).
//
// Wire contract: a helper writes exactly one payload to stdout (the Swift side
// diverts framework noise to stderr), exits 1 on failure and 2 when a feature is
// not available on this macOS.

import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { mkdirSync } from 'fs';
import { readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const BIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../bin');

export const VISION_BIN = join(BIN_DIR, 'vision-helper');
export const PDF_BIN = join(BIN_DIR, 'pdf-helper');
export const UI_BIN = join(BIN_DIR, 'ui-helper');

/** Helper exit status meaning "not supported on this macOS". */
export const EXIT_UNSUPPORTED = 2;

export class UnsupportedOnThisMacOSError extends Error {
  constructor(feature: string, minVersion: string) {
    super(`${feature} requires macOS ${minVersion} or newer`);
    this.name = 'UnsupportedOnThisMacOSError';
  }
}

/**
 * Helpers report failures as `ERROR: <what went wrong>` on stderr. Surface that
 * line instead of Node's `Command failed: /long/path/to/helper --flags …`,
 * keeping `code` so callers can still recognise the "unsupported" status.
 */
function helperError(err: unknown, stderr: string): Error {
  const raw = err as { message?: string; code?: number };
  const reported = stderr
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('ERROR: '));
  const error = new Error(
    reported ? reported.slice('ERROR: '.length) : (raw.message ?? String(err))
  ) as Error & { code?: number; stderr?: string };
  if (raw.code !== undefined) error.code = raw.code;
  // Kept for callers that inspect a non-helper tool's output (e.g. screencapture).
  error.stderr = stderr;
  return error;
}

export interface ExecOptions {
  timeout?: number;
  /** Written to the helper's stdin, then closed. */
  input?: string;
}

/** Spawn a helper and return its stdout. */
export function execHelper(bin: string, args: string[], opts: ExecOptions = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      bin,
      args,
      { timeout: opts.timeout ?? 30_000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => (err ? reject(helperError(err, stderr)) : resolvePromise(stdout))
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

/** Spawn a helper and parse its JSON payload. */
export async function runHelper<T>(
  bin: string,
  args: string[],
  opts: ExecOptions = {}
): Promise<T> {
  return JSON.parse(await execHelper(bin, args, opts)) as T;
}

/** Like `runHelper`, but translates the "unsupported" exit status into a typed error. */
export async function runGated<T>(
  bin: string,
  args: string[],
  feature: string,
  minVersion: string,
  opts: ExecOptions = {}
): Promise<T> {
  try {
    return await runHelper<T>(bin, args, opts);
  } catch (err) {
    if ((err as { code?: number }).code === EXIT_UNSUPPORTED) {
      throw new UnsupportedOnThisMacOSError(feature, minVersion);
    }
    throw err;
  }
}

/** `override` resolved, or a fresh path in `$TMPDIR/macos-vision/`. */
export function tmpOutPath(prefix: string, override?: string, ext = 'png'): string {
  if (override) return resolve(override);
  const dir = join(tmpdir(), 'macos-vision');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.${ext}`);
}

export function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** SHA-256 of a file's bytes, hex. */
export async function fileSha256(filePath: string): Promise<string> {
  return sha256(await readFile(filePath));
}
