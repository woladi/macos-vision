import Anthropic from '@anthropic-ai/sdk';
import { chat } from '../src/markdown/ollama.js';

// ---------------------------------------------------------------------------
// Character Error Rate (CER)
// ---------------------------------------------------------------------------

/**
 * Compute the Levenshtein distance between two strings using standard DP.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  // Use two-row rolling array to keep memory O(n)
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1];
      } else {
        curr[j] = 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
      }
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}

/**
 * Character Error Rate = Levenshtein(pred, gt) / len(gt), clamped to [0, 1].
 * Returns 0 when both strings are empty.
 */
export function computeCER(prediction: string, groundTruth: string): number {
  if (groundTruth.length === 0) return prediction.length === 0 ? 0 : 1;
  const dist = levenshtein(prediction, groundTruth);
  return Math.min(1, dist / groundTruth.length);
}

// ---------------------------------------------------------------------------
// LLM-as-a-Judge
// ---------------------------------------------------------------------------

export interface JudgeOptions {
  /** Ollama model name (used when ANTHROPIC_API_KEY is not set). Default: 'mistral-nemo' */
  ollamaModel?: string;
  /** Ollama server URL. Default: 'http://localhost:11434' */
  ollamaUrl?: string;
  /** Claude model to use when ANTHROPIC_API_KEY is present. Default: 'claude-haiku-4-5-20251001' */
  claudeModel?: string;
}

export interface JudgeResult {
  score: number;   // 1–10
  reason: string;
}

const JUDGE_SYSTEM = `You are an expert evaluator of OCR-to-Markdown conversion quality.
You will be given a Ground Truth Markdown document and a Prediction produced by an automated system.
Score the prediction from 1 to 10 based on three criteria:
  1. Text accuracy   — are all words present and correct?
  2. Structure       — are headings, lists, and tables correctly identified and formatted?
  3. Completeness    — is all content from the ground truth captured?

Respond with ONLY valid JSON in this exact format (no markdown, no commentary):
{"score": <integer 1-10>, "reason": "<one sentence explanation>"}`;

function buildJudgePrompt(prediction: string, groundTruth: string): string {
  return (
    `Ground Truth:\n<ground-truth>\n${groundTruth}\n</ground-truth>\n\n` +
    `Prediction:\n<prediction>\n${prediction}\n</prediction>`
  );
}

/** Extract score from a JSON response, with a regex fallback. */
function parseJudgeResponse(raw: string): JudgeResult {
  // Strip markdown code fences if present
  const cleaned = raw.replace(/```(?:json)?\n?/g, '').trim();
  try {
    const parsed = JSON.parse(cleaned) as { score: unknown; reason: unknown };
    const score = Number(parsed.score);
    if (score >= 1 && score <= 10) {
      return { score, reason: String(parsed.reason ?? '') };
    }
  } catch {
    // fall through to regex
  }
  // Regex fallback: extract first number 1–10 in the text
  const match = /\b([1-9]|10)\b/.exec(raw);
  return {
    score: match ? parseInt(match[1], 10) : 5,
    reason: raw.trim().slice(0, 200),
  };
}

/**
 * Score a prediction against the ground truth using an LLM judge.
 * Uses Claude if `ANTHROPIC_API_KEY` is set in the environment, otherwise Ollama.
 */
export async function llmJudge(
  prediction: string,
  groundTruth: string,
  options: JudgeOptions = {},
): Promise<JudgeResult> {
  const prompt = buildJudgePrompt(prediction, groundTruth);

  if (process.env['ANTHROPIC_API_KEY']) {
    return judgeWithClaude(prompt, options.claudeModel ?? 'claude-haiku-4-5-20251001');
  }

  return judgeWithOllama(
    prompt,
    options.ollamaModel ?? 'mistral-nemo',
    options.ollamaUrl ?? 'http://localhost:11434',
  );
}

async function judgeWithClaude(prompt: string, model: string): Promise<JudgeResult> {
  const client = new Anthropic();
  const message = await client.messages.create({
    model,
    max_tokens: 256,
    system: JUDGE_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = message.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
  return parseJudgeResponse(text);
}

async function judgeWithOllama(
  prompt: string,
  model: string,
  ollamaUrl: string,
): Promise<JudgeResult> {
  const raw = await chat({ baseUrl: ollamaUrl, model }, JUDGE_SYSTEM, prompt);
  return parseJudgeResponse(raw);
}
