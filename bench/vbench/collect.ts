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
 * Protocol A14: the primary record reads the painted state, in a
 * ResizeObserver callback after the engines' own observers and before paint;
 * the rAF read (before that frame's layout) is kept as a secondary reading.
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
        __vbenchFramesRaf: unknown[];
        __vbenchInput: boolean;
        __vbenchStage: number;
        __vbenchAnchorEpoch?: number;
        __vbenchStop: boolean;
        __vbenchProbe?: {observer: ResizeObserver; el: HTMLElement};
        __vbench?: {anchorTop?: () => number | null};
      };

      const readRows = new Function(`return ${read};`) as () => {
        scroll: number;
        viewport: number;
        rows: unknown[];
      };
      w.__vbenchFrames = [];
      w.__vbenchFramesRaf = [];
      w.__vbenchInput = false;
      w.__vbenchStage = w.__vbenchStage ?? 0;
      w.__vbenchStop = false;
      const record = (t: number, flags: {input: boolean; stage: number; epoch: number}) => {
        const geometry = rects
          ? readRows()
          : {scroll: 0, viewport: 0, rows: []};
        return {
          t,
          scroll: geometry.scroll,
          viewport: geometry.viewport,
          rows: geometry.rows,
          input: flags.input,
          stage: flags.stage,
          anchorTop: rects ? (w.__vbench?.anchorTop?.() ?? null) : null,
          anchorEpoch: flags.epoch,
        };
      };
      // A 1 px probe that changes size every frame: its observer is created
      // after the engines' observers, so its callback runs after theirs (and
      // after their microtasks), in the same frame, before paint.
      w.__vbenchProbe?.observer.disconnect();
      w.__vbenchProbe?.el.remove();
      const el = document.createElement('div');
      el.style.cssText =
        'position:fixed;left:0;top:0;width:1px;height:1px;pointer-events:none;visibility:hidden';
      document.body.appendChild(el);
      let pending: {t: number; input: boolean; stage: number; epoch: number} | null = null;
      const observer = new ResizeObserver(() => {
        if (pending == null || w.__vbenchStop) {
          return;
        }
        w.__vbenchFrames.push(record(pending.t, pending));
        pending = null;
      });
      observer.observe(el);
      w.__vbenchProbe = {observer, el};
      let wide = false;
      const tick = (t: number) => {
        if (w.__vbenchStop) {
          observer.disconnect();
          el.remove();
          return;
        }
        // A frame whose probe callback did not run (no layout) keeps its rAF
        // read as the painted state.
        if (pending != null) {
          w.__vbenchFrames.push(record(pending.t, pending));
        }
        const flags = {
          input: w.__vbenchInput,
          stage: w.__vbenchStage,
          epoch: w.__vbenchAnchorEpoch ?? 0,
        };
        w.__vbenchFramesRaf.push(record(t, flags));
        pending = {t, ...flags};
        wide = !wide;
        el.style.width = wide ? '2px' : '1px';
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

/** The secondary rAF reading of the last recording (A14). */
export async function rafFrames(page: Page): Promise<RecordedFrame[] | null> {
  return page.evaluate(
    () =>
      ((window as unknown as {__vbenchFramesRaf?: unknown[]})
        .__vbenchFramesRaf ?? null) as never,
  );
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
