#!/usr/bin/env tsx
/**
 * Report viewer — reads the latest evaluation report and prints a formatted summary.
 *
 * Usage:
 *   npm run eval:report
 */

import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { EvalResult } from './eval.js';

const REPORTS_DIR = path.join(new URL('..', import.meta.url).pathname, 'eval/reports');

const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const BOLD = (s: string) => `\x1b[1m${s}\x1b[0m`;
const DIM  = (s: string) => `\x1b[2m${s}\x1b[0m`;

async function latestReport(): Promise<string> {
  if (!existsSync(REPORTS_DIR)) {
    console.error('No reports directory found. Run `npm run eval` first.');
    process.exit(1);
  }
  const files = (await readdir(REPORTS_DIR))
    .filter(f => f.startsWith('report-') && f.endsWith('.json'))
    .sort();
  if (files.length === 0) {
    console.error('No report files found. Run `npm run eval` first.');
    process.exit(1);
  }
  return path.join(REPORTS_DIR, files[files.length - 1]);
}

function pad(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : s + ' '.repeat(len - s.length);
}

async function run(): Promise<void> {
  const reportPath = await latestReport();
  const raw = await readFile(reportPath, 'utf8');
  const results: EvalResult[] = JSON.parse(raw);

  console.log(`\n${BOLD('Evaluation Report')}  ${DIM(path.basename(reportPath))}\n`);

  // Table header
  const col1 = 40;
  const header =
    pad('File', col1) +
    pad('CER', 8) +
    pad('Score', 8) +
    'Status';
  console.log(BOLD(header));
  console.log('─'.repeat(header.length));

  // Rows
  for (const r of results) {
    const icon = r.error ? '⚠' : r.passed ? PASS : FAIL;
    const cer = r.error ? '  —   ' : `${(r.cer * 100).toFixed(1)}%`;
    const score = r.error ? '—' : r.llmScore > 0 ? `${r.llmScore}/10` : '—';
    const status = r.error ? `\x1b[33mERROR\x1b[0m ${r.error.slice(0, 60)}` : (r.passed ? 'pass' : `fail — ${r.llmReason.slice(0, 60)}`);

    console.log(`${icon} ${pad(r.file, col1 - 2)} ${pad(cer, 8)} ${pad(score, 8)} ${status}`);
  }

  console.log('─'.repeat(header.length));

  // Aggregate
  const evaluated = results.filter(r => r.llmScore > 0);
  const passed = results.filter(r => r.passed).length;
  const errors = results.filter(r => r.error).length;
  const avgCER = evaluated.length
    ? evaluated.reduce((s, r) => s + r.cer, 0) / evaluated.length
    : 0;
  const avgScore = evaluated.length
    ? evaluated.reduce((s, r) => s + r.llmScore, 0) / evaluated.length
    : 0;
  const passRate = results.length ? ((passed / results.length) * 100).toFixed(0) : '0';

  console.log(`\n${BOLD('Summary')}`);
  console.log(`  Total files:   ${results.length}`);
  console.log(`  Passed (≥8):   ${passed} / ${results.length} (${passRate}%)`);
  if (errors > 0) console.log(`  Errors:        ${errors}`);
  console.log(`  Avg CER:       ${(avgCER * 100).toFixed(1)}%`);
  console.log(`  Avg LLM score: ${avgScore.toFixed(1)} / 10`);

  // Highlight failures
  const failures = results.filter(r => !r.passed && !r.error);
  if (failures.length > 0) {
    console.log(`\n${BOLD('Failures (score < 8)')} — run \`npm run optimize-prompts\` for suggestions`);
    for (const f of failures) {
      console.log(`  ${FAIL} ${f.file}  score=${f.llmScore}  — ${f.llmReason.slice(0, 100)}`);
    }
  }

  console.log();
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
