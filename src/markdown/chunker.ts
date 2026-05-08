import type { ParagraphGroup } from './prompt.js';
import { buildPrompt } from './prompt.js';

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Split an array of paragraphs into chunks where each chunk's estimated prompt
 * token count stays within `chunkSizeTokens`. Paragraph boundaries are never
 * split — chunks always break between `ParagraphGroup` objects.
 *
 * A paragraph whose estimated token count exceeds the budget on its own is
 * emitted as a singleton chunk with a warning.
 */
export function chunkParagraphs(
  paragraphs: ParagraphGroup[],
  chunkSizeTokens: number,
): ParagraphGroup[][] {
  const result: ParagraphGroup[][] = [];
  let currentBatch: ParagraphGroup[] = [];

  for (const p of paragraphs) {
    const candidate = [...currentBatch, p];
    const tokens = estimateTokens(buildPrompt(candidate));

    if (currentBatch.length === 0) {
      if (tokens > chunkSizeTokens) {
        console.warn(
          `[macos-vision] Paragraph ${p.paragraphId} (page ${p.page}) ` +
            `exceeds chunk budget (~${tokens} est. tokens > ${chunkSizeTokens}). ` +
            `Processing as standalone chunk.`,
        );
      }
      currentBatch = [p];
    } else if (tokens <= chunkSizeTokens) {
      currentBatch = candidate;
    } else {
      result.push(currentBatch);
      currentBatch = [p];
    }
  }

  if (currentBatch.length > 0) {
    result.push(currentBatch);
  }

  return result;
}
