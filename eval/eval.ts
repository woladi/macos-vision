#!/usr/bin/env tsx
/**
 * Evaluation runner for the macos-vision Markdown pipeline.
 *
 * Usage:
 *   npm run eval                        # run all files
 *   npm run eval -- --limit 20          # run first 20 files only
 *   npm run eval -- --resume            # skip files already in predictions/
 *   ANTHROPIC_API_KEY=sk-... npm run eval
 *
 * Prerequisites:
 *   - npm run eval:setup   (clone the benchmark dataset)
 *   - Ollama running       (unless using Claude as judge)
 */

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { VisionScribe } from '../src/markdown/index.js';
import { ping } from '../src/markdown/ollama.js';
import { computeCER, llmJudge } from './metrics.js';

const ROOT = new URL('..', import.meta.url).pathname;
const BENCH_PDFS    = path.join(ROOT, 'eval/bench/pdfs');
const BENCH_GT      = path.join(ROOT, 'eval/bench/ground-truth/markdown');
const PREDICTIONS_DIR = path.join(ROOT, 'eval/predictions');
const REPORTS_DIR   = path.join(ROOT, 'eval/reports');
const OLLAMA_URL    = process.env['OLLAMA_URL'] ?? 'http://localhost:11434';

export interface EvalResult {
  file: string;
  cer: number;        // 0–1, lower is better
  llmScore: number;   // 1–10, higher is better
  llmReason: string;
  passed: boolean;    // llmScore >= 8
  error?: string;
}

function parseArgs(): { limit?: number; resume: boolean } {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1] ?? '', 10) : undefined;
  const resume = args.includes('--resume');
  return { limit: isNaN(limit!) ? undefined : limit, resume };
}

async function run(): Promise<void> {
  const { limit, resume } = parseArgs();

  if (!existsSync(BENCH_PDFS)) {
    console.error('✗ Benchmark not found. Run `npm run eval:setup` first.');
    process.exit(1);
  }

  await mkdir(PREDICTIONS_DIR, { recursive: true });
  await mkdir(REPORTS_DIR, { recursive: true });

  let pdfFiles = (await readdir(BENCH_PDFS))
    .filter(f => f.endsWith('.pdf'))
    .sort();

  if (limit) pdfFiles = pdfFiles.slice(0, limit);

  if (pdfFiles.length === 0) {
    console.error('✗ No PDF files found in eval/bench/pdfs/');
    process.exit(1);
  }

  // Resume: skip files that already have a prediction written
  const toProcess = resume
    ? pdfFiles.filter(f => {
        const stem = path.basename(f, '.pdf');
        return !existsSync(path.join(PREDICTIONS_DIR, `${stem}.md`));
      })
    : pdfFiles;

  const skipped = pdfFiles.length - toProcess.length;

  console.log(`\nEvaluating ${toProcess.length} file(s)${limit ? ` (limit: ${limit})` : ''}${resume && skipped ? ` — skipping ${skipped} already predicted` : ''}...\n`);

  if (toProcess.length === 0) {
    console.log('All files already predicted. Run without --resume to re-evaluate.\n');
    process.exit(0);
  }

  // Ping Ollama once before the loop — VisionScribe always needs it for formatting.
  try {
    await ping(OLLAMA_URL);
  } catch {
    console.error(`✗ Ollama not reachable at ${OLLAMA_URL}. Make sure it's running.`);
    process.exit(1);
  }

  // skipPing=true: we already verified Ollama above — no need to re-check per file
  const scribe = new VisionScribe({ ollamaUrl: OLLAMA_URL, skipPing: true });

  const results: EvalResult[] = [];

  for (const filename of toProcess) {
    const stem = path.basename(filename, '.pdf');
    const pdfPath = path.join(BENCH_PDFS, filename);
    const gtPath  = path.join(BENCH_GT, `${stem}.md`);
    process.stdout.write(`  ${filename} … `);

    let prediction = '';
    let error: string | undefined;

    try {
      prediction = await scribe.toMarkdown(pdfPath);
      await writeFile(path.join(PREDICTIONS_DIR, `${stem}.md`), prediction, 'utf8');
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      process.stdout.write(`ERROR (${error})\n`);
      results.push({ file: filename, cer: 1, llmScore: 0, llmReason: '', passed: false, error });
      continue;
    }

    if (!existsSync(gtPath)) {
      process.stdout.write('no ground-truth, skipping metrics\n');
      results.push({ file: filename, cer: 0, llmScore: 0, llmReason: 'no ground-truth', passed: false });
      continue;
    }

    const groundTruth = await readFile(gtPath, 'utf8');
    const cer = computeCER(prediction, groundTruth);

    // Skip LLM judge for empty predictions — models hallucinate high scores on empty input
    if (!prediction.trim()) {
      process.stdout.write('✗  empty prediction\n');
      results.push({ file: filename, cer, llmScore: 0, llmReason: 'empty prediction (OCR returned no text)', passed: false });
      continue;
    }

    let llmScore = 0;
    let llmReason = '';
    try {
      const judgeResult = await llmJudge(prediction, groundTruth);
      llmScore = judgeResult.score;
      llmReason = judgeResult.reason;
    } catch (err) {
      llmReason = `judge error: ${err instanceof Error ? err.message : String(err)}`;
    }

    const passed = llmScore >= 8;
    const icon = passed ? '✓' : '✗';
    process.stdout.write(`${icon}  CER=${(cer * 100).toFixed(1)}%  score=${llmScore}/10\n`);

    results.push({ file: filename, cer, llmScore, llmReason, passed, error });
  }

  // Write report
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(REPORTS_DIR, `report-${timestamp}.json`);
  await writeFile(reportPath, JSON.stringify(results, null, 2), 'utf8');

  // Summary
  const evaluated = results.filter(r => r.llmScore > 0);
  const passed    = results.filter(r => r.passed).length;
  const errors    = results.filter(r => r.error).length;
  const empty     = results.filter(r => r.llmReason === 'empty prediction (OCR returned no text)').length;
  const avgCER    = evaluated.length ? evaluated.reduce((s, r) => s + r.cer, 0) / evaluated.length : 0;
  const avgScore  = evaluated.length ? evaluated.reduce((s, r) => s + r.llmScore, 0) / evaluated.length : 0;

  console.log('\n────────────────────────────────');
  console.log(`  Total files:   ${results.length}`);
  console.log(`  Passed (≥8):   ${passed} / ${results.length}`);
  if (empty)  console.log(`  Empty OCR:     ${empty}`);
  if (errors) console.log(`  Errors:        ${errors}`);
  console.log(`  Avg CER:       ${(avgCER * 100).toFixed(1)}%`);
  console.log(`  Avg LLM score: ${avgScore.toFixed(1)} / 10`);
  console.log(`\n  Report: ${reportPath}`);
  console.log('────────────────────────────────\n');
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
