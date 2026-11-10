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
import {rafFrames, readGroundTruth} from './collect';
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

/**
 * S11: records, from the first frame after navigation, whether the list is in
 * the page and how much of the viewport its rows leave uncovered.
 */
const FIRST_PAINT_RECORDER = `(() => {
  window.__vbenchFP = [];
  const tick = () => {
    const list = document.querySelector('[role="list"]');
    if (list) {
      const scroller = document.querySelector('[data-vbench-scroller]');
      const top = scroller ? scroller.getBoundingClientRect().top : 0;
      const height = scroller ? scroller.clientHeight : window.innerHeight;
      const listTop = list.getBoundingClientRect().top - top;
      const viewTop = Math.max(0, listTop);
      const rows = [...document.querySelectorAll('[data-vbench-key]')]
        .filter(r => r.style.display !== 'none')
        .map(r => { const b = r.getBoundingClientRect(); return [b.top - top, b.bottom - top]; })
        .sort((a, b) => a[0] - b[0]);
      let cursor = viewTop, missing = 0;
      for (const [t, b] of rows) {
        if (b <= cursor) continue;
        if (t >= height) break;
        if (t > cursor) missing += t - cursor;
        cursor = Math.max(cursor, b);
      }
      if (cursor < height) missing += height - cursor;
      window.__vbenchFP.push({hasList: true, uncovered: missing});
    } else {
      window.__vbenchFP.push({hasList: false, uncovered: 0});
    }
    if (window.__vbenchFP.length < 120) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;

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
// A1: an engine written as `name@direct` runs only on these scenarios.
const A1_SCENARIOS = new Set(
  (process.env.VBENCH_A1_SCENARIOS ?? 'S1,S3,S4,S5,S6,S7').split(','),
);
// Compare mode: `scenario|text` pairs to leave out (e.g. `C-width|100`).
const SKIP = new Set(
  (process.env.VBENCH_SKIP ?? '').split(',').filter(Boolean),
);
const runsCell = (engine: string, scenario: {id: string; text?: number}) =>
  (!engine.includes('@') || A1_SCENARIOS.has(scenario.id)) &&
  !SKIP.has(`${scenario.id}|${scenario.text ?? TEXT}`);
if (process.env.VBENCH_INTERLEAVE === '1') {
  for (const scenario of SCENARIO_LIST) {
    for (let run = 0; run < RUNS; run++) {
      ENGINES.forEach((_, i) => {
        const engine = ENGINES[(i + run) % ENGINES.length] ?? ENGINES[0] ?? '';
        if (runsCell(engine, scenario)) {
          CELLS.push({engine, scenario, run});
        }
      });
    }
  }
} else {
  for (const engine of ENGINES) {
    for (const scenario of SCENARIO_LIST) {
      for (let run = 0; run < RUNS; run++) {
        if (runsCell(engine, scenario)) {
          CELLS.push({engine, scenario, run});
        }
      }
    }
  }
}

for (const {engine, scenario, run} of CELLS) {
  {
    {
      test(`${engine} ${scenario.id} run ${run + 1}`, async ({browser}) => {
        test.setTimeout(10 * 60_000);
        const [engineName, placement = ''] = engine.split('@');
        const outFile = path.join(
          RESULTS,
          `${process.env.VBENCH_SIDE ? `${process.env.VBENCH_SIDE}__` : ''}${engine}__${scenario.id}__t${THROTTLE}__r${run + 1}.json`,
        );
        // A1 cells an engine cannot run are recorded by name, never passed.
        const unsupported =
          placement === 'direct' && engineName === 'chat'
            ? 'not supported: ChatVirtualizer owns its own row placement'
            : placement === 'direct' && engineName === 'recycle'
              ? 'not applicable: candidate 5 always places rows directly'
              : null;
        if (unsupported) {
          fs.writeFileSync(
            outFile,
            `${JSON.stringify({engine, scenario: scenario.id, run: run + 1, throttle: THROTTLE, unsupported}, null, 2)}\n`,
          );
          return;
        }
        const params: Record<string, string | number> = {
          engine: engineName ?? engine,
          ...(placement ? {placement} : null),
          ...scenario.params,
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
        if (scenario.firstPaint) {
          await page.addInitScript(FIRST_PAINT_RECORDER);
        }
        const t0 = Date.now();
        await open(page, url(params));
        const firstRenderMs = Date.now() - t0;
        let error: string | null = null;
        let result;
        let firstPaint = null;
        try {
          if (scenario.firstPaint) {
            await page.waitForTimeout(1500);
            firstPaint = await page.evaluate(() => {
              const log =
                (
                  window as unknown as {
                    __vbenchFP: Array<{hasList: boolean; uncovered: number}>;
                  }
                ).__vbenchFP ?? [];
              const withList = log.filter(f => f.hasList);
              const first = withList[0];
              const coveredAt = withList.findIndex(f => f.uncovered <= 1);
              return {
                pass: first != null && first.uncovered <= 1,
                framesWithListUntilCovered: coveredAt,
                firstUncoveredPx: first ? Math.round(first.uncovered) : null,
              };
            });
          }
          result = await scenario.run(page, cdp);
          // A14: the rAF reading, kept beside the painted one.
          const raf = await rafFrames(page);
          if (raf && raf.length > 0) {
            (result as {rafFrames?: typeof raf}).rafFrames = raf;
          }
          // P6: rows in the DOM at the end, to tell windowed from full render.
          result.extra = {
            ...result.extra,
            rowsRendered: await page.evaluate(
              () => document.querySelectorAll('[data-vbench-key]').length,
            ),
          };
        } catch (e) {
          error = String(e);
        }
        await context.close();

        let report = null;
        let rafReport: unknown = null;
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
          const raf = (result as {rafFrames?: typeof result.frames}).rafFrames;
          if (raf) {
            const rafCheck = checkFrames(raf, stagedTruth(raf, truths));
            rafReport = {...rafCheck, violations: undefined, violationCount: rafCheck.violations.length};
          }
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
          correctnessRaf: rafReport,
          extra: firstPaint
            ? {...result?.extra, firstPaint}
            : (result?.extra ?? null),
        };
        fs.writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`);
      });
    }
  }
}
