// Copyright (c) Meta Platforms, Inc. and affiliates.

/**
 * @file recycle.ts
 * @input A list element, its scroller (or null for the page), the bench
 *   store, and a fixed or estimated row size
 * @output Candidate 5: outside-React DOM recycling over the prefix-sum model.
 *   A fixed pool of row nodes is reused as rows scroll and positioned with
 *   transforms; a focused row keeps its node
 * @position Framework-free, so its bundle bytes are the engine alone.
 *   Bench-only; never merged.
 */

import {FenwickOffsets} from './fenwick';
import {OVERSCAN_PX, anchorIndex, readGeometry, scrollBy} from './geometry';
import {rowLabel, wrapText, type BenchRow, type BenchStore} from './store';

function fillRow(
  node: HTMLElement,
  row: BenchRow,
  index: number,
  count: number,
  fixed: number | null,
  wrap = false,
) {
  node.dataset.vbenchKey = row.key;
  node.setAttribute('aria-posinset', String(index + 1));
  node.setAttribute('aria-setsize', String(count));
  const button = node.firstElementChild
    ?.firstElementChild as HTMLElement | null;
  if (button) {
    button.textContent = rowLabel(row, index);
  }
  const body = node.children[1] as HTMLElement | undefined;
  const extra = node.children[2] as HTMLElement | undefined;
  if (body && wrap && fixed == null) {
    body.replaceChildren();
    body.style.whiteSpace = 'normal';
    body.style.overflowWrap = 'anywhere';
    body.textContent = wrapText(row);
  } else if (body) {
    const lines = fixed != null ? 0 : row.lines - 1;
    while (body.childElementCount > lines) {
      body.lastElementChild?.remove();
    }
    while (body.childElementCount < lines) {
      const line = document.createElement('div');
      Object.assign(line.style, {
        height: '1.5rem',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
      });
      body.appendChild(line);
    }
    for (let i = 0; i < lines; i++) {
      const line = body.children[i];
      if (line) {
        line.textContent = `line ${i + 2} of ${row.lines}`;
      }
    }
  }
  if (extra) {
    extra.style.height = `${row.extra}px`;
  }
}

function makeRowNode(fixed: number | null): HTMLElement {
  const node = document.createElement('div');
  node.setAttribute('role', 'listitem');
  Object.assign(node.style, {
    boxSizing: 'border-box',
    font: '1rem/1.5rem system-ui, sans-serif',
    overflow: 'hidden',
    position: 'absolute',
    left: '0',
    right: '0',
    top: '0',
    ...(fixed != null ? {height: `${fixed}px`} : null),
  });
  const first = document.createElement('div');
  Object.assign(first.style, {
    height: '1.5rem',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
  });
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.vbenchControl = '';
  Object.assign(button.style, {
    font: 'inherit',
    height: '1.5rem',
    lineHeight: '1.5rem',
    padding: '0 0.25rem',
    margin: '0',
    border: '0',
    background: 'transparent',
    color: 'inherit',
  });
  first.appendChild(button);
  node.append(
    first,
    document.createElement('div'),
    document.createElement('div'),
  );
  return node;
}

export function mountRecycler({
  list,
  scroller,
  store,
  fixed,
  estimate,
  wrap = false,
}: {
  list: HTMLElement;
  scroller: HTMLElement | null;
  store: BenchStore;
  fixed: number | null;
  estimate: number;
  wrap?: boolean;
}): () => void {
  const model = new FenwickOffsets(store.rows.length, estimate);
  let keys = store.rows.map(r => r.key);
  const pool: HTMLElement[] = [];
  const assigned = new Map<string, HTMLElement>();
  let frame = 0;

  const layout = () => {
    frame = 0;
    const rows = store.rows;
    const g = readGeometry(scroller, list);
    // Measure the rows on screen and keep the anchor still.
    const anchor = anchorIndex(store, model, g);
    let correction = 0;
    for (const [key, node] of assigned) {
      const index = store.indexOf(key);
      if (index < 0) {
        continue;
      }
      const delta = model.set(index, node.offsetHeight);
      if (delta !== 0 && index < anchor && store.anchorMode !== 'end') {
        correction += delta;
      }
    }
    list.style.height = `${model.total()}px`;
    if (correction !== 0) {
      scrollBy(scroller, correction);
    }
    if (store.anchorMode === 'end') {
      if (scroller) {
        scroller.scrollTop = scroller.scrollHeight;
      } else {
        window.scrollTo(0, document.documentElement.scrollHeight);
      }
    }
    const geometry = readGeometry(scroller, list);
    const top = Math.max(
      0,
      geometry.scrollTop - geometry.startOffset - OVERSCAN_PX,
    );
    const bottom =
      geometry.scrollTop -
      geometry.startOffset +
      geometry.viewport +
      OVERSCAN_PX;
    const start = model.indexAt(top);
    const wanted = new Set<string>();
    for (let i = start; i < rows.length && model.offsetOf(i) < bottom; i++) {
      const row = rows[i];
      if (row) {
        wanted.add(row.key);
      }
    }
    // A focused row keeps its node, so focus and its row identity stay.
    const focused = document.activeElement
      ?.closest('[data-vbench-key]')
      ?.getAttribute('data-vbench-key');
    if (focused && assigned.has(focused)) {
      wanted.add(focused);
    }
    for (const [key, node] of assigned) {
      if (!wanted.has(key)) {
        assigned.delete(key);
        node.style.display = 'none';
        pool.push(node);
      }
    }
    let remeasure = false;
    for (const key of wanted) {
      const index = store.indexOf(key);
      const row = rows[index];
      if (!row) {
        continue;
      }
      let node = assigned.get(key);
      if (!node) {
        node = pool.pop() ?? makeRowNode(fixed);
        if (!node.parentNode) {
          list.appendChild(node);
        }
        node.style.display = '';
        assigned.set(key, node);
        remeasure = true;
      }
      fillRow(node, row, index, rows.length, fixed, wrap);
      node.style.transform = `translateY(${model.offsetOf(index)}px)`;
    }
    if (remeasure) {
      for (const [key, node] of assigned) {
        const index = store.indexOf(key);
        if (index >= 0 && model.set(index, node.offsetHeight) !== 0) {
          schedule();
          break;
        }
      }
    }
  };
  const schedule = () => {
    if (frame === 0) {
      frame = requestAnimationFrame(layout);
    }
  };
  const onStore = () => {
    const rows = store.rows;
    const firstOld = keys[0];
    const insertedAbove =
      firstOld == null ? 0 : rows.findIndex(r => r.key === firstOld);
    if (insertedAbove > 0) {
      model.insert(0, insertedAbove);
      if (store.anchorMode !== 'end') {
        scrollBy(scroller, insertedAbove * estimate);
      }
    }
    const appended = rows.length - keys.length - Math.max(0, insertedAbove);
    if (appended > 0) {
      model.insert(model.count, appended);
    }
    keys = rows.map(r => r.key);
    layout();
  };
  const target: HTMLElement | Window = scroller ?? window;
  target.addEventListener('scroll', schedule, {passive: true});
  window.addEventListener('resize', schedule);
  // A width change re-wraps rows without a scroll or a window resize.
  const widthObserver = new ResizeObserver(schedule);
  widthObserver.observe(list);
  const unsubscribe = store.subscribe(onStore);
  layout();
  return () => {
    target.removeEventListener('scroll', schedule);
    window.removeEventListener('resize', schedule);
    unsubscribe();
    widthObserver.disconnect();
    cancelAnimationFrame(frame);
    list.replaceChildren();
  };
}
