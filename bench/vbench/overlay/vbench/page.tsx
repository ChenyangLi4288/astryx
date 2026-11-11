// Copyright (c) Meta Platforms, Inc. and affiliates.

'use client';

/**
 * @file page.tsx
 * @input `?engine=` (a component case: table), `?n=` rows, `?seed=`,
 *   `?text=` (100 | 200), `?mode=` (windowed | unwindowed)
 * @output A component's long list through its public API only, with each
 *   row's key in a `data-vbench-key` attribute on its <tr> and the
 *   `window.__vbench` controls of the vbench row contract
 * @position Overlay page of bench/vbench: the compare workflow copies it into
 *   the before and after trees, so the same page measures both. Public API
 *   only, so it builds on any ref with that API. Bench-only; never merged.
 */

import {useEffect, useLayoutEffect, useMemo, useState} from 'react';
import {Table, useTableRowsVirtualization} from '@astryxdesign/core';

interface Row extends Record<string, unknown> {
  id: string;
  name: string;
  status: string;
  amount: string;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STATUSES = ['Available', 'Backordered', 'Discontinued', 'In review'];

function makeRows(count: number, random: () => number, prefix: string): Row[] {
  return Array.from({length: count}, (_, i) => ({
    id: `${prefix}${i}`,
    name: `Product ${prefix}${i + 1}`,
    status: STATUSES[Math.floor(random() * STATUSES.length)] ?? 'Available',
    amount: `$${(random() * 1000).toFixed(2)}`,
  }));
}

const VIEWPORT = 600;
const ROW_HEIGHT = 48;
// The unwindowed render is the ground truth, so its rows take the same pitch
// as the windowed rows.
const ROW_PITCH_CSS = `tbody tr { height: ${ROW_HEIGHT}px; box-sizing: border-box; }`;

function scrollableAncestor(el: Element | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const style = getComputedStyle(node);
    if (
      /(auto|scroll)/.test(style.overflowY) &&
      node.scrollHeight > node.clientHeight + 1
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

function rowOf(key: string): HTMLElement | null {
  const keyed = document.querySelector(
    `[data-vbench-key="${CSS.escape(key)}"]`,
  );
  return (
    (keyed?.closest('tr') as HTMLElement | null) ??
    (keyed as HTMLElement | null)
  );
}

function TableCase({rows, windowed}: {rows: Row[]; windowed: boolean}) {
  // Both names: refs before the viewport rename read `viewportHeight`,
  // refs after it read `initialViewportHeight`; each ignores the other.
  const virtualization = useTableRowsVirtualization({
    rowHeight: ROW_HEIGHT,
    viewportHeight: VIEWPORT,
    initialViewportHeight: VIEWPORT,
  } as unknown as Parameters<typeof useTableRowsVirtualization>[0]);
  const columns = useMemo(
    () => [
      {
        key: 'name',
        header: 'Product',
        // No renderCell: a custom cell renderer turns Table windowing off.
      },
      {key: 'status', header: 'Status'},
      {key: 'amount', header: 'Amount'},
    ],
    [],
  );
  return (
    <Table
      data={rows}
      columns={columns as never}
      idKey="id"
      {...(windowed ? {virtualization} : null)}
      // Both trees render cells the same way: Table defaults to wrap without
      // virtualization and to truncate with it, which would make the
      // unwindowed truth's rows taller than the windowed rows.
      textOverflow="truncate"
      dividers="grid"
    />
  );
}

export default function VbenchComponentsPage() {
  const params = useMemo(() => {
    if (typeof window === 'undefined') {
      return null;
    }
    const q = new URLSearchParams(window.location.search);
    return {
      engine: q.get('engine') ?? 'table',
      n: Number(q.get('n') ?? 10000),
      seed: Number(q.get('seed') ?? 1),
      text: Number(q.get('text') ?? 100),
      windowed: q.get('mode') !== 'unwindowed',
    };
  }, []);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    if (!params) {
      return;
    }
    document.documentElement.style.fontSize =
      params.text === 100 ? '' : `${params.text}%`;
    document.body.style.margin = '0';
    const random = mulberry32(params.seed);
    setRows(makeRows(params.n, random, 'r'));
    let appended = 0;
    let inserted = 0;
    let anchorMode = 'first-visible';
    let anchorKey: string | null = null;
    const scroller = () =>
      document.querySelector<HTMLElement>('[data-vbench-scroller]');
    const viewportTop = () => scroller()?.getBoundingClientRect().top ?? 0;
    const current: {rows: Row[]} = {rows: []};
    const api = {
      count: () => current.rows.length,
      keyAt: (i: number) => current.rows[i]?.id ?? null,
      append: (count: number) =>
        setRows(prev => {
          const next = [
            ...(prev ?? []),
            ...makeRows(count, random, `a${appended++}-`),
          ];
          current.rows = next;
          return next;
        }),
      insertAbove: (count: number) =>
        setRows(prev => {
          const next = [
            ...makeRows(count, random, `i${inserted++}-`),
            ...(prev ?? []),
          ];
          current.rows = next;
          return next;
        }),
      // One row grows: its name gets wrapping words, about one line per 20 px.
      resize: (key: string, delta: number) =>
        setRows(prev => {
          const words = Math.max(1, Math.ceil(delta / 20)) * 8;
          const next = (prev ?? []).map(r =>
            r.id === key
              ? {
                  ...r,
                  name: `${r.name} ${Array.from({length: words}, (_, i) => `word${i}`).join(' ')}`,
                }
              : r,
          );
          current.rows = next;
          return next;
        }),
      /** The list's width in px (null restores the full width). */
      setWidth: (px: number | null) => {
        document.body.style.width = px == null ? '' : `${px}px`;
      },
      setAnchor: (mode: string, key: string | null = null) => {
        anchorMode = mode;
        anchorKey = key;
      },
      /** The row crossing the viewport top (A14), else the first row below it. */
      firstVisibleKey: () => {
        const top = viewportTop();
        let best: {key: string; top: number} | null = null;
        for (const keyed of document.querySelectorAll<HTMLElement>(
          '[data-vbench-key]',
        )) {
          const rect = (keyed.closest('tr') ?? keyed).getBoundingClientRect();
          const t = rect.top - top;
          if (t <= 0.5 && rect.bottom - top > 0.5) {
            return keyed.dataset.vbenchKey ?? null;
          }
          if (t >= -0.5 && (best == null || t < best.top)) {
            best = {key: keyed.dataset.vbenchKey ?? '', top: t};
          }
        }
        return best?.key ?? null;
      },
      anchorTop: () => {
        if (anchorMode === 'end') {
          const el = scroller();
          return el ? el.scrollHeight - el.scrollTop - el.clientHeight : null;
        }
        if (anchorKey == null) {
          return null;
        }
        const row = rowOf(anchorKey);
        return row ? row.getBoundingClientRect().top - viewportTop() : null;
      },
      scrollToKey: (key: string) => {
        const el = scroller();
        const index = current.rows.findIndex(r => r.id === key);
        if (!el || index < 0) {
          return;
        }
        el.scrollTop = index * ROW_HEIGHT;
      },
      focusKey: (key: string) =>
        rowOf(key)?.querySelector<HTMLElement>('a,button,[tabindex]')?.focus(),
      focusedKey: () =>
        document.activeElement
          ?.closest('tr')
          ?.getAttribute('data-vbench-key') ?? null,
      focusedPosition: () => null,
      expectedPosition: (key: string) =>
        current.rows.findIndex(r => r.id === key) + 1,
    };
    (window as unknown as {__vbench: typeof api}).__vbench = api;
    // The default cell renderer is kept, so each row's key is written on its
    // <tr> from the row's name as rows mount (before the next frame reads).
    const tag = () => {
      const byName = new Map(current.rows.map(r => [r.name, r.id]));
      for (const tr of document.querySelectorAll<HTMLElement>('tbody tr')) {
        if (tr.hasAttribute('data-vbench-key')) {
          continue;
        }
        const id = byName.get(tr.querySelector('td')?.textContent ?? '');
        if (id) {
          tr.setAttribute('data-vbench-key', id);
        }
      }
    };
    new MutationObserver(tag).observe(document.body, {
      childList: true,
      subtree: true,
    });
    (window as unknown as {__vbenchRows: {rows: Row[]}}).__vbenchRows = current;
  }, [params]);

  useEffect(() => {
    if (!rows || ready) {
      return;
    }
    (window as unknown as {__vbenchRows: {rows: Row[]}}).__vbenchRows.rows =
      rows;
    // Mark the element that scrolls the rows, so the recorder reads it.
    requestAnimationFrame(() => {
      const first = document.querySelector('[data-vbench-key]');
      const scroller =
        document.querySelector('[data-vbench-scroller]') ??
        scrollableAncestor(first);
      scroller?.setAttribute('data-vbench-scroller', '');
      if (scroller instanceof HTMLElement) {
        scroller.style.overflowAnchor = 'none';
      }
      requestAnimationFrame(() => {
        document.documentElement.dataset.vbench = 'ready';
        setReady(true);
      });
    });
  }, [rows, ready]);

  if (!params || !rows) {
    return null;
  }
  if (!params.windowed) {
    return (
      <div
        data-vbench-scroller
        style={{height: VIEWPORT, overflowY: 'auto', overflowAnchor: 'none'}}>
        <style>{ROW_PITCH_CSS}</style>
        <TableCase rows={rows} windowed={false} />
      </div>
    );
  }
  // A fixed-height parent: after the viewport rename, Table takes its
  // scroll area's height from its parent.
  return (
    <div
      style={{
        height: VIEWPORT,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
      }}>
      <style>{ROW_PITCH_CSS}</style>
      <TableCase rows={rows} windowed />
    </div>
  );
}
