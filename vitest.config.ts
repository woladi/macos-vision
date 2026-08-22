import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every test spawns a native helper that runs a Vision model. Under the
    // default 5s timeout these pass in isolation but flake when the suite runs
    // in parallel and saturates the machine.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Vision requests are already CPU/ANE-bound; running many files at once
    // buys nothing and is what pushed the suite over its timeouts.
    fileParallelism: false,
    // The repo's own worktrees contain copies of these tests — running them
    // twice doubles an already slow, model-bound suite.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/worktrees/**'],
  },
});
