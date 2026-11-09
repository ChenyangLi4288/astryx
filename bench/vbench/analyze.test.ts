// Copyright (c) Meta Platforms, Inc. and affiliates.

import {describe, expect, it} from 'vitest';
import {
  anchorDrift,
  checkFrames,
  frameStats,
  uncovered,
  type Frame,
  type GroundTruth,
} from './analyze';

function truthOf(heights: number[]): GroundTruth {
  const truth: GroundTruth = new Map();
  let top = 0;
  heights.forEach((h, i) => {
    truth.set(String(i), {top, bottom: top + h});
    top += h;
  });
  return truth;
}

function frame(
  rows: Array<[string, number, number]>,
  extra: Partial<Frame> = {},
): Frame {
  return {
    t: 0,
    scroll: 0,
    viewport: 100,
    input: false,
    rows: rows.map(([key, top, bottom]) => ({key, top, bottom})),
    ...extra,
  };
}

describe('checkFrames', () => {
  const truth = truthOf([40, 40, 40, 40]);

  it('passes rows that match the ground truth', () => {
    const report = checkFrames(
      [
        frame([
          ['0', 0, 40],
          ['1', 40, 80],
          ['2', 80, 120],
        ]),
      ],
      truth,
    );
    expect(report.violations).toEqual([]);
    expect(report.blankFrames).toBe(0);
  });

  it('reports an overlap, a gap and a misplaced row', () => {
    const overlap = checkFrames(
      [
        frame([
          ['0', 0, 40],
          ['1', 30, 70],
          ['2', 80, 120],
        ]),
      ],
      truth,
    );
    expect(overlap.overlapFrames).toBe(1);
    expect(overlap.positionFrames).toBe(1);
    const gap = checkFrames(
      [
        frame([
          ['0', 0, 40],
          ['1', 45, 85],
          ['2', 85, 125],
        ]),
      ],
      truth,
    );
    expect(gap.gapFrames).toBe(1);
    expect(gap.maxPositionErrorPx).toBe(5);
  });

  it('allows 1 px of error', () => {
    const report = checkFrames(
      [
        frame([
          ['0', 0, 40],
          ['1', 40.8, 80.8],
          ['2', 80.8, 120],
        ]),
      ],
      truth,
    );
    expect(report.violations).toEqual([]);
  });

  it('does not count a gap between rows that are not adjacent in the data', () => {
    const report = checkFrames(
      [
        frame(
          [
            ['0', 0, 40],
            ['2', 80, 120],
          ],
          {viewport: 30},
        ),
      ],
      truth,
    );
    expect(report.gapFrames).toBe(0);
  });

  it('counts a viewport that rows do not cover', () => {
    const frames = [
      frame([['0', 0, 40]], {t: 0}),
      frame(
        [
          ['0', 0, 40],
          ['1', 40, 80],
          ['2', 80, 120],
        ],
        {t: 16},
      ),
    ];
    const report = checkFrames(frames, truth);
    expect(report.blankFrames).toBe(1);
    expect(report.blankMs).toBe(16);
  });
});

describe('uncovered', () => {
  it('sums the uncovered spans', () => {
    expect(uncovered([{key: 'a', top: 10, bottom: 20}], 0, 30)).toBe(20);
    expect(uncovered([], 0, 30)).toBe(30);
  });
});

describe('anchorDrift', () => {
  it('ignores movement during scripted input and counts movement after it', () => {
    const frames: Frame[] = [
      frame([], {anchorTop: 100, input: true}),
      frame([], {anchorTop: 50, input: true}),
      frame([], {anchorTop: 50}),
      frame([], {anchorTop: 50.5}),
      frame([], {anchorTop: 80}),
      frame([], {anchorTop: 80}),
    ];
    const drift = anchorDrift(frames);
    expect(drift.jumps).toBe(1);
    expect(drift.maxDriftPx).toBe(30);
  });
});

describe('frameStats', () => {
  it('reads percentiles and dropped frames from rAF deltas', () => {
    const frames = [0, 16, 32, 48, 98].map(t => frame([], {t}));
    const stats = frameStats(frames);
    expect(stats.frames).toBe(4);
    expect(stats.p50).toBe(16);
    expect(stats.dropped).toBe(1);
    expect(stats.long).toBe(0);
  });
});
