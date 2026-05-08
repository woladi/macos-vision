import type { LayoutBlock } from '../index.js';

/**
 * A single paragraph: all TextBlocks sharing the same paragraphId,
 * in reading order (top-to-bottom, left-to-right within each line).
 */
export interface ParagraphGroup {
  paragraphId: number;
  /** Average y-coordinate of the first line — used as a spatial hint. */
  y: number;
  lines: string[];
  /** Zero-based page index (always 0 for single images). */
  page: number;
}

/**
 * Group sorted layout blocks by paragraphId into ParagraphGroup objects.
 * Non-text blocks (faces, barcodes, etc.) are ignored.
 */
export function groupByParagraph(blocks: LayoutBlock[], pageIndex = 0): ParagraphGroup[] {
  const map = new Map<number, { y: number; lines: Map<number, string[]> }>();

  for (const block of blocks) {
    if (block.kind !== 'text') continue;

    if (!map.has(block.paragraphId)) {
      map.set(block.paragraphId, { y: block.y, lines: new Map() });
    }
    const para = map.get(block.paragraphId)!;

    const existing = para.lines.get(block.lineId) ?? [];
    existing.push(block.text);
    para.lines.set(block.lineId, existing);
  }

  const groups: ParagraphGroup[] = [];
  for (const [paragraphId, { y, lines }] of map) {
    // Join tokens within each line, then collect lines in order
    const lineStrings = [...lines.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, tokens]) => tokens.join(' '));

    groups.push({ paragraphId, y, lines: lineStrings, page: pageIndex });
  }

  return groups;
}

/**
 * The system prompt sent as `role: "system"` in every chat request.
 * Kept separate from user content so the model treats it as hard constraints,
 * not as text to be summarised or analysed.
 */
export const SYSTEM_PROMPT = `ACT AS A HIGH-FIDELITY DOCUMENT PARSER. \
Your only goal is to reconstruct the provided OCR data into a structured \
Markdown document. NEVER skip text. NEVER summarize. \
Content must be 100% identical to the source.

DO NOT SUMMARIZE.
Transcribe every single word from the provided OCR data.
Maintain 1:1 content fidelity. If the source has 5 paragraphs, the output must have 5 paragraphs.

STRICT OUTPUT: Output ONLY the Markdown representation. \
No preamble, no "Summary of key events", no "Here is the result".

FORMATTING RULES:
- Add # / ## / ### before lines that are clearly headings or titles
- Add - before items that are clearly list entries
- Join lines within the same paragraph into flowing prose
- Preserve blank lines between paragraphs
- Do NOT wrap output in code fences`;

/**
 * Build the user-facing content block from a list of paragraphs.
 * This is the OCR text that the model will format — no instructions included.
 * Sent as `role: "user"` in the chat request.
 */
export function buildUserContent(paragraphs: ParagraphGroup[]): string {
  const pageNumbers = [...new Set(paragraphs.map(p => p.page))].sort((a, b) => a - b);
  const multiPage = pageNumbers.length > 1;

  const blocks: string[] = [];

  for (const pageNum of pageNumbers) {
    if (multiPage) {
      blocks.push(`[Page ${pageNum + 1}]`);
    }

    const pageParagraphs = paragraphs.filter(p => p.page === pageNum);
    for (const { paragraphId, y, lines } of pageParagraphs) {
      const yHint = y.toFixed(2);
      const header = `[Paragraph ${paragraphId}, y≈${yHint}]`;
      blocks.push(`${header}\n${lines.join('\n')}`);
    }
  }

  const task =
    'Convert the OCR source below into Markdown. ' +
    'Reproduce EVERY word EXACTLY. Do not respond, explain, or ask questions.\n\n' +
    '<ocr_source>';

  return `${task}\n\n${blocks.join('\n\n')}\n</ocr_source>`;
}

/**
 * Build the combined string used for token estimation in the chunker.
 * Mirrors what will be sent to the model (system + user content).
 */
export function buildPrompt(paragraphs: ParagraphGroup[]): string {
  return `${SYSTEM_PROMPT}\n\n${buildUserContent(paragraphs)}`;
}
