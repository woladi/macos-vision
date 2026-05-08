import { ocr, inferLayout, sortBlocksByReadingOrder } from '../index.js';
import type { VisionBlock } from '../index.js';
import { ping, chat } from './ollama.js';
import { groupByParagraph, buildUserContent, SYSTEM_PROMPT } from './prompt.js';
import { chunkParagraphs } from './chunker.js';
import type { ParagraphGroup } from './prompt.js';

export { OllamaUnavailableError } from './ollama.js';
export type { ParagraphGroup } from './prompt.js';

export interface VisionScribeOptions {
  /**
   * Ollama model name.
   * @default 'mistral-nemo'
   */
  model?: string;
  /**
   * Base URL of the Ollama server.
   * @default 'http://localhost:11434'
   */
  ollamaUrl?: string;
  /**
   * Skip the Ollama reachability check before each call.
   * Useful in batch/eval contexts where you ping once upfront.
   * @default false
   */
  skipPing?: boolean;
  /**
   * Maximum estimated output tokens per LLM chunk.
   * Paragraphs are batched so that no single generate() call is expected
   * to produce more than this many tokens. Lower values mean more (faster)
   * chunks; higher values risk hitting the model's output token limit.
   * @default 1800
   */
  chunkSizeTokens?: number;
}

/**
 * Group raw OCR blocks by their page index.
 * macos-vision attaches a `page` field (0-based) to blocks from PDFs.
 * Single-image blocks have no `page` field and land in page 0.
 *
 * Coordinates in VisionBlock are always page-local (0–1), so blocks from
 * different pages must NOT be passed together to inferLayout().
 */
function groupBlocksByPage(blocks: VisionBlock[]): Map<number, VisionBlock[]> {
  const pages = new Map<number, VisionBlock[]>();
  for (const block of blocks) {
    const page = (block as VisionBlock & { page?: number }).page ?? 0;
    const existing = pages.get(page) ?? [];
    existing.push(block);
    pages.set(page, existing);
  }
  return pages;
}

/**
 * Converts an image or PDF to structured Markdown using a two-stage pipeline:
 *
 * 1. **Apple Vision OCR** — extracts raw text blocks with bounding-box coordinates.
 *    PDFs are automatically rasterized page-by-page.
 * 2. **Layout inference** — groups blocks by `paragraphId` per page using spatial
 *    heuristics (each page processed independently to avoid coordinate mixing).
 * 3. **Chunking** — paragraphs are batched to stay within the LLM output token budget.
 * 4. **Local LLM (Ollama)** — formats each chunk into clean Markdown without
 *    hallucinating new content.
 *
 * @example
 * ```ts
 * const scribe = new VisionScribe({ model: 'mistral-nemo' });
 * const markdown = await scribe.toMarkdown('invoice.png');
 * const mdFromPdf = await scribe.toMarkdown('report.pdf');
 * ```
 */
export class VisionScribe {
  private readonly model: string;
  private readonly ollamaUrl: string;
  private readonly skipPing: boolean;
  private readonly chunkSizeTokens: number;

  constructor(options: VisionScribeOptions = {}) {
    this.model = options.model ?? 'mistral-nemo';
    this.ollamaUrl = options.ollamaUrl ?? 'http://localhost:11434';
    this.skipPing = options.skipPing ?? false;
    this.chunkSizeTokens = options.chunkSizeTokens ?? 1800;
  }

  /**
   * Convert an image or PDF file to Markdown.
   *
   * @param imagePath Absolute or relative path to the image or PDF.
   * @returns Markdown string. Empty string if no text was detected.
   * @throws {OllamaUnavailableError} If the Ollama server cannot be reached.
   */
  async toMarkdown(imagePath: string): Promise<string> {
    // 1. Ensure Ollama is reachable before doing expensive OCR work.
    if (!this.skipPing) await ping(this.ollamaUrl);

    // 2. Extract raw OCR blocks via Apple Vision.
    //    For PDFs, macos-vision rasterizes each page and adds a `page` field.
    const rawBlocks = await ocr(imagePath, { format: 'blocks' });

    // 3. Split blocks by page — inferLayout() requires page-local coordinates.
    const pageMap = groupBlocksByPage(rawBlocks);

    // 4. Per page: infer layout → sort → group into paragraphs.
    const allParagraphs: ParagraphGroup[] = [];
    for (const [pageIndex, pageBlocks] of [...pageMap.entries()].sort(([a], [b]) => a - b)) {
      const layoutBlocks = inferLayout({ textBlocks: pageBlocks });
      const sorted = sortBlocksByReadingOrder(layoutBlocks);
      const paragraphs = groupByParagraph(sorted, pageIndex);
      allParagraphs.push(...paragraphs);
    }

    if (allParagraphs.length === 0) {
      return '';
    }

    // 5. Split paragraphs into chunks that fit within the output token budget.
    const chunks = chunkParagraphs(allParagraphs, this.chunkSizeTokens);

    // 6. Send each chunk to the LLM sequentially and join the results.
    //    System prompt goes as role:"system", OCR text as role:"user" — this
    //    prevents the model from treating instructions as content to summarise.
    const parts: string[] = [];
    for (const chunk of chunks) {
      const part = await chat(
        { baseUrl: this.ollamaUrl, model: this.model },
        SYSTEM_PROMPT,
        buildUserContent(chunk),
      );
      parts.push(part);
    }

    return parts.join('\n\n');
  }
}
