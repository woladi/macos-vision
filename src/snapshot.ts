// Merging the accessibility tree with what OCR can see.
//
// The two disagree in a way that is itself informative: text Vision reads but
// AX has no node for is, almost always, text the app failed to expose to
// assistive technology. Canvas, WebGL, custom-drawn controls and images with
// baked-in labels all land here — so `unresolved` is both a completeness fix
// for the box model and an accessibility finding.
//
// Pure functions only: no capture, no OCR, no helper spawning. The composition
// that calls these lives in index.ts, where `ocr` is defined.

import type { AxNode, AxTree, AxBox } from './ax.js';
import type { ScreenFrame } from './ui.js';
import type { VisionBlock } from './index.js';

/** Text Vision read that no accessibility node accounts for. */
export interface UnresolvedText {
  text: string;
  /** `[x, y, w, h]` in global screen points, converted from the image. */
  box: AxBox;
  confidence: number;
  /**
   * An AX node covers this area but exposes no matching text — the control is
   * there, its label is not. Distinct from no node at all, which usually means
   * custom drawing.
   */
  coveredByNode?: number;
}

export interface SnapshotSummary {
  nodes: number;
  /** Nodes carrying a label or value. */
  labelled: number;
  ocrBlocks: number;
  /** OCR text with no matching AX node — the accessibility gap. */
  unresolved: number;
  /**
   * Share of visible text the tree accounts for, 0–1 — and `null` when the walk
   * was capped, because then it measures how much of the tree we looked at
   * rather than how accessible the app is. Measured on one Safari window: 0.34
   * at `maxElements: 200` against 0.83 for the complete walk. Reporting the
   * former as a coverage figure would accuse the app of a fault that is ours.
   */
  axTextCoverage: number | null;
  /** True when `unresolved` is inflated because the walk did not finish. */
  cappedWalk?: boolean;
}

export interface UiSnapshot extends AxTree {
  unresolved: UnresolvedText[];
  summary: SnapshotSummary;
}

/**
 * Same normalization the matching layer uses: fold case, whitespace and unicode
 * punctuation. The character classes use \u escapes deliberately — written as
 * literal characters, a formatter can rewrite an invisible one and silently turn
 * the whitespace class into the range U+0020-U+200B, which swallows all of ASCII.
 */
export function normalize(s: string): string {
  return s
    .normalize('NFC')
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Normalized 0–1 image coordinates → global screen points. */
export function blockToScreenBox(block: VisionBlock, frame: ScreenFrame): AxBox {
  return [
    Math.round(frame.x + block.x * frame.w),
    Math.round(frame.y + block.y * frame.h),
    Math.round(block.width * frame.w),
    Math.round(block.height * frame.h),
  ];
}

function centre(b: AxBox): [number, number] {
  return [b[0] + b[2] / 2, b[1] + b[3] / 2];
}

function contains(outer: AxBox, point: [number, number]): boolean {
  return (
    point[0] >= outer[0] &&
    point[0] <= outer[0] + outer[2] &&
    point[1] >= outer[1] &&
    point[1] <= outer[1] + outer[3]
  );
}

/** Text a node offers for matching: its label and value together. */
function nodeText(n: AxNode): string {
  return normalize([n.label, n.value].filter(Boolean).join(' '));
}

/**
 * Decides which OCR text the accessibility tree already accounts for.
 *
 * A block counts as accounted for when some node's box contains its centre and
 * that node's label or value contains the text (or vice versa — AX labels are
 * often longer than the visible run, and OCR often splits a label across lines).
 * Everything else is reported as unresolved, with `coveredByNode` set when a node
 * covers the area but says nothing matching, since "unlabelled control" and
 * "custom-drawn text" are different problems.
 */
export function mergeOcrWithTree(
  tree: AxTree,
  blocks: VisionBlock[],
  frame: ScreenFrame,
  minConfidence = 0.3
): { unresolved: UnresolvedText[]; summary: SnapshotSummary } {
  const texts = tree.nodes.map((n) => ({ node: n, text: nodeText(n) }));
  const unresolved: UnresolvedText[] = [];
  let considered = 0;

  for (const block of blocks) {
    if (block.confidence < minConfidence) continue;
    const t = normalize(block.text);
    if (!t) continue;
    considered++;

    const box = blockToScreenBox(block, frame);
    const c = centre(box);

    let covering: AxNode | undefined;
    let matched = false;
    for (const { node, text } of texts) {
      if (!contains(node.box, c)) continue;
      // Smallest covering node wins as the "should have said this" candidate.
      if (!covering || node.box[2] * node.box[3] < covering.box[2] * covering.box[3]) {
        covering = node;
      }
      if (text && (text.includes(t) || t.includes(text))) {
        matched = true;
        break;
      }
    }
    if (matched) continue;

    unresolved.push({
      text: block.text,
      box,
      confidence: block.confidence,
      ...(covering ? { coveredByNode: covering.id } : {}),
    });
  }

  const labelled = tree.nodes.filter((n) => n.label || n.value).length;
  const capped = tree.budget.capped;
  return {
    unresolved,
    summary: {
      nodes: tree.nodes.length,
      labelled,
      ocrBlocks: considered,
      unresolved: unresolved.length,
      axTextCoverage: capped
        ? null
        : considered === 0
          ? 1
          : Math.round((1 - unresolved.length / considered) * 100) / 100,
      ...(capped ? { cappedWalk: true } : {}),
    },
  };
}
