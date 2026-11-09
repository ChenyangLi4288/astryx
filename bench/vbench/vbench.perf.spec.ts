// Copyright (c) Meta Platforms, Inc. and affiliates.

/**
 * @file vbench.perf.spec.ts
 * @input A built Sandbox (VBENCH_SITE, default apps/sandbox/out) with the
 *   vbench engines page; VBENCH_ENGINES (comma list; default all five),
 *   VBENCH_SCENARIOS (comma list of ids; default all), VBENCH_RUNS (default
 *   5), VBENCH_THROTTLE (Chromium CPU slowdown; default 1), VBENCH_SEED
 *   (default 1; run r uses seed + r), VBENCH_RESULTS_DIR
 * @output One JSON per engine × scenario × run: frame statistics, the
 *   per-frame correctness report against the unwindowed ground truth, anchor
 *   drift and scenario extras; and runner.json (CPU model, calibration)
 * @position Driver of the virtualizer bake-off (bench/vbench/README.md).
 *   Each run uses a fresh browser context. Bench-only; never merged.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test, type Page} from '@playwright/test';
import {
  serveStatic,
  type StaticServer,
} from '../../internal/a11y-spec/src/storybook';
import {checkFrames, frameStats, median, stagedTruth} from './analyze';
import {readGroundTruth} from './collect';
import {COMPONENT_SCENARIOS, SCENARIOS, replayStages} from './scenarios';

const PAGE = process.env.VBENCH_PAGE ?? 'vbench-engines';
const SET =
  process.env.VBENCH_SET === 'components' ? COMPONENT_SCENARIOS : SCENARIOS;
const ENGINES = (
  process.env.VBENCH_ENGINES ?? 'listwindow,chat,tanstack,fenwick,recycle'
)
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const SCENARIO_IDS = new Set(
  (process.env.VBENCH_SCENARIOS ?? SET.map(s => s.id).join(','))
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
);
const RUNS = Number(process.env.VBENCH_RUNS ?? 5);
const THROTTLE = Number(process.env.VBENCH_THROTTLE ?? 1);
const SEED = Number(process.env.VBENCH_SEED ?? 1);
const SITE = process.env.VBENCH_SITE ?? 'apps/sandbox/out';
const RESULTS = path.resolve(
  process.env.VBENCH_RESULTS_DIR ?? 'test-results/vbench',
);
const TEXT = Number(process.env.VBENCH_TEXT ?? 100);

let server: StaticServer | undefined;

test.beforeAll(async ({browser}) => {
  server = await serveStatic(SITE, {
    sentinel: `pages/${PAGE}/index.html`,
    missing: root => `No built Sandbox with the ${PAGE} page at ${root}.`,
  });
  fs.mkdirSync(RESULTS, {recursive: true});
  const context = await browser.newContext();
  const page = await context.newPage();
  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    times.push(
      await page.evaluate(() => {
        const start = performance.now();
        let sum = 0;
        for (let j = 0; j < 20_000_000; j++) {
          sum += Math.sqrt(j);
        }
        return performance.now() - start + (sum < 0 ? 1 : 0);
      }),
    );
  }
  fs.writeFileSync(
    path.join(RESULTS, 'runner.json'),
    `${JSON.stringify({cpu: os.cpus()[0]?.model.trim() ?? null, cores: os.cpus().length, calibrationMs: median(times), throttle: THROTTLE}, null, 2)}\n`,
  );
  await context.close();
});

test.afterAll(async () => {
  await server?.close();
});

function url(params: Record<string, string | number>): string {
  const q = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  );
  return `${server?.origin ?? ''}/pages/${PAGE}/?${q.toString()}`;
}

async function open(page: Page, href: string): Promise<void> {
  await page.goto(href);
  await page.waitForFunction(
    () => document.documentElement.dataset.vbench === 'ready',
    null,
    {
      timeout: 120_000,
    },
  );
}

// With VBENCH_INTERLEAVE, runs are the outer loop and engines rotate inside
// each run, so slow drift on the runner spreads over every engine alike.
const CELLS: Array<{
  engine: string;
  scenario: (typeof SET)[number];
  run: number;
}> = [];
const SCENARIO_LIST = SET.filter(s => SCENARIO_IDS.has(s.id));
if (process.env.VBENCH_INTERLEAVE === '1') {
  for (const scenario of SCENARIO_LIST) {
    for (let run = 0; run < RUNS; run++) {
      ENGINES.forEach((_, i) => {
        const engine = ENGINES[(i + run) % ENGINES.length] ?? ENGINES[0] ?? '';
        CELLS.push({engine, scenario, run});
      });
    }
  }
} else {
  for (const engine of ENGINES) {
    for (const scenario of SCENARIO_LIST) {
      for (let run = 0; run < RUNS; run++) {
        CELLS.push({engine, scenario, run});
      }
    }
  }
}

for (const {engine, scenario, run} of CELLS) {
  {
    {
      test(`${engine} ${scenario.id} run ${run + 1}`, async ({browser}) => {
        test.setTimeout(10 * 60_000);
        const params = {
          engine,
          n: scenario.rows,
          seed: SEED + run,
          scroller: scenario.scroller,
          text: scenario.text ?? TEXT,
          anchor: scenario.anchor,
        };
        const context = await browser.newContext({
          viewport: {width: 800, height: 900},
          hasTouch: true,
        });
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        if (THROTTLE > 1) {
          await cdp.send('Emulation.setCPUThrottlingRate', {rate: THROTTLE});
        }
        await cdp.send('Performance.enable');
        const t0 = Date.now();
        await open(page, url(params));
        const firstRenderMs = Date.now() - t0;
        let error: string | null = null;
        let result;
        try {
          result = await scenario.run(page, cdp);
        } catch (e) {
          error = String(e);
        }
        await context.close();

        let report = null;
        if (result) {
          // Ground truth: the same rows unwindowed, with the same mutations.
          const truthContext = await browser.newContext({
            viewport: {width: 800, height: 900},
            hasTouch: true,
          });
          const truthPage = await truthContext.newPage();
          await open(truthPage, url({...params, mode: 'unwindowed'}));
          const truths = await replayStages(truthPage, result.mutations, () =>
            readGroundTruth(truthPage),
          );
          await truthContext.close();
          const correctness = checkFrames(
            result.frames,
            stagedTruth(result.frames, truths),
          );
          report = {
            ...correctness,
            violations: correctness.violations.slice(0, 50),
            violationCount: correctness.violations.length,
          };
        }
        const out = {
          engine,
          side: process.env.VBENCH_SIDE ?? null,
          scenario: scenario.id,
          run: run + 1,
          seed: SEED + run,
          throttle: THROTTLE,
          text: scenario.text ?? TEXT,
          firstRenderMs,
          error,
          timing: result ? frameStats(result.frames) : null,
          correctness: report,
          extra: result?.extra ?? null,
        };
        fs.writeFileSync(
          path.join(
            RESULTS,
            `${process.env.VBENCH_SIDE ? `${process.env.VBENCH_SIDE}__` : ''}${engine}__${scenario.id}__t${THROTTLE}__r${run + 1}.json`,
          ),
          `${JSON.stringify(out, null, 2)}\n`,
        );
      });
    }
  }
}
