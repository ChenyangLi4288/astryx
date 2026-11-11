// Copyright (c) Meta Platforms, Inc. and affiliates.

/**
 * @file overlay.mjs
 * @input The bench directory (this file's) and a target checkout
 * @output The vbench component page copied into the target's Sandbox, with
 *   its route added to the Sandbox's static-route list
 * @position Lets the compare workflow build the same page on a before and an
 *   after ref. Bench-only; never merged.
 * Usage: node overlay.mjs <target-checkout>
 */

import fs from 'node:fs';
import path from 'node:path';

const target = path.resolve(process.argv[2] ?? '.');
const from = path.join(import.meta.dirname, 'overlay/vbench');
const to = path.join(target, 'apps/sandbox/src/app/(raw)/pages/vbench');
fs.mkdirSync(to, {recursive: true});
for (const file of fs.readdirSync(from)) fs.copyFileSync(path.join(from, file), path.join(to, file));
const routesFile = path.join(target, 'apps/sandbox/scripts/next-export-routes.json');
const routes = JSON.parse(fs.readFileSync(routesFile, 'utf8'));
if (!routes.routes.includes('/pages/vbench/')) {
  routes.routes.push('/pages/vbench/');
  routes.routes.sort();
  fs.writeFileSync(routesFile, `${JSON.stringify(routes, null, 2)}\n`);
}
console.log(`overlay: ${to}`);
