// Copyright (c) Meta Platforms, Inc. and affiliates.

/**
 * @file playwright.vbench.config.ts
 * @input bench/vbench/vbench.perf.spec.ts and the VBENCH_* environment
 * @output One Chromium worker running the virtualizer bench serially
 * @position Bench-only config (bench/vbench/README.md); never merged.
 */

import {defineConfig, devices} from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.perf.spec.ts',
  outputDir: '../../test-results/vbench-output',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 10 * 60_000,
  reporter: [['list']],
  projects: [{name: 'chromium', use: {...devices['Desktop Chrome']}}],
});
