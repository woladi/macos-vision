import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN_PATH = resolve(__dirname, '../bin/vision-helper');

export interface VisionBlock {
  /** Recognized text */
  text: string;
  /** Horizontal position, 0–1 from left */
  x: number;
  /** Vertical position, 0–1 from top */
  y: number;
  /** Width, 0–1 relative to image */
  width: number;
  /** Height, 0–1 relative to image */
  height: number;
}

export interface OcrOptions {
  /** Return plain text (default) or structured blocks with coordinates */
  format?: 'text' | 'blocks';
}

export async function ocr(imagePath: string, options?: { format?: 'text' }): Promise<string>;
export async function ocr(imagePath: string, options: { format: 'blocks' }): Promise<VisionBlock[]>;
export async function ocr(
  imagePath: string,
  options: OcrOptions = {}
): Promise<string | VisionBlock[]> {
  const absPath = resolve(imagePath);
  const { format = 'text' } = options;

  if (format === 'blocks') {
    const { stdout } = await execFileAsync(BIN_PATH, ['--json', absPath]);
    const raw: Array<{ t: string; x: number; y: number; w: number; h: number }> =
      JSON.parse(stdout);
    return raw.map((b) => ({
      text: b.t,
      x: b.x,
      y: b.y,
      width: b.w,
      height: b.h,
    }));
  }

  const { stdout } = await execFileAsync(BIN_PATH, [absPath]);
  return stdout.trim();
}
