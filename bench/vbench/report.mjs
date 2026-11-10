// Copyright (c) Meta Platforms, Inc. and affiliates.

/**
 * @file report.mjs
 * @input Result directories from vbench.perf.spec.ts runs (one JSON per
 *   engine × scenario × throttle × run, plus runner.json per job) and the
 *   bundle sizes (bundle-size.mjs)
 * @output report.md (one table per throttle: candidate × scenario medians,
 *   pass-bar verdicts, recommendation, what was and wasn't measured) and
 *   summary.json
 * @position Aggregation step of the virtualizer bake-off. Bench-only.
 * Usage: node bench/vbench/report.mjs <results-root> <bundles.json> <out-dir>
 */

import fs from 'node:fs';
import path from 'node:path';

const [root = 'vbench-results', bundlesFile = 'vbench-bundles.json', outDir = 'vbench-report'] =
  process.argv.slice(2);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, out);
    else if (entry.name.endsWith('.json')) out.push(file);
  }
  return out;
}

const runs = [];
const runners = [];
for (const file of walk(root)) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (path.basename(file) === 'runner.json') runners.push({job: path.dirname(file), ...data});
  else if (data.engine && data.scenario) runs.push(data);
}
const bundles = fs.existsSync(bundlesFile) ? JSON.parse(fs.readFileSync(bundlesFile, 'utf8')) : {};

const median = values => {
  const v = values.filter(x => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const max = values => {
  const v = values.filter(x => typeof x === 'number' && Number.isFinite(x));
  return v.length ? Math.max(...v) : null;
};

const ENGINES = ['listwindow', 'chat', 'tanstack', 'fenwick', 'recycle'];
const LABELS = {
  listwindow: "1 · Table's listWindow (fixed 48 px)",
  chat: '2 · ChatVirtualizer engine',
  tanstack: '3 · TanStack measured-offset cache',
  fenwick: '4 · Prefix-sum tree',
  recycle: '5 · Outside-React recycling (prefix-sum)',
};
const BASE_SCENARIOS = ['S1', 'S1-text200', 'S2', 'S3', 'S4', 'S5', 'S6', 'S6-item', 'S7', 'S9', 'S12', 'A4'];
const pageId = id => ({S1: 'S8-S1-page', S3: 'S8-S3-page', S5: 'S8-S5-page'})[id] ?? `${id}-page`;
const SCENARIOS = [...BASE_SCENARIOS, ...BASE_SCENARIOS.map(pageId), 'S11', 'S11-page'];
const THROTTLES = [...new Set(runs.map(r => r.throttle))].sort((a, b) => a - b);
const A1_SCENARIOS = ['S1', 'S3', 'S4', 'S5', 'S6', 'S7'];

const cells = new Map();
for (const r of runs) {
  const key = `${r.engine}|${r.scenario}|${r.throttle}`;
  if (!cells.has(key)) cells.set(key, []);
  cells.get(key).push(r);
}

function summarize(list) {
  const c = list.map(r => r.correctness ?? {});
  const t = list.map(r => r.timing ?? {});
  return {
    runs: list.length,
    errors: list.filter(r => r.error).length,
    p50: median(t.map(x => x.p50)),
    p95: median(t.map(x => x.p95)),
    p99: median(t.map(x => x.p99)),
    long: median(t.map(x => x.long)),
    dropped: median(t.map(x => x.dropped)),
    droppedPct: median(t.map(x => (x.frames ? (100 * (x.dropped ?? 0)) / x.frames : null))),
    firstRenderMs: median(list.map(r => r.firstRenderMs)),
    maxPosPx: median(c.map(x => x.maxPositionErrorPx)),
    offsetPx: median(c.map(x => x.maxContentOffsetErrorPx)),
    meanPosPx: median(c.map(x => x.meanPositionErrorPx)),
    worstPosPx: max(c.map(x => x.maxPositionErrorPx)),
    overlapFrames: median(c.map(x => x.overlapFrames)),
    gapFrames: median(c.map(x => x.gapFrames)),
    positionFrames: median(c.map(x => x.positionFrames)),
    blankMs: median(c.map(x => x.blankMs)),
    jumps: median(c.map(x => x.jumps)),
    worstJumps: max(c.map(x => x.jumps)),
    driftPx: median(c.map(x => x.maxDriftPx)),
    worstDriftPx: max(c.map(x => x.maxDriftPx)),
    heapMb: median(list.map(r => r.extra?.heapMb)),
    s9Pass: list.length ? list.every(r => r.extra?.pass === true) : null,
    s9PassCount: list.filter(r => r.extra?.pass === true).length,
    firstPaintPassCount: list.filter(r => r.extra?.firstPaint?.pass === true).length,
    appendP50: median(list.map(r => r.extra?.appendMsP50)),
    appendP95: median(list.map(r => r.extra?.appendMsP95)),
    domNodes: median(list.map(r => r.extra?.domNodes)),
    coveragePct: median(list.map(r => r.extra?.coveragePct)),
    reachedEndCount: list.filter(r => r.extra?.reachedEnd === true).length,
    unsupported: list.find(r => r.unsupported)?.unsupported ?? null,
  };
}

const summary = {};
for (const [key, list] of cells) summary[key] = summarize(list);
const get = (engine, scenario, throttle) => summary[`${engine}|${scenario}|${throttle}`];
const fmt = (v, d = 1) => (v == null ? '–' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(d)) : String(v));

function correct(s) {
  return s && s.errors === 0 && s.overlapFrames === 0 && s.gapFrames === 0 && s.positionFrames === 0;
}

function verdicts(engine, frameBar) {
  const why = [];
  for (const sc of ['S1', 'S2', 'S3']) {
    const s = get(engine, sc, 1);
    if (!s) {
      why.push(`${sc} unthrottled not measured`);
    } else {
      // P1: p95, p99 <= 33 ms, dropped frames <= 1 %. The p95 bar is 16.7 ms
      // as first written (strict), or within 0.5 ms of the 60 Hz vsync
      // interval under amendment A10.
      const p95Bar = frameBar === 'strict' ? 16.7 : 1000 / 60 + 0.5;
      if (s.p95 == null || s.p95 > p95Bar) why.push(`${sc} p95 ${fmt(s.p95)} ms > ${fmt(p95Bar, 2)}`);
      if (s.p99 == null || s.p99 > 33) why.push(`${sc} p99 ${fmt(s.p99)} ms > 33`);
      if (s.droppedPct == null || s.droppedPct > 1) why.push(`${sc} dropped ${fmt(s.droppedPct, 2)} % > 1`);
    }
  }
  // Anchored-row drift and unprompted jumps in S3–S7, in both scroll areas.
  for (const base of ['S3', 'S4', 'S5', 'S6', 'S6-item', 'S7']) {
    for (const sc of [base, pageId(base)]) {
      for (const th of THROTTLES) {
        const s = get(engine, sc, th);
        if (!s) continue;
        if (s.driftPx == null || s.driftPx > 1) why.push(`${sc}@${th}× drift ${fmt(s.driftPx)} px`);
        if (s.jumps == null || s.jumps > 0) why.push(`${sc}@${th}× jumps ${fmt(s.jumps)}`);
      }
    }
  }
  // A correctness failure in any scenario overrides a performance pass.
  for (const sc of SCENARIOS) {
    // A4 is reported, not judged: see "Harness caveats".
    if (sc.startsWith('S11') || sc.startsWith('A4')) continue;
    for (const th of THROTTLES) {
      const s = get(engine, sc, th);
      if (s && !correct(s)) why.push(`${sc}@${th}× not correct (overlap ${fmt(s.overlapFrames)}, gap ${fmt(s.gapFrames)}, misplaced ${fmt(s.positionFrames)} frames, errors ${s.errors})`);
    }
  }
  return {pass: why.length === 0, why};
}

const lines = [];
lines.push('# Virtualizer bake-off results', '');
const cpus = [...new Set(runners.map(r => r.cpu))];
const runsPerCell = median([...cells.values()].map(list => list.length));
lines.push(`Runners: ${runners.length} jobs; CPU model(s): ${cpus.join(' | ') || 'unknown'}. Medians of ${runsPerCell ?? 0} runs per cell.`, '');
if (cpus.length > 1) {
  lines.push('Each job runs every engine for its scenarios, so engines are compared on one CPU model within a scenario. Absolute numbers differ between scenarios run on different models:', '');
  for (const r of runners) lines.push(`- ${path.basename(r.job)}: ${r.cpu} (calibration ${r.calibrationMs} ms, ${r.throttle}× throttle)`);
  lines.push('');
}

lines.push('## Verdicts (protocol pass bar)', '');
lines.push(
  'Frame bar, per protocol amendment A10 (changed after the smoke data): p95 frame interval within 0.5 ms of the vsync interval (≤ 17.17 ms at 60 Hz), p99 ≤ 33 ms and dropped frames ≤ 1 % (P1), the same for every engine. The strict reading as first written (p95 ≤ 16.7 ms, same p99 and dropped bars) is shown beside it. A correctness failure overrides a performance pass.',
  '',
);
lines.push('| Candidate | Pass (A10) | Pass (strict) | min+gzip bytes | Why not (A10) | Extra under strict |', '|---|---|---|---|---|---|');
const passers = [];
const brief = why => `${why.slice(0, 6).join('; ')}${why.length > 6 ? ` (+${why.length - 6} more)` : ''}`;
for (const engine of ENGINES) {
  const a10 = verdicts(engine, 'vsync');
  const strict = verdicts(engine, 'strict');
  const bytes = bundles[engine]?.gzipBytes ?? null;
  const strictOnly = strict.why.filter(w => !a10.why.includes(w));
  if (engine === 'listwindow') {
    // Candidate 1 runs at its native fixed height: rows of one pitch, so
    // variable-height scenarios are "not supported" (protocol, candidate 1).
    lines.push(`| ${LABELS[engine]} | fixed height only (${a10.pass ? 'its fixed-height runs pass' : 'its fixed-height runs fail'}); variable heights not supported | ${strict.pass ? 'fixed height only (pass)' : 'fixed height only (fail)'} | ${fmt(bytes)} | ${brief(a10.why) || 'not a variable-height candidate'} | ${brief(strictOnly)} |`);
    continue;
  }
  if (a10.pass) passers.push({engine, bytes});
  lines.push(`| ${LABELS[engine]} | ${a10.pass ? 'yes' : 'no'} | ${strict.pass ? 'yes' : 'no'} | ${fmt(bytes)} | ${brief(a10.why)} | ${brief(strictOnly)} |`);
}
lines.push('');
passers.sort((a, b) => (a.bytes ?? Infinity) - (b.bytes ?? Infinity));
const failCount = engine => verdicts(engine, 'vsync').why.length;
const nearest = ENGINES.filter(e => e !== 'listwindow').sort((a, b) => failCount(a) - failCount(b));
lines.push(
  `**Recommendation:** ${passers.length ? `${LABELS[passers[0].engine]}: passes the bar (A10) with the fewest bytes among ${passers.length} variable-height passer(s).` : `no variable-height candidate passes the full bar. Nearest by failing checks: ${nearest.map(e => `${LABELS[e]} (${failCount(e)})`).join(', ')}.`}`,
  '',
);

for (const th of THROTTLES) {
  lines.push(`## ${th === 1 ? 'Unthrottled' : `${th}× CPU throttle`}`, '');
  lines.push(
    '| Candidate | Scenario | p50 / p95 / p99 ms | long / dropped % | first load ms | max · mean pos err px (vs first visible row) | content offset px | overlap / gap / misplaced frames | blank ms | jumps | drift px | heap MB | DOM nodes | append p50 / p95 ms | S9 / S11 |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const engine of ENGINES) {
    for (const sc of SCENARIOS) {
      const s = get(engine, sc, th);
      if (!s) continue;
      lines.push(
        `| ${LABELS[engine]} | ${sc} | ${fmt(s.p50)} / ${fmt(s.p95)} / ${fmt(s.p99)} | ${fmt(s.long)} / ${fmt(s.droppedPct, 2)} | ${fmt(s.firstRenderMs, 0)} | ${fmt(s.maxPosPx)} · ${fmt(s.meanPosPx, 2)} | ${fmt(s.offsetPx, 0)} | ${fmt(s.overlapFrames)} / ${fmt(s.gapFrames)} / ${fmt(s.positionFrames)} | ${fmt(s.blankMs, 0)} | ${fmt(s.jumps)} | ${fmt(s.driftPx)} | ${fmt(s.heapMb)} | ${fmt(s.domNodes, 0)} | ${s.appendP50 == null ? '–' : `${fmt(s.appendP50, 2)} / ${fmt(s.appendP95, 2)}`} | ${sc.startsWith('S9') ? `S9 ${s.s9PassCount}/${s.runs}` : sc.startsWith('S11') ? `first paint ${s.firstPaintPassCount}/${s.runs}` : s.coveragePct != null ? `fling covers ${fmt(s.coveragePct)} %; end reached ${s.reachedEndCount}/${s.runs}` : ''}${s.errors ? ` ⚠ ${s.errors} error(s)` : ''} |`,
      );
    }
  }
  lines.push('');
}

// A1: React-placed vs direct-placed rows, on the same offset model.
lines.push('## A1 · Positioning mode (React places rows vs the engine writes positions)', '');
lines.push(
  '| Candidate | Scenario | CPU× | React: p95 / p99 ms, dropped % | Direct: p95 / p99 ms, dropped % | Direct correct? |',
  '|---|---|---|---|---|---|',
);
for (const engine of ENGINES) {
  for (const sc of A1_SCENARIOS) {
    for (const th of THROTTLES) {
      const r = engine === 'recycle' ? get('fenwick', sc, th) : get(engine, sc, th);
      const d = engine === 'recycle' ? get('recycle', sc, th) : get(`${engine}@direct`, sc, th);
      if (!r && !d) continue;
      const cell = x => (x ? `${fmt(x.p95)} / ${fmt(x.p99)}, ${fmt(x.droppedPct, 2)}` : '–');
      const directCell = d?.unsupported ?? (engine === 'chat' ? 'not supported: ChatVirtualizer owns its row placement' : cell(d));
      lines.push(`| ${LABELS[engine]}${engine === 'recycle' ? ' (React side: candidate 4)' : ''} | ${sc} | ${th} | ${cell(r)} | ${directCell} | ${d && !d.unsupported ? (correct(d) ? 'yes' : 'no') : '–'} |`);
    }
  }
}
lines.push('');

// Size table: engines and the reference libraries, one bundler and settings.
if (bundles.refs) {
  lines.push('## Size (min+gzip, esbuild ESM minify, gzip -9, React external)', '');
  lines.push('| Entry | min bytes | min+gzip bytes |', '|---|---|---|');
  for (const [name, b] of Object.entries({...Object.fromEntries(ENGINES.map(e => [LABELS[e], bundles[e]])), ...bundles.refs})) {
    lines.push(`| ${name} | ${b?.minBytes ?? '–'} | ${b?.gzipBytes ?? (b?.error ? `error: ${String(b.error).slice(0, 80)}` : '–')} |`);
  }
  lines.push('');
}

lines.push('## Findings checks', '');
lines.push(
  '- Flagged in the smoke: the prefix-sum engine showed a one-frame overlap and gap right after 50 rows were inserted above (S5). If it repeats here, it is a correctness failure for that engine (see the verdicts).',

  '- Text scaling (Table windowing turns off at 200% text): S1-text200 runs S1 with the root text at 200%. An engine passes when it stays windowed and its rows are neither misplaced nor overlapping. Candidate 1 renders a fixed 48 px pitch, so at 200% its rows clip their text by construction; that is the behavior the shared engine must replace.',
  '- Page scroll (ChatVirtualizer on page scroll opened far down, blank): S8-S1-page, S8-S3-page and S8-S5-page run each engine with the page as the scroller and a 120 px header above the list, so the list does not start at the document top. A blank viewport counts as blank time and fails correctness.',
  '',
);
lines.push('## Harness caveats', '');
lines.push(
  '- A4 (scroll up into unmeasured rows) is reported but not judged: every engine shows a jump on every wheel step, including candidate 1, whose rows never change size. Chromium animates each wheel scroll for about 100–200 ms, and the harness marked input as ended before that animation finished, so the animation counts as jumps. A4 needs a re-run with the wheel animation waited out before its result can count.',
  '- S1-text200 for candidate 1: fixed 48 px rows clip their text at 200%, so its blank time there comes from rows that cannot grow.',
  '',
);
lines.push('## Not measured in this pass (reported by name; never counted as a pass)', '');
lines.push(
  '- S10 beyond static 200% text: page and pinch zoom, a mid-session text-scale change, a late web-font load.',
  '- A2 native scroll anchoring on and off, and Firefox and WebKit.',
  '- A3 and P8 iOS momentum.',
  '- A5 keyboard paging (PageUp/PageDown, Home/End, Tab) and live announcements while scrolling.',
  '- A6 RTL, horizontal, grid, sticky header, 1M rows and display scaling.',
  '- A7 robustness: many late resizes, server render, leaks across mount cycles, input delay while streaming.',
  '- A8 find-in-page and print.',
  '- P3 forced reflows per frame; P5 scroll-to latency; P7 INP.',
  '',
);
lines.push('## What was and was not measured', '');
lines.push(
  '- Measured: rAF frame deltas; every frame\'s mounted-row rects against an unwindowed render of the same seeded rows with the same mutations (1 px tolerance; 2 frames of grace after each insert or resize); viewport coverage; anchored-row movement without input; JS heap after S2 (after GC); first load to ready; S9 focus and row identity per frame; min+gzip of each engine alone (React external).',
  "- Candidate 1 is fixed-height by design: it runs every scenario at a fixed 48 px pitch, so its variable-height results are 'not supported', not a comparison.",
  '- Candidate 2 (ChatVirtualizer) renders through its own component; the harness supplies only the row content.',
  '- S1 (amendment A12): the fling peaks at 18,000 px/s for 30 s, the same for every engine, so it covers part of the 10k-row list; each cell prints the fling\'s list coverage. A jump to the end follows in the same recording, so the far end of the list is checked frame by frame too.',
  '- Rects are read in the frame callback, so a commit that lands after it and before paint is seen one frame late.',
  '- Frame budget: rAF deltas at 60 Hz read 16.7 ms plus timer jitter, so a frame on budget can read 16.8 ms. Amendment A10 sets the bar; the strict reading is shown beside it.',
  '- Flings and drags are wheel events at 60 Hz (a fling\'s deltas decay like trackpad momentum); Chromium\'s synthetic touch gestures did not scroll these pages headless. Touch behavior is not measured.',
  '- Not measured: real screen-reader speech (S9 checks focus and aria-posinset in the DOM), touch devices, WebKit/Firefox.',
);
fs.mkdirSync(outDir, {recursive: true});
fs.writeFileSync(path.join(outDir, 'report.md'), `${lines.join('\n')}\n`);
fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify({runners, bundles, summary}, null, 2)}\n`);
console.log(lines.slice(0, 20).join('\n'));
