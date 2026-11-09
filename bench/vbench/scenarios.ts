// Copyright (c) Meta Platforms, Inc. and affiliates.

/**
 * @file scenarios.ts
 * @input A page on the vbench engines page (or any page with the same
 *   `window.__vbench` controls), a CDP session, and recording helpers
 * @output The protocol's scripted scenarios S1–S9 (S8 = S1, S3, S5 on page
 *   scroll), each returning its recorded frames, the ground-truth stages it
 *   needs, and scenario-specific results (S9 pass/fail, heap)
 * @position Scenario scripts of the virtualizer bake-off protocol (artifact
 *   1842415570228789). Bench-only; never merged.
 */

import type {CDPSession, Page} from '@playwright/test';
import {
  heapMb,
  nextStage,
  setInput,
  startRecording,
  stopRecording,
  type RecordedFrame,
} from './collect';

/** A mutation the ground truth must replay, in order. */
export type Mutation =
  | {kind: 'append'; count: number}
  | {kind: 'insertAbove'; count: number}
  | {kind: 'resize'; key: string; delta: number}
  | {kind: 'width'; px: number | null};

export interface ScenarioResult {
  frames: RecordedFrame[];
  /** Mutations in order; `stage` marks the layout-changing ones. */
  mutations: Mutation[];
  /** Scenario-specific results. */
  extra: Record<string, unknown>;
}

export interface ScenarioDef {
  id: string;
  rows: number;
  anchor: 'first-visible' | 'end' | 'item';
  scroller: 'container' | 'page';
  /** Text scale for this scenario, percent; the run's scale when absent. */
  text?: number;
  /** Extra page parameters, e.g. wrapping rows. */
  params?: Record<string, string>;
  /** S11: measure the first painted frames instead of running a script. */
  firstPaint?: boolean;
  run: (page: Page, cdp: CDPSession) => Promise<ScenarioResult>;
}

type Api = {
  count(): number;
  keyAt(i: number): string | null;
  append(n: number): void;
  insertAbove(n: number): void;
  resize(key: string, delta: number): void;
  setAnchor(mode: string, key?: string | null): void;
  setWidth(px: number | null): void;
  firstVisibleKey(): string | null;
  scrollToKey(key: string): void;
  focusKey(key: string): void;
  focusedKey(): string | null;
  focusedPosition(): number | null;
  expectedPosition(key: string): number;
};

async function api<T>(page: Page, fn: (api: Api) => T): Promise<T> {
  return page.evaluate(source => {
    const f = new Function('api', `return (${source})(api);`);
    return f((window as unknown as {__vbench: unknown}).__vbench);
  }, fn.toString()) as Promise<T>;
}

async function scrollToFraction(page: Page, fraction: number): Promise<void> {
  await page.evaluate(f => {
    const el = document.querySelector<HTMLElement>('[data-vbench-scroller]');
    if (el) {
      el.scrollTop = (el.scrollHeight - el.clientHeight) * f;
    } else {
      window.scrollTo(
        0,
        (document.documentElement.scrollHeight - window.innerHeight) * f,
      );
    }
  }, fraction);
}

async function scrollToEnd(page: Page): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await scrollToFraction(page, 1);
    await page.waitForTimeout(100);
  }
}

async function settle(page: Page, ms: number): Promise<void> {
  await page.waitForTimeout(ms);
}

/** Streams `perSecond` appends for `seconds`. */
async function stream(
  page: Page,
  mutations: Mutation[],
  perSecond: number,
  seconds: number,
): Promise<{appendMsP50: number | null; appendMsP95: number | null}> {
  const interval = 1000 / perSecond;
  const total = Math.round(perSecond * seconds);
  // P4: each append's cost, from the append to the next frame.
  const costs = await page.evaluate(
    ({interval, total}) =>
      new Promise<number[]>(resolve => {
        let sent = 0;
        const out: number[] = [];
        const api = (window as unknown as {__vbench: Api}).__vbench;
        const timer = setInterval(() => {
          const t0 = performance.now();
          api.append(1);
          requestAnimationFrame(() => out.push(performance.now() - t0));
          sent += 1;
          if (sent >= total) {
            clearInterval(timer);
            setTimeout(() => resolve(out), 100);
          }
        }, interval);
      }),
    {interval, total},
  );
  for (let i = 0; i < total; i++) {
    mutations.push({kind: 'append', count: 1});
  }
  const sorted = [...costs].sort((a, b) => a - b);
  const at = (p: number) =>
    sorted.length
      ? (sorted[
          Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
        ] ?? null)
      : null;
  const round = (n: number | null) =>
    n == null ? null : Math.round(n * 100) / 100;
  return {appendMsP50: round(at(50)), appendMsP95: round(at(95))};
}

/** P6: the page's element count. */
async function domNodes(page: Page): Promise<number> {
  return page.evaluate(() => document.getElementsByTagName('*').length);
}

/** S1: flings top to bottom, capped at 30 s. */
async function flingDown(
  page: Page,
  cdp: CDPSession,
  capMs: number,
): Promise<number> {
  const start = Date.now();
  let flings = 0;
  await setInput(page, true);
  void cdp;
  const viewport = page.viewportSize() ?? {width: 800, height: 600};
  await page.mouse.move(viewport.width / 2, viewport.height / 2);
  const deadline = start + capMs;
  outer: while (Date.now() < deadline) {
    // A fling as wheel events at 60 Hz whose deltas decay, as a trackpad
    // fling's momentum does: a peak of 300 px per frame (18,000 px/s) and
    // about 10,000 px per fling. Chromium's synthetic touch gesture does not
    // scroll these pages headless.
    for (let delta = 300; delta >= 5; delta *= 0.97) {
      if (Date.now() >= deadline) {
        break outer;
      }
      await page.mouse.wheel(0, Math.round(delta));
      await page.waitForTimeout(16);
    }
    flings += 1;
    const atEnd = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-vbench-scroller]');
      return el
        ? el.scrollTop + el.clientHeight >= el.scrollHeight - 2
        : window.scrollY + window.innerHeight >=
            document.documentElement.scrollHeight - 2;
    });
    if (atEnd) {
      break;
    }
  }
  await setInput(page, false);
  return flings;
}

function def(
  id: string,
  rows: number,
  anchor: ScenarioDef['anchor'],
  scroller: ScenarioDef['scroller'],
  run: ScenarioDef['run'],
): ScenarioDef {
  return {id, rows, anchor, scroller, run};
}

const s1 = (scroller: ScenarioDef['scroller'], id: string) =>
  def(id, 10_000, 'first-visible', scroller, async (page, cdp) => {
    // Every engine starts at the top: ChatVirtualizer opens at the end.
    for (let i = 0; i < 5; i++) {
      await scrollToFraction(page, 0);
      await page.waitForTimeout(100);
    }
    await startRecording(page, {rects: true});
    const flings = await flingDown(page, cdp, 30_000);
    await settle(page, 500);
    const scrolled = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-vbench-scroller]');
      return el ? el.scrollTop : window.scrollY;
    });
    return {
      frames: await stopRecording(page),
      mutations: [],
      extra: {
        flings,
        scrolledPx: Math.round(scrolled),
        domNodes: await domNodes(page),
      },
    };
  });

const s2 = def(
  'S2',
  100_000,
  'first-visible',
  'container',
  async (page, cdp) => {
    await startRecording(page, {rects: true});
    for (const f of [0.25, 0.5, 0.75, 0.5, 0.25, 0]) {
      await setInput(page, true);
      await scrollToFraction(page, f);
      await page.waitForTimeout(32);
      const key = await api(page, a => a.firstVisibleKey());
      await api(page, a => a.setAnchor('first-visible', null));
      await page.evaluate(
        k =>
          (window as unknown as {__vbench: Api}).__vbench.setAnchor(
            'first-visible',
            k,
          ),
        key,
      );
      await setInput(page, false);
      await settle(page, 1000);
    }
    const frames = await stopRecording(page);
    return {
      frames,
      mutations: [],
      extra: {heapMb: await heapMb(cdp), domNodes: await domNodes(page)},
    };
  },
);

const s3 = (scroller: ScenarioDef['scroller'], id: string) =>
  def(id, 10_000, 'end', scroller, async page => {
    const mutations: Mutation[] = [];
    await page.evaluate(() =>
      (window as unknown as {__vbench: Api}).__vbench.setAnchor('end', null),
    );
    await scrollToEnd(page);
    await startRecording(page, {rects: true});
    const cost = await stream(page, mutations, 20, 60);
    await settle(page, 500);
    return {
      frames: await stopRecording(page),
      mutations,
      extra: {...cost, domNodes: await domNodes(page)},
    };
  });

const s4 = def('S4', 10_000, 'first-visible', 'container', async page => {
  const mutations: Mutation[] = [];
  await scrollToFraction(page, 0.5);
  await settle(page, 300);
  const key = await api(page, a => a.firstVisibleKey());
  await page.evaluate(
    k =>
      (window as unknown as {__vbench: Api}).__vbench.setAnchor(
        'first-visible',
        k,
      ),
    key,
  );
  await startRecording(page, {rects: true});
  const cost = await stream(page, mutations, 20, 20);
  await settle(page, 500);
  return {
    frames: await stopRecording(page),
    mutations,
    extra: {anchorKey: key, ...cost},
  };
});

const s5 = (scroller: ScenarioDef['scroller'], id: string) =>
  def(id, 10_000, 'first-visible', scroller, async page => {
    const mutations: Mutation[] = [];
    await scrollToFraction(page, 0.5);
    await settle(page, 300);
    const key = await api(page, a => a.firstVisibleKey());
    await page.evaluate(
      k =>
        (window as unknown as {__vbench: Api}).__vbench.setAnchor(
          'first-visible',
          k,
        ),
      key,
    );
    await startRecording(page, {rects: true});
    await settle(page, 200);
    await page.evaluate(() =>
      (window as unknown as {__vbench: Api}).__vbench.insertAbove(50),
    );
    await nextStage(page);
    mutations.push({kind: 'insertAbove', count: 50});
    await settle(page, 2000);
    return {
      frames: await stopRecording(page),
      mutations,
      extra: {anchorKey: key},
    };
  });

const s6 = (mode: 'first-visible' | 'item', id: string) =>
  def(id, 10_000, mode, 'container', async page => {
    const mutations: Mutation[] = [];
    await scrollToFraction(page, 0.5);
    await settle(page, 300);
    // The resized row sits mid-viewport; with item anchoring, the anchor is
    // the row after it, which must stay still while the row above it grows.
    const picked = await page.evaluate(mode => {
      const el = document.querySelector<HTMLElement>('[data-vbench-scroller]');
      const top = el?.getBoundingClientRect().top ?? 0;
      const height = el?.clientHeight ?? window.innerHeight;
      const rows = [
        ...document.querySelectorAll<HTMLElement>('[data-vbench-key]'),
      ]
        .filter(r => r.style.display !== 'none')
        .map(r => ({
          key: r.dataset.vbenchKey ?? '',
          top: r.getBoundingClientRect().top - top,
        }))
        .filter(r => r.top >= 0 && r.top < height)
        .sort((a, b) => a.top - b.top);
      const first = rows[0]?.key ?? null;
      const mid = rows[Math.floor(rows.length / 2)]?.key ?? null;
      const after = rows[Math.floor(rows.length / 2) + 1]?.key ?? null;
      return {first, mid, after, anchor: mode === 'item' ? after : first};
    }, mode);
    await page.evaluate(
      ({mode, key}) =>
        (window as unknown as {__vbench: Api}).__vbench.setAnchor(mode, key),
      {mode, key: picked.anchor},
    );
    await startRecording(page, {rects: true});
    await settle(page, 200);
    for (const delta of [300, -300]) {
      await page.evaluate(
        ({key, delta}) =>
          (window as unknown as {__vbench: Api}).__vbench.resize(key, delta),
        {key: picked.mid ?? '', delta},
      );
      await nextStage(page);
      mutations.push({kind: 'resize', key: picked.mid ?? '', delta});
      await settle(page, 1000);
    }
    return {frames: await stopRecording(page), mutations, extra: picked};
  });

const s7 = def('S7', 10_000, 'item', 'container', async page => {
  const mutations: Mutation[] = [];
  const key = await page.evaluate(() => {
    const api = (window as unknown as {__vbench: Api}).__vbench;
    return api.keyAt(Math.floor(api.count() * 0.6));
  });
  await page.evaluate(
    k => (window as unknown as {__vbench: Api}).__vbench.scrollToKey(k ?? ''),
    key,
  );
  await settle(page, 1500);
  await page.evaluate(
    k => (window as unknown as {__vbench: Api}).__vbench.setAnchor('item', k),
    key,
  );
  await startRecording(page, {rects: true});
  const cost = await stream(page, mutations, 20, 10);
  await settle(page, 500);
  return {
    frames: await stopRecording(page),
    mutations,
    extra: {anchorKey: key, ...cost},
  };
});

const s9 = def('S9', 10_000, 'first-visible', 'container', async page => {
  await scrollToFraction(page, 0.3);
  await settle(page, 300);
  const key = await api(page, a => a.firstVisibleKey());
  await page.evaluate(
    k => (window as unknown as {__vbench: Api}).__vbench.focusKey(k ?? ''),
    key,
  );
  await startRecording(page, {rects: true});
  // Read the focused row's identity on every frame while it scrolls away.
  const identity = await page.evaluate(
    k =>
      new Promise<{
        lostFocus: boolean;
        wrongRow: boolean;
        wrongPosition: boolean;
      }>(resolve => {
        const api = (window as unknown as {__vbench: Api}).__vbench;
        const expected = api.expectedPosition(k ?? '');
        const result = {
          lostFocus: false,
          wrongRow: false,
          wrongPosition: false,
        };
        let frames = 0;
        const check = () => {
          const focused = api.focusedKey();
          if (document.activeElement === document.body || focused == null) {
            result.lostFocus = true;
          } else if (focused !== k) {
            result.wrongRow = true;
          } else if (api.focusedPosition() !== expected) {
            result.wrongPosition = true;
          }
          if (++frames < 120) {
            requestAnimationFrame(check);
          } else {
            resolve(result);
          }
        };
        const el = document.querySelector<HTMLElement>(
          '[data-vbench-scroller]',
        );
        if (el) {
          el.scrollTop += el.clientHeight * 40;
        } else {
          window.scrollBy(0, window.innerHeight * 40);
        }
        requestAnimationFrame(check);
      }),
    key,
  );
  await page.evaluate(
    k => (window as unknown as {__vbench: Api}).__vbench.scrollToKey(k ?? ''),
    key,
  );
  await settle(page, 1500);
  const back = await page.evaluate(k => {
    const api = (window as unknown as {__vbench: Api}).__vbench;
    return {
      focused: api.focusedKey(),
      position: api.focusedPosition(),
      expected: api.expectedPosition(k ?? ''),
      onBody: document.activeElement === document.body,
    };
  }, key);
  const pass =
    !identity.lostFocus &&
    !identity.wrongRow &&
    !identity.wrongPosition &&
    !back.onBody &&
    back.focused === key &&
    back.position === back.expected;
  return {
    frames: await stopRecording(page),
    mutations: [],
    extra: {pass, identity, back, key},
  };
});

/** Wheel: 300 steps of 120 px. */
const wheelScenario = (rows: number, id: string) =>
  def(id, rows, 'first-visible', 'container', async page => {
    await startRecording(page, {rects: true});
    await setInput(page, true);
    const viewport = page.viewportSize() ?? {width: 800, height: 600};
    await page.mouse.move(viewport.width / 2, viewport.height / 2);
    for (let i = 0; i < 300; i++) {
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(16);
    }
    await setInput(page, false);
    await settle(page, 500);
    return {frames: await stopRecording(page), mutations: [], extra: {}};
  });

/** Drag: 10 touch drags of 600 px at 1200 px/s, no momentum. */
const dragScenario = (rows: number, id: string) =>
  def(id, rows, 'first-visible', 'container', async (page, cdp) => {
    await startRecording(page, {rects: true});
    await setInput(page, true);
    void cdp;
    const viewport = page.viewportSize() ?? {width: 800, height: 600};
    await page.mouse.move(viewport.width / 2, viewport.height / 2);
    // A drag as steady 20 px wheel steps at 60 Hz with no momentum: ten
    // drags of 600 px.
    for (let i = 0; i < 10; i++) {
      for (let step = 0; step < 30; step++) {
        await page.mouse.wheel(0, 20);
        await page.waitForTimeout(16);
      }
      await page.waitForTimeout(200);
    }
    await setInput(page, false);
    await settle(page, 500);
    return {frames: await stopRecording(page), mutations: [], extra: {}};
  });

/** Per-append cost: 50 single appends, each timed to its next frame. */
const appendCost = def(
  'APPEND',
  10_000,
  'first-visible',
  'container',
  async page => {
    const mutations: Mutation[] = [];
    await startRecording(page, {rects: false});
    const costs = await page.evaluate(
      () =>
        new Promise<number[]>(resolve => {
          const api = (window as unknown as {__vbench: Api}).__vbench;
          const out: number[] = [];
          const step = () => {
            const t0 = performance.now();
            api.append(1);
            requestAnimationFrame(() => {
              out.push(performance.now() - t0);
              if (out.length < 50) {
                setTimeout(step, 50);
              } else {
                resolve(out);
              }
            });
          };
          step();
        }),
    );
    for (let i = 0; i < 50; i++) {
      mutations.push({kind: 'append', count: 1});
    }
    const sorted = [...costs].sort((a, b) => a - b);
    return {
      frames: await stopRecording(page),
      mutations,
      extra: {appendMsP50: sorted[24] ?? null, appendMsP95: sorted[47] ?? null},
    };
  },
);

/** Scenarios for component pages (a Table case), lane 1's engine-swap checks. */
export const COMPONENT_SCENARIOS: ScenarioDef[] = [
  s1('container', 'C-fling-10k'),
  {...s1('container', 'C-fling-100k'), rows: 100_000},
  wheelScenario(10_000, 'C-wheel-10k'),
  dragScenario(10_000, 'C-drag-10k'),
  {...s2, id: 'C-jump-100k'},
  {...s5('container', 'C-insert-above'), id: 'C-insert-above'},
  {...s6('first-visible', 'C-resize'), id: 'C-resize'},
  appendCost,
];

/** S12: the scroller's width shrinks by 30 % mid-list, then grows back. */
const s12 = def('S12', 10_000, 'first-visible', 'container', async page => {
  const mutations: Mutation[] = [];
  await scrollToFraction(page, 0.5);
  await settle(page, 300);
  const key = await api(page, a => a.firstVisibleKey());
  await page.evaluate(
    k =>
      (window as unknown as {__vbench: Api}).__vbench.setAnchor(
        'first-visible',
        k,
      ),
    key,
  );
  await startRecording(page, {rects: true});
  await settle(page, 200);
  const full = page.viewportSize()?.width ?? 800;
  for (const px of [Math.round(full * 0.7), null]) {
    await page.evaluate(
      w => (window as unknown as {__vbench: Api}).__vbench.setWidth(w),
      px,
    );
    await nextStage(page);
    mutations.push({kind: 'width', px});
    await settle(page, 1200);
  }
  return {
    frames: await stopRecording(page),
    mutations,
    extra: {anchorKey: key},
  };
});

/** A4: jump to 75 %, then scroll up into rows not yet measured. */
const a4 = def('A4', 10_000, 'first-visible', 'container', async page => {
  await scrollToFraction(page, 0.75);
  await settle(page, 300);
  await startRecording(page, {rects: true});
  const viewport = page.viewportSize() ?? {width: 800, height: 600};
  await page.mouse.move(viewport.width / 2, viewport.height / 2);
  for (let i = 0; i < 40; i++) {
    await setInput(page, true);
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(16);
    await setInput(page, false);
    // The row at the top must hold still while the engine measures the rows
    // it just showed; a move here is a jump.
    const key = await api(page, a => a.firstVisibleKey());
    await page.evaluate(
      k =>
        (window as unknown as {__vbench: Api}).__vbench.setAnchor(
          'first-visible',
          k,
        ),
      key,
    );
    await settle(page, 120);
  }
  return {frames: await stopRecording(page), mutations: [], extra: {}};
});

/** S11: the first painted frames; the driver records them from navigation. */
const s11 = (scroller: ScenarioDef['scroller'], id: string): ScenarioDef => ({
  id,
  rows: 10_000,
  anchor: 'first-visible',
  scroller,
  firstPaint: true,
  run: async () => ({frames: [], mutations: [], extra: {}}),
});

const BASE: ScenarioDef[] = [
  s1('container', 'S1'),
  {...s1('container', 'S1-text200'), text: 200},
  s2,
  s3('container', 'S3'),
  s4,
  s5('container', 'S5'),
  s6('first-visible', 'S6'),
  s6('item', 'S6-item'),
  s7,
  s9,
  {...s12, params: {wrap: '1'}},
  a4,
];

/** Page-scroll twin of a container scenario (A9; S8 for S1, S3 and S5). */
function onPage(scenario: ScenarioDef): ScenarioDef {
  const named: Record<string, string> = {
    S1: 'S8-S1-page',
    S3: 'S8-S3-page',
    S5: 'S8-S5-page',
  };
  return {
    ...scenario,
    id: named[scenario.id] ?? `${scenario.id}-page`,
    scroller: 'page',
  };
}

export const SCENARIOS: ScenarioDef[] = [
  ...BASE,
  ...BASE.map(onPage),
  s11('container', 'S11'),
  s11('page', 'S11-page'),
];

/** Replays mutations on the ground-truth page; returns truths per stage. */
export async function replayStages(
  page: Page,
  mutations: Mutation[],
  read: () => Promise<Map<string, {top: number; bottom: number}>>,
): Promise<Array<Map<string, {top: number; bottom: number}>>> {
  const truths = [await read()];
  let pendingAppends = 0;
  const flushAppends = async () => {
    if (pendingAppends === 0) {
      return;
    }
    await page.evaluate(
      n => (window as unknown as {__vbench: Api}).__vbench.append(n),
      pendingAppends,
    );
    pendingAppends = 0;
  };
  for (const mutation of mutations) {
    if (mutation.kind === 'append') {
      pendingAppends += mutation.count;
      continue;
    }
    await flushAppends();
    if (mutation.kind === 'insertAbove') {
      await page.evaluate(
        n => (window as unknown as {__vbench: Api}).__vbench.insertAbove(n),
        mutation.count,
      );
    } else if (mutation.kind === 'width') {
      await page.evaluate(
        w => (window as unknown as {__vbench: Api}).__vbench.setWidth(w),
        mutation.px,
      );
    } else {
      await page.evaluate(
        ({key, delta}) =>
          (window as unknown as {__vbench: Api}).__vbench.resize(key, delta),
        mutation,
      );
    }
    await page.waitForTimeout(100);
    truths.push(await read());
  }
  await flushAppends();
  await page.waitForTimeout(100);
  // Appends never move earlier rows, so the final read extends the last stage.
  const final = await read();
  const last = truths[truths.length - 1];
  if (last) {
    for (const [key, rect] of final) {
      if (!last.has(key)) {
        last.set(key, rect);
      }
    }
  }
  return truths;
}
