# vbench: virtualization bake-off and engine-swap checker

Scratch branch only (`bench/virtualizer-bakeoff`). Never merged.

## What it checks

For every animation frame of a scripted scroll:

- no two mounted rows overlap, and no gap opens between adjacent rows (1 px);
- every mounted row's rect is within 1 px of its rect in an unwindowed render
  of the same rows after the same mutations (2 frames of grace after an insert
  or a resize);
- the mounted rows cover the viewport (blank frames and blank time);
- the anchored row does not move without input (jumps > 1 px, max drift).

Timing: frame p50/p95/p99 from rAF deltas, dropped frames (> 25 ms), long
frames (> 50 ms), first load, JS heap after the 100k scenario, and each
engine's min+gzip bytes.

## Pieces

| File                                               | Role                                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `analyze.ts`                                       | Pure checks (unit tests: `analyze.test.ts`, `fenwick.test.ts`)                                               |
| `collect.ts`                                       | In-page frame recorder, ground-truth reader, gestures. Works on any page that follows the row contract below |
| `scenarios.ts`                                     | Protocol scenarios S1–S9 (S8 = S1, S3, S5 on page scroll)                                                    |
| `vbench.perf.spec.ts`                              | Driver: one JSON per engine × scenario × throttle × run                                                      |
| `report.mjs`                                       | Medians, pass-bar verdicts, recommendation → `report.md`                                                     |
| `bundle-size.mjs`                                  | min+gzip of each engine alone                                                                                |
| `run.json`                                         | What the next push measures (engines, throttles, scenarios, runs, text scale)                                |
| `apps/sandbox/src/app/(raw)/pages/vbench-engines/` | The bench page: one harness, five engine adapters                                                            |

## Row contract (for any page)

- Rows carry `data-vbench-key="<stable key>"`.
- The scroller carries `data-vbench-scroller`; without one, the page scrolls.
- `window.__vbench` exposes `append(n)`, `insertAbove(n)`, `resize(key, px)`,
  `setAnchor(mode, key)`, `firstVisibleKey()`, `anchorTop()`,
  `scrollToKey(key)`, `focusKey(key)`, `focusedKey()`, `focusedPosition()`,
  `expectedPosition(key)`, `count()`, `keyAt(i)`.
- `?mode=unwindowed` renders every row in flow (the ground truth).
- `document.documentElement.dataset.vbench = 'ready'` when interactive.

## Run on CI

1. `bash ~/astryx/tools/ci-slot.sh acquire bakeoff <session>` (CI & Release's
   key; ≤ 10 concurrent jobs).
2. Edit `run.json`, commit, run check-no-internal on the range, push the branch.
3. The `vbench` workflow builds once, measures one job per engine × throttle,
   and uploads `vbench-report` (report.md and summary.json; also in the run
   summary).

## Compare a before and an after ref (engine-swap PRs)

1. In `compare.json`, set `before` (full SHA, e.g. main's) and `after` (full
   SHA of the PR head), a `label`, and the `cases` (today: `table`).
2. In `run.json`, set `"mode": "compare"`.
3. Acquire the `bakeoff` key, commit, run check-no-internal, push.
4. The workflow overlays `overlay/vbench/page.tsx` (public component API
   only) onto both refs, builds each, and measures both on the same runner
   type at 1× and 4× CPU and 100% and 200% text. The `vbench-compare-report`
   artifact (and the run summary) holds `compare.md`: before → after per
   scenario, with a verdict per row.

Component scenarios: fling 10k and 100k, wheel, drag, jumps to 25/50/75% of
100k and back, 50 rows inserted above the viewport, and per-append cost.

## Run locally (analysis only; no browser on the M5)

`node node_modules/vitest/vitest.mjs run --config bench/vbench/vitest.config.ts --root .`
