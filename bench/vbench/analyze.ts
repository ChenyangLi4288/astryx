// Copyright (c) Meta Platforms, Inc. and affiliates.

/**
 * @file analyze.ts
 * @input Frames recorded in the browser (collect.ts): each frame's time, the
 *   scroll position and the content-space rect of every mounted row; and the
 *   ground truth, the content-space rect of every row in an unwindowed render
 * @output Per-frame correctness findings (overlaps, gaps, rows away from the
 *   ground truth, rows that leave the viewport uncovered) and frame-time and
 *   anchor statistics
 * @position The pure half of the virtualization bench. It has no browser
 *   dependency, so its rules have unit tests (analyze.test.ts).
 */

/** One mounted row in one frame, in content coordinates (CSS px). */
export interface RowRect {
  key: string;
  top: number;
  bottom: number;
}

/** One animation frame as the browser recorded it. */
export interface Frame {
  /** rAF timestamp, ms. */
  t: number;
  /** Scroll offset of the scroller at that frame, px. */
  scroll: number;
  /** Viewport height of the scroller at that frame, px. */
  viewport: number;
  /** Mounted rows, in DOM order. Empty in timing-only runs. */
  rows: RowRect[];
  /** Whether scripted input was active during this frame. */
  input: boolean;
  /** Viewport-space top of the anchored row, when one is tracked. */
  anchorTop?: number | null;
  /** Changes when the script picks a new anchored row. */
  anchorEpoch?: number;
}

/** The unwindowed render: row key to content-space top and bottom. */
export type GroundTruth = Map<string, {top: number; bottom: number}>;

export interface Tolerances {
  /** Allowed rect error against ground truth, px. */
  positionPx: number;
  /** Allowed overlap or gap between adjacent rows, px. */
  seamPx: number;
  /** Movement of the anchored row that counts as a jump, px. */
  jumpPx: number;
}

export const DEFAULT_TOLERANCES: Tolerances = {
  positionPx: 1,
  seamPx: 1,
  jumpPx: 1,
};

export interface Violation {
  frame: number;
  kind: 'overlap' | 'gap' | 'position' | 'order';
  key: string;
  px: number;
}

export interface FrameStats {
  frames: number;
  p50: number;
  p95: number;
  p99: number;
  /** Frames over 1.5 × the 16.7 ms budget: at least one vsync was missed. */
  dropped: number;
  /** Frames over 50 ms. */
  long: number;
}

export interface CorrectnessReport {
  violations: Violation[];
  overlapFrames: number;
  gapFrames: number;
  positionFrames: number;
  /**
   * Largest error of a row's place relative to the first visible row, px:
   * mispositioned rows, wrong heights or seams. This is the 1 px check.
   */
  maxPositionErrorPx: number;
  meanPositionErrorPx: number;
  /**
   * Largest difference between where the first visible row sits in the
   * content and where it sits in the unwindowed render, px: how far an
   * engine's estimated offsets are from the measured content. Reported, not
   * held to 1 px: an estimating engine differs until it measures the rows.
   */
  maxContentOffsetErrorPx: number;
  /** Frames where mounted rows do not cover the whole viewport. */
  blankFrames: number;
  /** Total time with an uncovered viewport, ms. */
  blankMs: number;
  /** Frames where the anchored row moved more than jumpPx without input. */
  jumps: number;
  /** Largest anchored-row movement without input, px. */
  maxDriftPx: number;
  meanDriftPx: number;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
}

export function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Frame-time statistics from consecutive rAF timestamps. */
export function frameStats(frames: Frame[]): FrameStats {
  const deltas: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    if (a && b) {
      deltas.push(b.t - a.t);
    }
  }
  const sorted = [...deltas].sort((x, y) => x - y);
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    frames: deltas.length,
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    dropped: deltas.filter(d => d > 25).length,
    long: deltas.filter(d => d > 50).length,
  };
}

/**
 * Checks every frame's mounted rows: adjacent rows (in key order of the
 * ground truth) must meet within seamPx, every row must sit within
 * positionPx of its ground-truth rect, and the mounted rows must cover the
 * viewport wherever the content does.
 */
export function checkFrames(
  frames: Frame[],
  truthOrStages:
    | GroundTruth
    | ((frameIndex: number) => {truth: GroundTruth; checkPosition: boolean}),
  tolerances: Tolerances = DEFAULT_TOLERANCES,
): CorrectnessReport {
  const stageOf =
    typeof truthOrStages === 'function'
      ? truthOrStages
      : () => ({truth: truthOrStages, checkPosition: true});
  const violations: Violation[] = [];
  let overlapFrames = 0;
  let gapFrames = 0;
  let positionFrames = 0;
  let maxPositionErrorPx = 0;
  let positionErrorSum = 0;
  let positionErrorCount = 0;
  let maxContentOffsetErrorPx = 0;
  let blankFrames = 0;
  let blankMs = 0;
  frames.forEach((frame, index) => {
    if (frame.rows.length === 0) {
      return;
    }
    const {truth, checkPosition} = stageOf(index);
    const {top: contentStart, bottom: contentEnd} = extent(truth);
    let hasOverlap = false;
    let hasGap = false;
    let hasPosition = false;
    const rows = [...frame.rows].sort((a, b) => a.top - b.top);
    // Rows are compared to the unwindowed render relative to the first
    // visible row, so an engine's estimated offsets for rows it has not
    // measured do not count as misplaced rows.
    const reference =
      rows.find(r => r.bottom > frame.scroll && truth.has(r.key)) ??
      rows.find(r => truth.has(r.key));
    const referenceTruth = reference ? truth.get(reference.key) : undefined;
    const shift =
      reference && referenceTruth ? referenceTruth.top - reference.top : 0;
    if (checkPosition) {
      maxContentOffsetErrorPx = Math.max(
        maxContentOffsetErrorPx,
        Math.abs(shift),
      );
    }
    // Only rows near the viewport are checked: a row kept mounted far away
    // (for example, the focused row) sits past rows the engine has only
    // estimated, and nobody sees it.
    const nearTop = frame.scroll - frame.viewport;
    const nearBottom = frame.scroll + 2 * frame.viewport;
    for (const row of rows) {
      const expected = truth.get(row.key);
      if (!expected || !checkPosition) {
        continue;
      }
      if (row.bottom < nearTop || row.top > nearBottom) {
        continue;
      }
      const error = Math.max(
        Math.abs(row.top + shift - expected.top),
        Math.abs(row.bottom + shift - expected.bottom),
      );
      positionErrorSum += error;
      positionErrorCount += 1;
      maxPositionErrorPx = Math.max(maxPositionErrorPx, error);
      if (error > tolerances.positionPx) {
        hasPosition = true;
        violations.push({
          frame: index,
          kind: 'position',
          key: row.key,
          px: error,
        });
      }
    }
    for (let i = 1; i < rows.length; i++) {
      const above = rows[i - 1];
      const below = rows[i];
      if (!above || !below) {
        continue;
      }
      const seam = below.top - above.bottom;
      // A gap counts only between rows that are adjacent in the data.
      const truthAbove = truth.get(above.key);
      const truthBelow = truth.get(below.key);
      const adjacent =
        truthAbove != null &&
        truthBelow != null &&
        Math.abs(truthBelow.top - truthAbove.bottom) <= tolerances.seamPx;
      if (seam < -tolerances.seamPx) {
        hasOverlap = true;
        violations.push({
          frame: index,
          kind: 'overlap',
          key: below.key,
          px: -seam,
        });
      } else if (adjacent && seam > tolerances.seamPx) {
        hasGap = true;
        violations.push({frame: index, kind: 'gap', key: below.key, px: seam});
      }
    }
    if (hasOverlap) {
      overlapFrames += 1;
    }
    if (hasGap) {
      gapFrames += 1;
    }
    if (hasPosition) {
      positionFrames += 1;
    }

    const viewTop = Math.max(frame.scroll, contentStart);
    const viewBottom = Math.min(frame.scroll + frame.viewport, contentEnd);
    if (
      checkPosition &&
      uncovered(rows, viewTop, viewBottom) > tolerances.seamPx
    ) {
      blankFrames += 1;
      const next = frames[index + 1];
      blankMs += next ? next.t - frame.t : 0;
    }
  });

  const drift = anchorDrift(frames, tolerances);
  return {
    violations,
    overlapFrames,
    gapFrames,
    positionFrames,
    maxPositionErrorPx: round2(maxPositionErrorPx),
    maxContentOffsetErrorPx: round2(maxContentOffsetErrorPx),
    meanPositionErrorPx: round2(
      positionErrorCount === 0 ? 0 : positionErrorSum / positionErrorCount,
    ),
    blankFrames,
    blankMs: Math.round(blankMs),
    ...drift,
  };
}

const extents = new WeakMap<GroundTruth, {top: number; bottom: number}>();
function extent(truth: GroundTruth): {top: number; bottom: number} {
  let cached = extents.get(truth);
  if (!cached) {
    let top = Infinity;
    let bottom = 0;
    for (const r of truth.values()) {
      top = Math.min(top, r.top);
      bottom = Math.max(bottom, r.bottom);
    }
    cached = {top: Number.isFinite(top) ? top : 0, bottom};
    extents.set(truth, cached);
  }
  return cached;
}

/**
 * Picks each frame's ground truth by the stage it was recorded in, and skips
 * position checks for `graceFrames` frames after each stage change: the
 * engine needs a commit to show a mutation.
 */
export function stagedTruth(
  frames: Array<Frame & {stage: number}>,
  truths: GroundTruth[],
  graceFrames = 2,
): (frameIndex: number) => {truth: GroundTruth; checkPosition: boolean} {
  const sinceChange: number[] = [];
  let last = -1;
  let count = 0;
  for (const frame of frames) {
    count = frame.stage === last ? count + 1 : 0;
    last = frame.stage;
    sinceChange.push(count);
  }
  const fallback = truths[truths.length - 1] ?? new Map();
  return index => {
    const frame = frames[index];
    const stage = frame?.stage ?? 0;
    return {
      truth: truths[stage] ?? fallback,
      checkPosition: stage === 0 || (sinceChange[index] ?? 0) >= graceFrames,
    };
  };
}

/** Pixels of [top, bottom) that no row covers. */
export function uncovered(
  rows: RowRect[],
  top: number,
  bottom: number,
): number {
  if (bottom <= top) {
    return 0;
  }
  let cursor = top;
  let missing = 0;
  for (const row of [...rows].sort((a, b) => a.top - b.top)) {
    if (row.bottom <= cursor) {
      continue;
    }
    if (row.top >= bottom) {
      break;
    }
    if (row.top > cursor) {
      missing += row.top - cursor;
    }
    cursor = Math.max(cursor, row.bottom);
    if (cursor >= bottom) {
      break;
    }
  }
  if (cursor < bottom) {
    missing += bottom - cursor;
  }
  return missing;
}

/**
 * Movement of the anchored row between consecutive frames with no scripted
 * input. Input frames reset the reference, so a scroll the script asked for
 * never counts.
 */
export function anchorDrift(
  frames: Frame[],
  tolerances: Tolerances = DEFAULT_TOLERANCES,
): {jumps: number; maxDriftPx: number; meanDriftPx: number} {
  let jumps = 0;
  let maxDriftPx = 0;
  let sum = 0;
  let count = 0;
  let reference: number | null = null;
  let epoch: number | undefined;
  for (const frame of frames) {
    const top = frame.anchorTop ?? null;
    // A new anchored row starts a new reference: the distance between the old
    // and the new row is not a movement.
    const newAnchor = frame.anchorEpoch !== epoch;
    epoch = frame.anchorEpoch;
    if (frame.input || top == null || newAnchor) {
      reference = top;
      continue;
    }
    if (reference == null) {
      reference = top;
      continue;
    }
    const drift = Math.abs(top - reference);
    sum += drift;
    count += 1;
    maxDriftPx = Math.max(maxDriftPx, drift);
    if (drift > tolerances.jumpPx) {
      jumps += 1;
      // Each jump counts once; the new position becomes the reference.
      reference = top;
    }
  }
  return {
    jumps,
    maxDriftPx: round2(maxDriftPx),
    meanDriftPx: round2(count === 0 ? 0 : sum / count),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
