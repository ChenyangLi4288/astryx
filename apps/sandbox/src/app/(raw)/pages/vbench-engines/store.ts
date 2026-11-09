// Copyright (c) Meta Platforms, Inc. and affiliates.

/**
 * @file store.ts
 * @input `?n=`, `?seed=`, `?fixed=` from the vbench engines page
 * @output The seeded row data, its mutations (append, insert above, resize)
 *   and the `window.__vbench` control surface the driver calls
 * @position Shared by every engine adapter on the bench page, so each engine
 *   sees the same data and the same mutations. Bench-only; never merged.
 */

export interface BenchRow {
  key: string;
  /** Text lines; the row is lines × 1.5rem tall plus `extra` px. */
  lines: number;
  /** Extra px added by a scripted resize. */
  extra: number;
}

export type AnchorMode = 'first-visible' | 'end' | 'item';

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

/** 1–10 lines: 24–240 px at 16 px text. */
function makeRows(
  count: number,
  random: () => number,
  prefix: string,
): BenchRow[] {
  return Array.from({length: count}, (_, i) => ({
    key: `${prefix}${i}`,
    lines: 1 + Math.floor(random() * 10),
    extra: 0,
  }));
}

type Listener = () => void;

export class BenchStore {
  rows: BenchRow[];
  version = 0;
  anchorMode: AnchorMode = 'first-visible';
  anchorKey: string | null = null;
  private random: () => number;
  private appended = 0;
  private inserted = 0;
  private listeners = new Set<Listener>();

  constructor(count: number, seed: number) {
    this.random = mulberry32(seed);
    this.rows = makeRows(count, this.random, 'r');
  }

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = () => this.version;

  private emit() {
    this.version += 1;
    for (const listener of this.listeners) {
      listener();
    }
  }

  append(count: number) {
    const added = makeRows(count, this.random, `a${this.appended}-`);
    this.appended += 1;
    this.rows = [...this.rows, ...added];
    this.emit();
  }

  insertAbove(count: number, at = 0) {
    const added = makeRows(count, this.random, `i${this.inserted}-`);
    this.inserted += 1;
    this.rows = [...this.rows.slice(0, at), ...added, ...this.rows.slice(at)];
    this.emit();
  }

  resize(key: string, delta: number) {
    this.rows = this.rows.map(row =>
      row.key === key ? {...row, extra: Math.max(0, row.extra + delta)} : row,
    );
    this.emit();
  }

  indexOf(key: string): number {
    return this.rows.findIndex(row => row.key === key);
  }
}

/** The text a row shows; the first line also holds a focusable control. */
export function rowLabel(row: BenchRow, index: number): string {
  return `Row ${index + 1} · ${row.key}`;
}
