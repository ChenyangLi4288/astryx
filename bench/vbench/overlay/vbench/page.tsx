// Copyright (c) Meta Platforms, Inc. and affiliates.

'use client';

/**
 * @file page.tsx
 * @input `?engine=` (a component case: table), `?n=` rows, `?seed=`,
 *   `?text=` (100 | 200), `?mode=` (windowed | unwindowed)
 * @output A component's long list through its public API only, with each
 *   row's key in a `data-vbench-key` element inside the row and the
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
  const virtualization = useTableRowsVirtualization({
    rowHeight: ROW_HEIGHT,
    viewportHeight: VIEWPORT,
  });
  const columns = useMemo(
    () => [
      {
        key: 'name',
        header: 'Product',
        renderCell: (row: Row) => (
          <span data-vbench-key={row.id}>{row.name}</span>
        ),
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
      // Table rows have one exact height; a resize does not apply.
      resize: () => {},
      setAnchor: (mode: string, key: string | null = null) => {
        anchorMode = mode;
        anchorKey = key;
      },
      firstVisibleKey: () => {
        const top = viewportTop();
        let best: {key: string; top: number} | null = null;
        for (const keyed of document.querySelectorAll<HTMLElement>(
          '[data-vbench-key]',
        )) {
          const row = keyed.closest('tr') ?? keyed;
          const t = row.getBoundingClientRect().top - top;
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
          ?.querySelector('[data-vbench-key]')
          ?.getAttribute('data-vbench-key') ?? null,
      focusedPosition: () => null,
      expectedPosition: (key: string) =>
        current.rows.findIndex(r => r.id === key) + 1,
    };
    (window as unknown as {__vbench: typeof api}).__vbench = api;
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
        <TableCase rows={rows} windowed={false} />
      </div>
    );
  }
  return <TableCase rows={rows} windowed />;
}
