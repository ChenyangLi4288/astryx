// Copyright (c) Meta Platforms, Inc. and affiliates.

/**
 * @file collect.ts
 * @input A Playwright page showing a windowed list whose rows carry a key
 *   attribute (default `data-vbench-key`) inside an optional scroller
 *   (`[data-vbench-scroller]`; absent means the page scrolls)
 * @output Per-frame records (time, scroll, viewport, every mounted row's
 *   content-space rect, the anchored row's position, whether scripted input
 *   was active) and the ground truth from an unwindowed render
 * @position The browser half of the reusable virtualization checker. Any page
 *   that follows the row contract works: the bench engines page, or a
 *   component page such as a Table case. Bench-only; never merged.
 */

import type {CDPSession, Page} from '@playwright/test';
import type {Frame, GroundTruth} from './analyze';

export interface ListContract {
  /** Selector for row elements. */
  rowSelector: string;
  /** Attribute on the row holding its stable key. */
  keyAttribute: string;
  /** Selector for the scroller; when it matches nothing, the page scrolls. */
  scrollerSelector: string;
  /**
   * When the key sits inside the row (a Table cell), the selector of the
   * row element to measure, matched with `closest`.
   */
  rowClosest?: string;
}

export const DEFAULT_CONTRACT: ListContract = {
  rowSelector: '[data-vbench-key]',
  keyAttribute: 'data-vbench-key',
  scrollerSelector: '[data-vbench-scroller]',
  ...(process.env.VBENCH_ROW_CLOSEST
    ? {rowClosest: process.env.VBENCH_ROW_CLOSEST}
    : null),
};

/** Reads every mounted row's content-space rect, in the page. */
function readRowsSource(contract: ListContract): string {
  return `(() => {
    const scroller = document.querySelector(${JSON.stringify(contract.scrollerSelector)});
    const originTop = scroller ? scroller.getBoundingClientRect().top : 0;
    const scroll = scroller ? scroller.scrollTop : window.scrollY;
    const viewport = scroller ? scroller.clientHeight : window.innerHeight;
    const rows = [];
    for (const keyed of document.querySelectorAll(${JSON.stringify(contract.rowSelector)})) {
      const el = ${contract.rowClosest ? `keyed.closest(${JSON.stringify(contract.rowClosest)}) || keyed` : 'keyed'};
      if (el.style.display === 'none') continue;
      const rect = el.getBoundingClientRect();
      if (rect.height === 0) continue;
      rows.push({
        key: keyed.getAttribute(${JSON.stringify(contract.keyAttribute)}) || '',
        top: rect.top - originTop + scroll,
        bottom: rect.bottom - originTop + scroll,
      });
    }
    return {scroll, viewport, rows};
  })()`;
}

/**
 * Starts recording one record per animation frame. With `rects`, every frame
 * also reads the mounted rows; without it, only timing is recorded.
 */
export async function startRecording(
  page: Page,
  {
    rects,
    contract = DEFAULT_CONTRACT,
  }: {rects: boolean; contract?: ListContract},
): Promise<void> {
  const read = readRowsSource(contract);
  await page.evaluate(
    ({read, rects}) => {
      const w = window as unknown as {
        __vbenchFrames: unknown[];
        __vbenchInput: boolean;
        __vbenchStage: number;
        __vbenchAnchorEpoch?: number;
        __vbenchStop: boolean;
        __vbench?: {anchorTop?: () => number | null};
      };

      const readRows = new Function(`return ${read};`) as () => {
        scroll: number;
        viewport: number;
        rows: unknown[];
      };
      w.__vbenchFrames = [];
      w.__vbenchInput = false;
      w.__vbenchStage = w.__vbenchStage ?? 0;
      w.__vbenchStop = false;
      const tick = (t: number) => {
        if (w.__vbenchStop) {
          return;
        }
        const geometry = rects
          ? readRows()
          : {scroll: 0, viewport: 0, rows: []};
        w.__vbenchFrames.push({
          t,
          scroll: geometry.scroll,
          viewport: geometry.viewport,
          rows: geometry.rows,
          input: w.__vbenchInput,
          stage: w.__vbenchStage,
          anchorTop: rects ? (w.__vbench?.anchorTop?.() ?? null) : null,
          anchorEpoch: w.__vbenchAnchorEpoch ?? 0,
        });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    {read, rects},
  );
}

export interface RecordedFrame extends Frame {
  stage: number;
}

export async function stopRecording(page: Page): Promise<RecordedFrame[]> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __vbenchFrames: unknown[];
      __vbenchStop: boolean;
    };
    w.__vbenchStop = true;
    return w.__vbenchFrames as never;
  });
}

export async function setInput(page: Page, active: boolean): Promise<void> {
  await page.evaluate(active => {
    (window as unknown as {__vbenchInput: boolean}).__vbenchInput = active;
  }, active);
}

/** Marks that a layout-changing mutation (insert above, resize) happened. */
export async function nextStage(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {__vbenchStage: number};
    w.__vbenchStage = (w.__vbenchStage ?? 0) + 1;
  });
}

/** The unwindowed page's rows, as the ground truth. */
export async function readGroundTruth(
  page: Page,
  contract: ListContract = DEFAULT_CONTRACT,
): Promise<GroundTruth> {
  const read = readRowsSource(contract);
  const rows = await page.evaluate(read => {
    const readRows = new Function(`return ${read};`) as () => {
      rows: Array<{key: string; top: number; bottom: number}>;
    };
    return readRows().rows;
  }, read);
  return new Map(rows.map(r => [r.key, {top: r.top, bottom: r.bottom}]));
}

/** A touch fling (with momentum) or a drag (without), through Chromium. */
export async function gesture(
  page: Page,
  cdp: CDPSession,
  {
    distance,
    speed,
    momentum,
    source = 'touch',
  }: {
    distance: number;
    speed: number;
    momentum: boolean;
    source?: 'touch' | 'mouse';
  },
): Promise<void> {
  const viewport = page.viewportSize() ?? {width: 800, height: 600};
  await cdp.send('Input.synthesizeScrollGesture', {
    x: Math.round(viewport.width / 2),
    y: Math.round(viewport.height / 2),
    yDistance: -distance,
    speed,
    gestureSourceType: source,
    preventFling: !momentum,
    repeatCount: 0,
  });
}

/** Wheel steps of `delta` px at ~60 Hz. */
export async function wheel(
  page: Page,
  steps: number,
  delta: number,
): Promise<void> {
  const viewport = page.viewportSize() ?? {width: 800, height: 600};
  await page.mouse.move(viewport.width / 2, viewport.height / 2);
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, delta);
    await page.waitForTimeout(16);
  }
}

export async function heapMb(cdp: CDPSession): Promise<number> {
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  const {metrics} = await cdp.send('Performance.getMetrics');
  const heap = metrics.find(m => m.name === 'JSHeapUsedSize')?.value ?? 0;
  return Math.round((heap / (1024 * 1024)) * 10) / 10;
}
