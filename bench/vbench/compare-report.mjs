// Copyright (c) Meta Platforms, Inc. and affiliates.

/**
 * @file compare-report.mjs
 * @input Compare-mode results (one JSON per side × case × scenario × throttle
 *   × text scale × run) and compare.json
 * @output compare.md: before vs after per scenario (timing, correctness,
 *   smoothness), with a verdict per row, and compare.json summary
 * @position The before/after report that each engine-swap PR carries.
 *   Bench-only; never merged.
 * Usage: node compare-report.mjs <results-root> <compare.json> <out-dir>
 */

import fs from 'node:fs';
import path from 'node:path';

const [root = 'vbench-results', configFile = 'compare.json', outDir = 'vbench-report'] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));

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
  if (path.basename(file) === 'runner.json') runners.push({job: path.basename(path.dirname(file)), ...data});
  else if (data.side && data.scenario) runs.push(data);
}

const median = values => {
  const v = values.filter(x => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const fmt = (v, d = 1) => (v == null ? '–' : Number.isInteger(v) ? String(v) : v.toFixed(d));

const groups = new Map();
for (const r of runs) {
  const key = `${r.engine}|${r.scenario}|${r.throttle}|${r.text}|${r.side}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}
function sum(list) {
  if (!list?.length) return null;
  const c = list.map(r => r.correctness ?? {});
  const t = list.map(r => r.timing ?? {});
  return {
    runs: list.length,
    errors: list.filter(r => r.error).length,
    firstRenderMs: median(list.map(r => r.firstRenderMs)),
    p50: median(t.map(x => x.p50)),
    p95: median(t.map(x => x.p95)),
    p99: median(t.map(x => x.p99)),
    dropped: median(t.map(x => x.dropped)),
    blankMs: median(c.map(x => x.blankMs)),
    overlap: median(c.map(x => x.overlapFrames)),
    gap: median(c.map(x => x.gapFrames)),
    misplaced: median(c.map(x => x.positionFrames)),
    maxPos: median(c.map(x => x.maxPositionErrorPx)),
    jumps: median(c.map(x => x.jumps)),
    drift: median(c.map(x => x.maxDriftPx)),
    appendP50: median(list.map(r => r.extra?.appendMsP50)),
    rowsRendered: median(list.map(r => r.extra?.rowsRendered)),
    appendP95: median(list.map(r => r.extra?.appendMsP95)),
  };
}

const keys = [...new Set(runs.map(r => `${r.engine}|${r.scenario}|${r.throttle}|${r.text}`))].sort();
const lines = [`# Engine-swap compare${config.label ? `: ${config.label}` : ''}`, ''];
lines.push(`Before \`${config.before.slice(0, 10)}\` · after \`${config.after.slice(0, 10)}\`. Medians of ${config.runs} seeded runs per cell.`);
const cpus = [...new Set(runners.map(r => r.cpu))];
lines.push(`Runner CPU model(s): ${cpus.join(' | ') || 'unknown'}${cpus.length > 1 ? ' — **more than one; timing deltas compare different CPUs**' : ''}.`, '');
lines.push(
  '| Case | Scenario | CPU× | Text | p95 ms before → after | p99 | dropped | first load ms | blank ms | overlap/gap/misplaced frames (after) | max pos err px (after) | jumps / drift px (after) | append p50 ms | rows in DOM | Verdict |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
);
const failures = [];
for (const key of keys) {
  const [engine, scenario, throttle, text] = key.split('|');
  const b = sum(groups.get(`${key}|before`));
  const a = sum(groups.get(`${key}|after`));
  const why = [];
  if (!a) why.push('after not measured');
  else {
    if (a.errors) why.push(`${a.errors} run error(s)`);
    if (a.overlap > 0 || a.gap > 0 || a.misplaced > 0) why.push('rows overlap, gap or sit away from ground truth');
    if (a.jumps > 0 || (a.drift ?? 0) > 1) why.push('anchor moved');
    if (b && a.p95 != null && b.p95 != null && a.p95 > b.p95 * 1.1 && a.p95 > 16.7) why.push('p95 regressed > 10%');
    if (b && a.blankMs != null && b.blankMs != null && a.blankMs > b.blankMs + 50) why.push('more blank time');
  }
  if (why.length) failures.push(`${engine} ${scenario} @${throttle}× text ${text}%: ${why.join('; ')}`);
  const arrow = (x, y, d = 1) => `${fmt(x, d)} → ${fmt(y, d)}`;
  lines.push(
    `| ${engine} | ${scenario} | ${throttle} | ${text}% | ${arrow(b?.p95, a?.p95)} | ${arrow(b?.p99, a?.p99)} | ${arrow(b?.dropped, a?.dropped)} | ${arrow(b?.firstRenderMs, a?.firstRenderMs, 0)} | ${arrow(b?.blankMs, a?.blankMs, 0)} | ${fmt(a?.overlap)}/${fmt(a?.gap)}/${fmt(a?.misplaced)} | ${fmt(a?.maxPos)} | ${fmt(a?.jumps)} / ${fmt(a?.drift)} | ${arrow(b?.appendP50, a?.appendP50, 2)} | ${arrow(b?.rowsRendered, a?.rowsRendered, 0)} | ${why.length ? `✗ ${why.join('; ')}` : '✓'} |`,
  );
}
lines.push('', failures.length ? `**${failures.length} row(s) fail.**` : '**Every row passes.**', '');
lines.push(
  'Checks per frame: no overlap or gap between adjacent rows, each row within 1 px of an unwindowed render of the same rows (2 frames of grace after an insert), viewport coverage, and the anchored row still without input (jumps > 1 px). Timing: rAF deltas; dropped = frames over 25 ms; first load = navigation to ready; append = one appended row to its next frame; rows in DOM = rows rendered at the end (windowed vs full render).',
);
fs.mkdirSync(outDir, {recursive: true});
fs.writeFileSync(path.join(outDir, 'compare.md'), `${lines.join('\n')}\n`);
fs.writeFileSync(path.join(outDir, 'compare.json'), `${JSON.stringify({config, runners, failures}, null, 2)}\n`);
console.log(lines.join('\n'));
