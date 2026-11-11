// Copyright (c) Meta Platforms, Inc. and affiliates.

/** Unit tests for the bench's pure parts (analysis, offset model). */
import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {include: ['bench/vbench/**/*.test.ts'], environment: 'node'},
});
