// Accessibility tree of a running application, shaped as a box model.
//
// Geometry and semantics come from the AX API — measured, not inferred from OCR.
// Colours are sampled from a capture you supply; typography comes from the AX
// attributed string where the app exposes it. See docs/BOX-MODEL.md for what is
// fact and what is estimate.

import { AX_BIN, runHelper } from './helper.js';
import type { ScreenFrame } from './ui.js';

/**
 * `[x, y, w, h]` in global screen points, top-left origin — the space click
 * drivers use. An array rather than a keyed object: the same four numbers cost
 * roughly 4x fewer tokens when repeated across a whole tree.
 */
export type AxBox = [x: number, y: number, w: number, h: number];

export interface AxStyle {
  /** Dominant fill colour of the element's interior, as #RRGGBB. */
  bg?: string;
  /** Outline colour, present only when it differs from the fill. */
  border?: string;
  /** **Inferred** by walking inward from the edge — an estimate, not a measured value. */
  borderWidth?: number;
}

export interface AxTypography {
  /** PostScript name, e.g. `Menlo-Regular` */
  font?: string;
  family?: string;
  size?: number;
  align?: 'natural' | 'left' | 'right' | 'center' | 'justified';
}

export interface AxNode {
  id: number;
  /** Absent on the root of the walk; otherwise the id of the nearest kept ancestor. */
  parent?: number;
  depth: number;
  /** AX role without the `AX` prefix: `Button`, `StaticText`, `WebArea`… */
  role: string;
  subrole?: string;
  /** Title, falling back to the accessibility description. */
  label?: string;
  value?: string;
  /** Present only when `false` — enabled is the overwhelming default. */
  enabled?: boolean;
  /** Present only when `true`. */
  focused?: boolean;
  box: AxBox;
  style?: AxStyle;
  text?: AxTypography;
}

export interface AxBudget {
  /** Nodes returned, after pruning. */
  elements: number;
  /**
   * Nodes the walk visited before pruning — what `maxElements` actually caps.
   * Without it, `elements` below `maxElements` next to `capped: true` reads as a
   * contradiction rather than as "pruning removed some of what we walked".
   */
  walked: number;
  /** True when the walk stopped at `maxElements`/`maxDepth` — the tree is incomplete. */
  capped: boolean;
  maxElements: number;
  maxDepth: number;
  elapsedMs: number;
  /** Elements skipped because they fell outside the window's visible rect. */
  culled: number;
}

export interface AxTree {
  app: string;
  pid: number;
  /** Frame of the window that was walked. */
  window?: AxBox;
  /** `ax` when geometry only, `ax+px` once colours were sampled. */
  source: 'ax' | 'ax+px';
  budget: AxBudget;
  nodes: AxNode[];
}

export interface AxTreeOptions {
  /** Application name — exact, else case-insensitive prefix. */
  app?: string;
  pid?: number;
  /** Which window of the app, in front-to-back order. Default 0 (frontmost). */
  window?: number;
  /**
   * `content` (default) drops unlabelled structural containers and re-parents
   * their children — boxes are absolute, so the nesting adds little for a reader
   * and roughly halves the payload. `full` returns the raw tree.
   */
  detail?: 'content' | 'full';
  /** Stop after this many elements. Default 1500. */
  maxElements?: number;
  /** Default 40. */
  maxDepth?: number;
  /** Keep elements whose frame falls outside the window. Default false. */
  includeOffscreen?: boolean;
  /**
   * Sample colours from this PNG. Pass the `path` and `frame` of a `captureScreen()`
   * result taken of the same window, close in time.
   */
  colors?: { path: string; frame: ScreenFrame };
  /** Read font and alignment for text elements. One extra IPC round trip each. */
  typography?: boolean;
}

/**
 * Walks the accessibility tree of a running application and returns its box model.
 *
 * Cost is dominated by the target app's AX responsiveness, not by tree size — the
 * same 4000 elements measured 1.6s in Safari and 11s in Finder. Attribute reads are
 * batched and offscreen subtrees are culled; `budget` reports what that cost and
 * whether the result was truncated, so a capped tree is never mistaken for a
 * complete one.
 *
 * Requires Accessibility permission for the host process; throws otherwise.
 */
export async function axTree(options: AxTreeOptions = {}): Promise<AxTree> {
  const args: string[] = [];
  if (options.pid !== undefined) args.push('--pid', String(options.pid));
  else if (options.app) args.push('--app', options.app);
  else throw new Error('axTree requires app or pid');

  if (options.window !== undefined) args.push('--window', String(options.window));
  if (options.detail) args.push('--detail', options.detail);
  if (options.maxElements !== undefined) args.push('--max-elements', String(options.maxElements));
  if (options.maxDepth !== undefined) args.push('--max-depth', String(options.maxDepth));
  if (options.includeOffscreen) args.push('--include-offscreen');
  if (options.typography) args.push('--typography');
  if (options.colors) {
    const f = options.colors.frame;
    args.push('--colors', options.colors.path, '--frame', `${f.x},${f.y},${f.w},${f.h}`);
  }
  // Walking a slow application can legitimately take many seconds.
  return runHelper<AxTree>(AX_BIN, args, { timeout: 60_000 });
}
