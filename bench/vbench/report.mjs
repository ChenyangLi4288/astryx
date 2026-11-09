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
const SCENARIOS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S6-item', 'S7', 'S9', 'S8-S1-page', 'S8-S3-page', 'S8-S5-page'];

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
  };
}

const summary = {};
for (const [key, list] of cells) summary[key] = summarize(list);
const get = (engine, scenario, throttle) => summary[`${engine}|${scenario}|${throttle}`];
const fmt = (v, d = 1) => (v == null ? '–' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(d)) : String(v));

function correct(s) {
  return s && s.errors === 0 && s.overlapFrames === 0 && s.gapFrames === 0 && s.positionFrames === 0;
}

function verdicts(engine) {
  const why = [];
  for (const sc of ['S1', 'S2', 'S3']) {
    const s = get(engine, sc, 1);
    if (!s) why.push(`${sc} unthrottled not measured`);
    else if (s.p95 == null || s.p95 > 16.7) why.push(`${sc} p95 ${fmt(s.p95)} ms > 16.7`);
  }
  for (const sc of ['S3', 'S4', 'S5', 'S6', 'S6-item', 'S7']) {
    for (const th of [1, 4]) {
      const s = get(engine, sc, th);
      if (!s) continue;
      if (s.driftPx == null || s.driftPx > 1) why.push(`${sc}@${th}× drift ${fmt(s.driftPx)} px`);
      if (s.jumps == null || s.jumps > 0) why.push(`${sc}@${th}× jumps ${fmt(s.jumps)}`);
    }
  }
  for (const sc of ['S8-S1-page', 'S8-S3-page', 'S8-S5-page', 'S1', 'S3', 'S5']) {
    const s = get(engine, sc, 1);
    if (s && !correct(s)) why.push(`${sc} not correct (overlap ${fmt(s.overlapFrames)}, gap ${fmt(s.gapFrames)}, position ${fmt(s.positionFrames)} frames, errors ${s.errors})`);
  }
  return {pass: why.length === 0, why};
}

const lines = [];
lines.push('# Virtualizer bake-off results', '');
const cpus = [...new Set(runners.map(r => r.cpu))];
lines.push(`Runners: ${runners.length} jobs; CPU model(s): ${cpus.join(' | ') || 'unknown'}. Medians of ${median(runs.map(() => 1)) ? 'all' : 0} runs per cell.`, '');
if (cpus.length > 1) lines.push('**Warning: more than one CPU model; compare only within one model.**', '');

lines.push('## Verdicts (protocol pass bar)', '');
lines.push('| Candidate | Pass | min+gzip bytes | Why not |', '|---|---|---|---|');
const passers = [];
for (const engine of ENGINES) {
  const v = verdicts(engine);
  const bytes = bundles[engine]?.gzipBytes ?? null;
  if (v.pass) passers.push({engine, bytes});
  lines.push(`| ${LABELS[engine]} | ${v.pass ? 'yes' : 'no'} | ${fmt(bytes)} | ${v.why.slice(0, 6).join('; ') || ''}${v.why.length > 6 ? ` (+${v.why.length - 6} more)` : ''} |`);
}
lines.push('');
passers.sort((a, b) => (a.bytes ?? Infinity) - (b.bytes ?? Infinity));
lines.push(
  `**Recommendation:** ${passers.length ? `${LABELS[passers[0].engine]} — passes the bar with the fewest bytes among ${passers.length} passer(s).` : 'no candidate passes the full bar; see the tables for the nearest.'}`,
  '',
);

for (const th of [1, 4]) {
  lines.push(`## ${th === 1 ? 'Unthrottled' : '4× CPU throttle'}`, '');
  lines.push(
    '| Candidate | Scenario | p50 / p95 / p99 ms | long / dropped | first load ms | max · mean pos err px (vs first visible row) | content offset px | overlap / gap / misplaced frames | blank ms | jumps | drift px | heap MB | S9 |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const engine of ENGINES) {
    for (const sc of SCENARIOS) {
      const s = get(engine, sc, th);
      if (!s) continue;
      lines.push(
        `| ${LABELS[engine]} | ${sc} | ${fmt(s.p50)} / ${fmt(s.p95)} / ${fmt(s.p99)} | ${fmt(s.long)} / ${fmt(s.dropped)} | ${fmt(s.firstRenderMs, 0)} | ${fmt(s.maxPosPx)} · ${fmt(s.meanPosPx, 2)} | ${fmt(s.offsetPx, 0)} | ${fmt(s.overlapFrames)} / ${fmt(s.gapFrames)} / ${fmt(s.positionFrames)} | ${fmt(s.blankMs, 0)} | ${fmt(s.jumps)} | ${fmt(s.driftPx)} | ${fmt(s.heapMb)} | ${sc === 'S9' ? `${s.s9PassCount}/${s.runs}` : ''}${s.errors ? ` ⚠ ${s.errors} error(s)` : ''} |`,
      );
    }
  }
  lines.push('');
}

lines.push('## What was and was not measured', '');
lines.push(
  '- Measured: rAF frame deltas; every frame\'s mounted-row rects against an unwindowed render of the same seeded rows with the same mutations (1 px tolerance; 2 frames of grace after each insert or resize); viewport coverage; anchored-row movement without input; JS heap after S2 (after GC); first load to ready; S9 focus and row identity per frame; min+gzip of each engine alone (React external).',
  "- Candidate 1 is fixed-height by design: it runs every scenario at a fixed 48 px pitch, so its variable-height results are 'not supported', not a comparison.",
  '- Candidate 2 (ChatVirtualizer) renders through its own component; the harness supplies only the row content.',
  '- S1 flings are capped at 30 s; the scrolled distance is in the raw results.',
  '- Rects are read in the frame callback, so a commit that lands after it and before paint is seen one frame late.',
  '- Not measured: real screen-reader speech (S9 checks focus and aria-posinset in the DOM), touch devices, WebKit/Firefox.',
);
fs.mkdirSync(outDir, {recursive: true});
fs.writeFileSync(path.join(outDir, 'report.md'), `${lines.join('\n')}\n`);
fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify({runners, bundles, summary}, null, 2)}\n`);
console.log(lines.slice(0, 20).join('\n'));
