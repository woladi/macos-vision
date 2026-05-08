#!/usr/bin/env tsx
/**
 * Prompt optimizer — reads the latest failure report and asks Claude to
 * suggest concrete improvements to the system prompt in src/markdown/prompt.ts.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... npm run optimize-prompts
 *
 * Requires ANTHROPIC_API_KEY to be set.
 */

import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { EvalResult } from './eval.js';

const ROOT = new URL('..', import.meta.url).pathname;
const REPORTS_DIR  = path.join(ROOT, 'eval/reports');
const PREDICTIONS_DIR = path.join(ROOT, 'eval/predictions');
const BENCH_GT     = path.join(ROOT, 'eval/bench/ground-truth/markdown');
const PROMPT_FILE  = path.join(ROOT, 'src/markdown/prompt.ts');

async function latestReport(): Promise<EvalResult[]> {
  if (!existsSync(REPORTS_DIR)) {
    console.error('No reports directory. Run `npm run eval` first.');
    process.exit(1);
  }
  const files = (await readdir(REPORTS_DIR))
    .filter(f => f.startsWith('report-') && f.endsWith('.json'))
    .sort();
  if (files.length === 0) {
    console.error('No report files found. Run `npm run eval` first.');
    process.exit(1);
  }
  const raw = await readFile(path.join(REPORTS_DIR, files[files.length - 1]), 'utf8');
  return JSON.parse(raw) as EvalResult[];
}

async function run(): Promise<void> {
  if (!process.env['ANTHROPIC_API_KEY']) {
    console.error('ANTHROPIC_API_KEY is not set. This command requires Claude.');
    console.error('Usage: ANTHROPIC_API_KEY=sk-... npm run optimize-prompts');
    process.exit(1);
  }

  const results = await latestReport();
  const failures = results.filter(r => !r.passed && !r.error);

  if (failures.length === 0) {
    console.log('No failures in the latest report — prompts look great!');
    return;
  }

  console.log(`\nAnalysing ${failures.length} failure(s)...\n`);

  // Load current system prompt source
  const promptSource = await readFile(PROMPT_FILE, 'utf8');

  // Build failure examples (cap at 5 to stay within token limits)
  const examples: string[] = [];
  for (const failure of failures.slice(0, 5)) {
    const stem = path.basename(failure.file, '.pdf');
    const predPath = path.join(PREDICTIONS_DIR, `${stem}.md`);
    const gtPath   = path.join(BENCH_GT, `${stem}.md`);

    if (!existsSync(predPath) || !existsSync(gtPath)) continue;

    const prediction  = await readFile(predPath, 'utf8');
    const groundTruth = await readFile(gtPath, 'utf8');

    examples.push(
      `### File: ${failure.file}  (LLM score: ${failure.llmScore}/10)\n` +
      `Judge's reason: ${failure.llmReason}\n\n` +
      `**Ground Truth (first 800 chars):**\n${groundTruth.slice(0, 800)}\n\n` +
      `**Prediction (first 800 chars):**\n${prediction.slice(0, 800)}`,
    );
  }

  if (examples.length === 0) {
    console.error('Could not load prediction/ground-truth files for failures.');
    process.exit(1);
  }

  const metaPrompt = `You are an expert in prompt engineering for OCR-to-Markdown pipelines.

Below is the current system prompt used inside \`src/markdown/prompt.ts\` (the \`buildPrompt\` function):

\`\`\`typescript
${promptSource}
\`\`\`

The following conversions scored below 8/10 in our evaluation:

${examples.join('\n\n---\n\n')}

Analyse the failure patterns and provide:
1. A diagnosis of why the current prompt is causing these failures.
2. Three to five concrete, actionable changes to the system instruction string in \`buildPrompt()\`.
   Show the exact replacement text for each change.
3. A revised version of the full instruction string ready to drop into the code.

Be precise and technical. Focus on the instruction wording, not the TypeScript code structure.`;

  const client = new Anthropic();
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    messages: [{ role: 'user', content: metaPrompt }],
  });

  const suggestions = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  console.log('═'.repeat(60));
  console.log('  Prompt Improvement Suggestions');
  console.log('═'.repeat(60));
  console.log(suggestions);
  console.log('═'.repeat(60));
  console.log('\nApply the suggested changes to src/markdown/prompt.ts, then re-run `npm run eval`.\n');
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
