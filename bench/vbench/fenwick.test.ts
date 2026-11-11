// Copyright (c) Meta Platforms, Inc. and affiliates.

import {describe, expect, it} from 'vitest';
import {FenwickOffsets} from '../../apps/sandbox/src/app/(raw)/pages/vbench-engines/fenwick';

describe('FenwickOffsets', () => {
  it('sums sizes, finds rows by offset, and follows measurement and inserts', () => {
    const m = new FenwickOffsets(5, 10);
    expect(m.total()).toBe(50);
    expect(m.offsetOf(3)).toBe(30);
    expect(m.indexAt(25)).toBe(2);
    expect(m.set(1, 30)).toBe(20);
    expect(m.offsetOf(2)).toBe(40);
    expect(m.indexAt(39)).toBe(1);
    expect(m.indexAt(40)).toBe(2);
    m.insert(0, 2);
    expect(m.count).toBe(7);
    expect(m.offsetOf(4)).toBe(10 + 10 + 10 + 30);
    expect(m.total()).toBe(90);
    m.insert(7, 1);
    expect(m.total()).toBe(100);
  });

  it('matches a linear sum over many random sizes', () => {
    const n = 1000;
    const m = new FenwickOffsets(n, 50);
    const sizes = new Array(n).fill(50);
    for (let i = 0; i < 2000; i++) {
      const index = (i * 7919) % n;
      const size = 24 + ((i * 31) % 217);
      sizes[index] = size;
      m.set(index, size);
    }
    let sum = 0;
    for (let i = 0; i < n; i++) {
      expect(m.offsetOf(i)).toBe(sum);
      expect(m.indexAt(sum)).toBe(i);
      sum += sizes[i];
    }
  });
});
