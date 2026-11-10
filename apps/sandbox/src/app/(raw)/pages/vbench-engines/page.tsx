// Copyright (c) Meta Platforms, Inc. and affiliates.

'use client';

/**
 * @file page.tsx
 * @input `?engine=` (listwindow | chat | tanstack | fenwick | recycle),
 *   `?n=` rows, `?seed=`, `?scroller=` (container | page), `?text=`
 *   (100 | 200), `?mode=` (windowed | unwindowed), `?anchor=`
 *   (first-visible | end | item), `?fixed=` (px; fixed-height engines)
 * @output One long list under one engine, rows marked `data-vbench-key`,
 *   and the `window.__vbench` controls the bench driver calls
 * @position The virtualizer bake-off page (bench/vbench). The harness owns
 *   the rows' markup, so the engines differ only in windowing and anchoring.
 *   `mode=unwindowed` renders every row in flow: the ground truth.
 *   Bench-only; never merged.
 */

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react';
import {
  Virtualizer,
  elementScroll,
  measureElement,
  observeElementOffset,
  observeElementRect,
  observeWindowOffset,
  observeWindowRect,
  windowScroll,
} from '@tanstack/virtual-core';
import {ChatVirtualizer, type ChatVirtualizerHandle} from '@astryxdesign/lab';
import {calculateListWindow} from '../../../../../../../packages/core/src/utils/listWindow';
import {FenwickOffsets} from './fenwick';
import {
  HEADER_PX,
  OVERSCAN_PX,
  anchorIndex,
  readGeometry,
  scrollBy,
} from './geometry';
import {mountRecycler} from './recycle';
import {
  BenchStore,
  rowLabel,
  wrapText,
  type AnchorMode,
  type BenchRow,
} from './store';

type EngineId = 'listwindow' | 'chat' | 'tanstack' | 'fenwick' | 'recycle';

interface BenchParams {
  engine: EngineId;
  n: number;
  seed: number;
  scroller: 'container' | 'page';
  text: number;
  mode: 'windowed' | 'unwindowed';
  anchor: AnchorMode;
  fixed: number | null;
  /** A1: React places the rows, or the engine writes positions directly. */
  placement: 'react' | 'direct';
  /** Rows hold wrapping text, so a width change changes their heights. */
  wrap: boolean;
}

function readParams(): BenchParams {
  const q = new URLSearchParams(window.location.search);
  const engine = (q.get('engine') ?? 'fenwick') as EngineId;
  const fixedRaw = q.get('fixed');
  return {
    engine,
    n: Number(q.get('n') ?? 10000),
    seed: Number(q.get('seed') ?? 1),
    scroller: q.get('scroller') === 'page' ? 'page' : 'container',
    text: Number(q.get('text') ?? 100),
    mode: q.get('mode') === 'unwindowed' ? 'unwindowed' : 'windowed',
    anchor: (q.get('anchor') ??
      (engine === 'chat' ? 'end' : 'first-visible')) as AnchorMode,
    fixed:
      fixedRaw != null ? Number(fixedRaw) : engine === 'listwindow' ? 48 : null,
    placement: q.get('placement') === 'direct' ? 'direct' : 'react',
    wrap: q.get('wrap') === '1',
  };
}

/** Root font size in px, so estimates follow the text scale. */
function remPx(): number {
  return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

const rowStyle: CSSProperties = {
  boxSizing: 'border-box',
  font: '1rem/1.5rem system-ui, sans-serif',
  overflow: 'hidden',
  borderBottom: '0 solid transparent',
};
const lineStyle: CSSProperties = {
  height: '1.5rem',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
};
const controlStyle: CSSProperties = {
  font: 'inherit',
  height: '1.5rem',
  lineHeight: '1.5rem',
  padding: '0 0.25rem',
  margin: 0,
  border: 0,
  background: 'transparent',
  color: 'inherit',
};

/** The harness's row markup, shared by every React engine. */
function RowContent({
  row,
  index,
  fixed,
  wrap = false,
}: {
  row: BenchRow;
  index: number;
  fixed: number | null;
  wrap?: boolean;
}) {
  if (wrap && fixed == null) {
    return (
      <>
        <div style={lineStyle}>
          <button type="button" data-vbench-control style={controlStyle}>
            {rowLabel(row, index)}
          </button>
        </div>
        <div style={{whiteSpace: 'normal', overflowWrap: 'anywhere'}}>
          {wrapText(row)}
        </div>
        {row.extra > 0 ? <div style={{height: row.extra}} /> : null}
      </>
    );
  }
  const lines = [];
  for (let i = 1; i < row.lines; i++) {
    lines.push(
      <div key={i} style={lineStyle}>
        line {i + 1} of {row.lines}
      </div>,
    );
  }
  return (
    <>
      <div style={lineStyle}>
        <button type="button" data-vbench-control style={controlStyle}>
          {rowLabel(row, index)}
        </button>
      </div>
      {fixed == null ? lines : null}
      {row.extra > 0 ? <div style={{height: row.extra}} /> : null}
    </>
  );
}

function rowProps(
  row: BenchRow,
  index: number,
  count: number,
  fixed: number | null,
) {
  return {
    'data-vbench-key': row.key,
    role: 'listitem',
    'aria-posinset': index + 1,
    'aria-setsize': count,
    style: {...rowStyle, ...(fixed != null ? {height: fixed} : null)},
  };
}

/**
 * Re-renders on scroll. With a range key (A1 direct placement), it
 * re-renders only when the window's row range changes: positions are
 * written to the rows without React.
 */
function useScrollTick(
  scroller: HTMLElement | null,
  rangeKey: React.RefObject<(() => string) | null> | null = null,
) {
  const [, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const target: HTMLElement | Window = scroller ?? window;
    let last = rangeKey?.current?.() ?? '';
    const onScroll = () => {
      if (rangeKey?.current) {
        const next = rangeKey.current();
        if (next === last) {
          return;
        }
        last = next;
      }
      tick();
    };
    target.addEventListener('scroll', onScroll, {passive: true});
    window.addEventListener('resize', tick);
    return () => {
      target.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', tick);
    };
  }, [scroller, rangeKey]);
}

interface EngineProps {
  store: BenchStore;
  params: BenchParams;
  scroller: HTMLElement | null;
}

// ----------------------------------------------------------------------------
// Candidate 4: prefix-sum tree with measured sizes, rendered by React.

function FenwickList({store, params, scroller}: EngineProps) {
  const version = useSyncExternalStore(store.subscribe, store.getVersion);
  const isDirect = params.placement === 'direct';
  const rangeKeyRef = useRef<(() => string) | null>(null);
  useScrollTick(scroller, isDirect ? rangeKeyRef : null);
  const listRef = useRef<HTMLDivElement>(null);
  const nodesRef = useRef(new Map<number, HTMLElement>());
  const renderedRangeRef = useRef('');
  const estimate = 5.5 * 1.5 * remPx();
  const modelRef = useRef<FenwickOffsets | null>(null);
  const keysRef = useRef<string[]>([]);
  if (modelRef.current == null) {
    modelRef.current = new FenwickOffsets(
      store.rows.length,
      params.fixed ?? estimate,
    );
    keysRef.current = store.rows.map(r => r.key);
  }
  const model = modelRef.current;
  const [, remeasured] = useReducer((x: number) => x + 1, 0);
  const pendingScroll = useRef(0);

  // Reconcile inserts and appends with the model, keeping the anchor still.
  const rows = store.rows;
  if (keysRef.current.length !== rows.length) {
    const firstOld = keysRef.current[0];
    const insertedAbove =
      firstOld == null ? 0 : rows.findIndex(r => r.key === firstOld);
    const geometry = readGeometry(scroller, listRef.current);
    if (insertedAbove > 0) {
      model.insert(0, insertedAbove);
      if (store.anchorMode !== 'end') {
        pendingScroll.current += insertedAbove * (params.fixed ?? estimate);
      }
    }
    const appended =
      rows.length - keysRef.current.length - Math.max(0, insertedAbove);
    if (appended > 0) {
      model.insert(model.count, appended);
    }
    keysRef.current = rows.map(r => r.key);
    void geometry;
  }

  const geometry = readGeometry(scroller, listRef.current);
  const top = Math.max(
    0,
    geometry.scrollTop - geometry.startOffset - OVERSCAN_PX,
  );
  const bottom =
    geometry.scrollTop - geometry.startOffset + geometry.viewport + OVERSCAN_PX;
  const start = model.indexAt(top);
  let end = start;
  while (end < rows.length && model.offsetOf(end) < bottom) {
    end++;
  }
  renderedRangeRef.current = `${start}:${end}`;
  rangeKeyRef.current = () => {
    const g = readGeometry(scroller, listRef.current);
    const t = Math.max(0, g.scrollTop - g.startOffset - OVERSCAN_PX);
    const b = g.scrollTop - g.startOffset + g.viewport + OVERSCAN_PX;
    const s0 = model.indexAt(t);
    let e0 = s0;
    while (e0 < store.rows.length && model.offsetOf(e0) < b) {
      e0++;
    }
    return `${s0}:${e0}`;
  };
  const focusKey = document.activeElement
    ?.closest('[data-vbench-key]')
    ?.getAttribute('data-vbench-key');
  const focusIndex = focusKey ? store.indexOf(focusKey) : -1;

  const observer = useMemo(
    () =>
      new ResizeObserver(entries => {
        const g = readGeometry(scroller, listRef.current);
        const anchor = anchorIndex(store, model, g);
        let correction = 0;
        for (const entry of entries) {
          const el = entry.target as HTMLElement;
          const index = store.indexOf(el.dataset.vbenchKey ?? '');
          if (index < 0) {
            continue;
          }
          const size = entry.borderBoxSize[0]?.blockSize ?? el.offsetHeight;
          // A row that left the page reports a zero size; it keeps its last
          // measured size.
          if (!el.isConnected || size <= 0) {
            continue;
          }
          const delta = model.set(index, size);
          if (delta !== 0 && index < anchor && store.anchorMode !== 'end') {
            correction += delta;
          }
        }
        if (isDirect) {
          // Positions go straight to the rows; React renders only when the
          // window's row range changes.
          for (const [i, el] of nodesRef.current) {
            if (el.isConnected) {
              el.style.transform = `translateY(${model.offsetOf(i)}px)`;
            }
          }
          if (listRef.current) {
            listRef.current.style.height = `${model.total()}px`;
          }
          if (correction !== 0) {
            scrollBy(scroller, correction);
          }
          const key = rangeKeyRef.current?.();
          if (key !== renderedRangeRef.current) {
            remeasured();
          }
          return;
        }
        pendingScroll.current += correction;
        remeasured();
      }),
    [model, scroller, store, isDirect],
  );
  useEffect(() => () => observer.disconnect(), [observer]);

  useLayoutEffect(() => {
    if (pendingScroll.current !== 0) {
      scrollBy(scroller, pendingScroll.current);
      pendingScroll.current = 0;
    }
    if (store.anchorMode === 'end') {
      if (scroller) {
        scroller.scrollTop = scroller.scrollHeight;
      } else {
        window.scrollTo(0, document.documentElement.scrollHeight);
      }
    }
  });

  const indexes: number[] = [];
  for (let i = start; i < end; i++) {
    indexes.push(i);
  }
  if (focusIndex >= 0 && (focusIndex < start || focusIndex >= end)) {
    indexes.push(focusIndex);
  }

  return (
    <div
      ref={listRef}
      role="list"
      style={{position: 'relative', height: model.total()}}
      data-version={version}>
      {indexes.map(i => {
        const row = rows[i];
        if (!row) {
          return null;
        }
        return (
          <div
            key={row.key}
            {...rowProps(row, i, rows.length, params.fixed)}
            ref={el => {
              if (el) {
                observer.observe(el);
                nodesRef.current.set(i, el);
              } else {
                nodesRef.current.delete(i);
              }
            }}
            style={{
              ...rowProps(row, i, rows.length, params.fixed).style,
              position: 'absolute',
              left: 0,
              right: 0,
              top: 0,
              transform: `translateY(${model.offsetOf(i)}px)`,
            }}>
            <RowContent
              row={row}
              index={i}
              fixed={params.fixed}
              wrap={params.wrap}
            />
          </div>
        );
      })}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Candidate 1: Table's listWindow (fixed row pitch).

function ListWindowList({store, params, scroller}: EngineProps) {
  useSyncExternalStore(store.subscribe, store.getVersion);
  const rangeKeyRef = useRef<(() => string) | null>(null);
  useScrollTick(scroller, params.placement === 'direct' ? rangeKeyRef : null);
  const listRef = useRef<HTMLDivElement>(null);
  const rowHeight = params.fixed ?? 48;
  const rows = store.rows;
  const lastFirst = useRef<string | undefined>(rows[0]?.key);
  const pendingScroll = useRef(0);
  if (lastFirst.current !== rows[0]?.key) {
    const inserted = rows.findIndex(r => r.key === lastFirst.current);
    if (inserted > 0 && store.anchorMode !== 'end') {
      pendingScroll.current += inserted * rowHeight;
    }
    lastFirst.current = rows[0]?.key;
  }
  const geometry = readGeometry(scroller, listRef.current);
  const focusKey = document.activeElement
    ?.closest('[data-vbench-key]')
    ?.getAttribute('data-vbench-key');
  const focusIndex = focusKey ? store.indexOf(focusKey) : -1;
  const plan = calculateListWindow({
    rowCount: rows.length,
    rowHeight,
    viewportHeight: Math.max(1, geometry.viewport),
    scrollTop: Math.max(0, geometry.scrollTop - geometry.startOffset),
    startOffset: 0,
    isMeasured: true,
    ...(focusIndex >= 0 ? {focusIndex} : null),
  });
  useLayoutEffect(() => {
    if (pendingScroll.current !== 0) {
      scrollBy(scroller, pendingScroll.current);
      pendingScroll.current = 0;
    }
    if (store.anchorMode === 'end') {
      if (scroller) {
        scroller.scrollTop = scroller.scrollHeight;
      } else {
        window.scrollTo(0, document.documentElement.scrollHeight);
      }
    }
  });
  rangeKeyRef.current = () => {
    const g = readGeometry(scroller, listRef.current);
    const p = calculateListWindow({
      rowCount: store.rows.length,
      rowHeight,
      viewportHeight: Math.max(1, g.viewport),
      scrollTop: Math.max(0, g.scrollTop - g.startOffset),
      startOffset: 0,
      isMeasured: true,
    });
    return `${p?.start ?? 0}:${p?.end ?? 0}`;
  };
  const indexes: number[] = [];
  for (const segment of plan?.segments ?? []) {
    if (segment.type === 'rows') {
      for (let i = segment.start; i < segment.end; i++) {
        indexes.push(i);
      }
    }
  }
  return (
    <div
      ref={listRef}
      role="list"
      style={{position: 'relative', height: rows.length * rowHeight}}>
      {indexes.map(i => {
        const row = rows[i];
        if (!row) {
          return null;
        }
        const props = rowProps(row, i, rows.length, rowHeight);
        return (
          <div
            key={row.key}
            {...props}
            style={{
              ...props.style,
              position: 'absolute',
              left: 0,
              right: 0,
              top: 0,
              transform: `translateY(${i * rowHeight}px)`,
            }}>
            <RowContent row={row} index={i} fixed={rowHeight} />
          </div>
        );
      })}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Candidate 3: TanStack Virtual's measured-offset cache (the library itself).

function TanstackList({store, params, scroller}: EngineProps) {
  useSyncExternalStore(store.subscribe, store.getVersion);
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const listRef = useRef<HTMLDivElement>(null);
  const rows = store.rows;
  const estimate = params.fixed ?? 5.5 * 1.5 * remPx();
  const isPage = scroller == null;
  const focusIndexRef = useRef(-1);
  const lastKeyRef = useRef('');
  const options = {
    count: rows.length,
    getScrollElement: () => (isPage ? window : scroller),
    estimateSize: () => estimate,
    getItemKey: (index: number) => rows[index]?.key ?? index,
    overscan: 6,
    scrollMargin: isPage ? HEADER_PX : 0,
    anchorTo:
      store.anchorMode === 'end' ? ('end' as const) : ('start' as const),
    followOnAppend: store.anchorMode === 'end',
    rangeExtractor: (range: {
      startIndex: number;
      endIndex: number;
      overscan: number;
      count: number;
    }) => {
      const start = Math.max(range.startIndex - range.overscan, 0);
      const end = Math.min(range.endIndex + range.overscan, range.count - 1);
      const out: number[] = [];
      for (let i = start; i <= end; i++) {
        out.push(i);
      }
      const f = focusIndexRef.current;
      if (f >= 0 && f < range.count && (f < start || f > end)) {
        out.push(f);
      }
      return out;
    },
    scrollToFn: (isPage ? windowScroll : elementScroll) as never,
    observeElementRect: (isPage
      ? observeWindowRect
      : observeElementRect) as never,
    observeElementOffset: (isPage
      ? observeWindowOffset
      : observeElementOffset) as never,
    measureElement: measureElement as never,
    onChange: (instance: Virtualizer<Element | Window, Element>) => {
      if (params.placement !== 'direct') {
        rerender();
        return;
      }
      // Direct placement: while the window's rows stay the same, write each
      // row's position to its element; React renders only on a range change.
      const items = instance.getVirtualItems();
      const key = `${items[0]?.index ?? 0}:${items[items.length - 1]?.index ?? 0}:${items.length}`;
      if (key !== lastKeyRef.current) {
        lastKeyRef.current = key;
        rerender();
        return;
      }
      for (const item of items) {
        const el = instance.elementsCache.get(item.key) as
          HTMLElement | undefined;
        if (el) {
          el.style.transform = `translateY(${item.start - (isPage ? HEADER_PX : 0)}px)`;
        }
      }
      if (listRef.current) {
        listRef.current.style.height = `${instance.getTotalSize()}px`;
      }
    },
  };
  const ref = useRef<Virtualizer<Element | Window, Element> | null>(null);
  if (ref.current == null) {
    ref.current = new Virtualizer(options as never);
  }
  const v = ref.current;
  v.setOptions({...v.options, ...options} as never);
  useLayoutEffect(() => v._didMount(), [v]);
  useLayoutEffect(() => {
    v._willUpdate();
  });
  const focusKey = document.activeElement
    ?.closest('[data-vbench-key]')
    ?.getAttribute('data-vbench-key');
  focusIndexRef.current = focusKey ? store.indexOf(focusKey) : -1;
  const items = v.getVirtualItems();
  return (
    <div
      ref={listRef}
      role="list"
      style={{position: 'relative', height: v.getTotalSize()}}>
      {items.map(item => {
        const row = rows[item.index];
        if (!row) {
          return null;
        }
        const props = rowProps(row, item.index, rows.length, params.fixed);
        return (
          <div
            key={row.key}
            data-index={item.index}
            ref={v.measureElement}
            {...props}
            style={{
              ...props.style,
              position: 'absolute',
              left: 0,
              right: 0,
              top: 0,
              transform: `translateY(${item.start - (isPage ? HEADER_PX : 0)}px)`,
            }}>
            <RowContent
              row={row}
              index={item.index}
              fixed={params.fixed}
              wrap={params.wrap}
            />
          </div>
        );
      })}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Candidate 2: ChatVirtualizer (#5461), which owns its own rendering frame.

function ChatList({store, params, scroller}: EngineProps) {
  useSyncExternalStore(store.subscribe, store.getVersion);
  const handle = useRef<ChatVirtualizerHandle | null>(null);
  const rows = store.rows;
  useEffect(() => {
    benchHandles.chat = handle.current;
  });
  const element = scroller ?? (document.scrollingElement as HTMLElement | null);
  return (
    <div role="list">
      <ChatVirtualizer
        data={rows}
        getRowKey={(row: BenchRow) => row.key}
        renderItem={({item: row, index}: {item: BenchRow; index: number}) => {
          return (
            <div {...rowProps(row, index, rows.length, params.fixed)}>
              <RowContent
                row={row}
                index={index}
                fixed={params.fixed}
                wrap={params.wrap}
              />
            </div>
          );
        }}
        estimatedItemSize={params.fixed ?? 5.5 * 1.5 * remPx()}
        scrollElement={element}
        handleRef={handle}
      />
    </div>
  );
}

const benchHandles: {chat: ChatVirtualizerHandle | null} = {chat: null};

// ----------------------------------------------------------------------------
// Candidate 5: outside-React DOM recycling over the prefix-sum model. A fixed
// pool of row nodes is reused as rows scroll and positioned with transforms.

function RecycleList({store, params, scroller}: EngineProps) {
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) {
      return;
    }
    return mountRecycler({
      list,
      scroller,
      store,
      fixed: params.fixed,
      estimate: params.fixed ?? 5.5 * 1.5 * remPx(),
      wrap: params.wrap,
    });
  }, [params.fixed, params.wrap, scroller, store]);
  return <div ref={listRef} role="list" style={{position: 'relative'}} />;
}

// ----------------------------------------------------------------------------
// Ground truth: every row in flow.

function Unwindowed({store, params}: EngineProps) {
  useSyncExternalStore(store.subscribe, store.getVersion);
  const rows = store.rows;
  return (
    <div role="list">
      {rows.map((row, i) => (
        <div key={row.key} {...rowProps(row, i, rows.length, params.fixed)}>
          <RowContent
            row={row}
            index={i}
            fixed={params.fixed}
            wrap={params.wrap}
          />
        </div>
      ))}
    </div>
  );
}

const ENGINES: Record<EngineId, (props: EngineProps) => React.ReactNode> = {
  listwindow: ListWindowList,
  chat: ChatList,
  tanstack: TanstackList,
  fenwick: FenwickList,
  recycle: RecycleList,
};

function rowElement(key: string): HTMLElement | null {
  return document.querySelector(`[data-vbench-key="${CSS.escape(key)}"]`);
}

function installControls(
  store: BenchStore,
  params: BenchParams,
  scroller: () => HTMLElement | null,
) {
  const viewportTop = () => scroller()?.getBoundingClientRect().top ?? 0;
  const api = {
    engine: params.engine,
    count: () => store.rows.length,
    keyAt: (index: number) => store.rows[index]?.key ?? null,
    append: (count: number) => store.append(count),
    insertAbove: (count: number) => store.insertAbove(count),
    resize: (key: string, delta: number) => store.resize(key, delta),
    /** S12: the list's width in px (null restores the full width). */
    setWidth: (px: number | null) => {
      document.body.style.width = px == null ? '' : `${px}px`;
    },
    setAnchor: (mode: AnchorMode, key: string | null = null) => {
      store.anchorMode = mode;
      store.anchorKey = key;
      // ChatVirtualizer keeps its own anchor: hold an item through its own
      // API, as every other adapter honours the harness anchor. With
      // first-visible it already holds the row at the viewport top.
      if (
        params.engine === 'chat' &&
        benchHandles.chat &&
        mode === 'item' &&
        key
      ) {
        const row = rowElement(key);
        const offset = row
          ? row.getBoundingClientRect().top - viewportTop()
          : 0;
        benchHandles.chat.anchorToKey(key, offset);
      }
    },
    /** The row crossing the viewport top (A14), else the first row below it. */
    firstVisibleKey: () => {
      const top = viewportTop();
      let best: {key: string; top: number} | null = null;
      for (const el of document.querySelectorAll<HTMLElement>(
        '[data-vbench-key]',
      )) {
        if (el.offsetParent == null && el.style.display === 'none') {
          continue;
        }
        const rect = el.getBoundingClientRect();
        const t = rect.top - top;
        if (t <= 0.5 && rect.bottom - top > 0.5) {
          return el.dataset.vbenchKey ?? null;
        }
        if (t >= -0.5 && (best == null || t < best.top)) {
          best = {key: el.dataset.vbenchKey ?? '', top: t};
        }
      }
      return best?.key ?? null;
    },
    /** Where the anchored row sits in the viewport, px; end mode: distance from the end. */
    anchorTop: () => {
      if (store.anchorMode === 'end') {
        const el = scroller();
        if (el) {
          return el.scrollHeight - el.scrollTop - el.clientHeight;
        }
        return (
          document.documentElement.scrollHeight -
          window.scrollY -
          window.innerHeight
        );
      }
      const key = store.anchorKey;
      if (key == null) {
        return null;
      }
      const row = rowElement(key);
      if (!row || row.style.display === 'none') {
        return null;
      }
      return row.getBoundingClientRect().top - viewportTop();
    },
    scrollToKey: (key: string) => {
      const index = store.indexOf(key);
      if (index < 0) {
        return;
      }
      if (params.engine === 'chat' && benchHandles.chat) {
        benchHandles.chat.anchorToKey(key, 0);
        return;
      }
      // Engines without a scroll-to-key: scroll by the row's estimated offset,
      // then correct with its rect once it renders.
      const el = scroller();
      const correct = (tries: number) => {
        const row = rowElement(key);
        if (row && row.style.display !== 'none') {
          const delta = row.getBoundingClientRect().top - viewportTop();
          scrollBy(el, delta);
          if (Math.abs(delta) > 0.5 && tries > 0) {
            requestAnimationFrame(() => correct(tries - 1));
          }
          return;
        }
        if (tries > 0) {
          requestAnimationFrame(() => correct(tries - 1));
        }
      };
      const total = el
        ? el.scrollHeight
        : document.documentElement.scrollHeight;
      const estimateTop = (index / Math.max(1, store.rows.length)) * total;
      if (el) {
        el.scrollTop = estimateTop;
      } else {
        window.scrollTo(0, estimateTop);
      }
      requestAnimationFrame(() => correct(30));
    },
    focusKey: (key: string) => {
      rowElement(key)
        ?.querySelector<HTMLElement>('[data-vbench-control]')
        ?.focus();
    },
    focusedKey: () =>
      document.activeElement
        ?.closest('[data-vbench-key]')
        ?.getAttribute('data-vbench-key') ?? null,
    focusedPosition: () => {
      const row = document.activeElement?.closest('[data-vbench-key]');
      return row ? Number(row.getAttribute('aria-posinset')) : null;
    },
    expectedPosition: (key: string) => store.indexOf(key) + 1,
  };
  (window as unknown as {__vbench: typeof api}).__vbench = api;
}

export default function VbenchEnginesPage() {
  const [ready, setReady] = useState(false);
  const params = useMemo(
    () => (typeof window === 'undefined' ? null : readParams()),
    [],
  );
  const store = useMemo(
    () => (params ? new BenchStore(params.n, params.seed) : null),
    [params],
  );
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!params) {
      return;
    }
    document.documentElement.style.fontSize =
      params.text === 100 ? '' : `${params.text}%`;
    document.documentElement.style.overflowAnchor = 'none';
    document.body.style.margin = '0';
    setReady(true);
  }, [params]);

  useEffect(() => {
    if (!ready || !params || !store) {
      return;
    }
    store.anchorMode = params.anchor;
    installControls(store, params, () => scrollerRef.current);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        document.documentElement.dataset.vbench = 'ready';
      }),
    );
  }, [ready, params, store]);

  if (!ready || !params || !store) {
    return null;
  }
  const Engine =
    params.mode === 'unwindowed' ? Unwindowed : ENGINES[params.engine];
  const header = (
    <header
      style={{
        height: HEADER_PX,
        boxSizing: 'border-box',
        padding: 12,
        font: '14px system-ui',
      }}>
      vbench · {params.engine} · {params.mode} · {params.n} rows · text{' '}
      {params.text}% · {params.scroller}
    </header>
  );
  if (params.scroller === 'page') {
    return (
      <>
        {header}
        <Engine store={store} params={params} scroller={null} />
      </>
    );
  }
  return (
    <>
      <div
        data-vbench-scroller
        ref={el => {
          scrollerRef.current = el;
          if (el !== scroller) {
            setScroller(el);
          }
        }}
        style={{
          height: '100vh',
          overflowY: 'auto',
          overflowAnchor: 'none',
          position: 'relative',
        }}>
        {scroller ? (
          <Engine store={store} params={params} scroller={scroller} />
        ) : null}
      </div>
    </>
  );
}
