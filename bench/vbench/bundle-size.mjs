// Copyright (c) Meta Platforms, Inc. and affiliates.

/**
 * @file bundle-size.mjs
 * @input The engine sources on this branch
 * @output vbench-bundles.json: min+gzip bytes of each engine alone (React and
 *   StyleX external), bundled with esbuild
 * @position Bundle-bytes metric of the virtualizer bake-off. Bench-only.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {build} from 'esbuild';

const root = path.resolve(import.meta.dirname, '../..');
const page = 'apps/sandbox/src/app/(raw)/pages/vbench-engines';
const entries = {
  listwindow: 'packages/core/src/utils/listWindow.ts',
  chat: 'packages/lab/src/Chat/ChatVirtualizer.tsx',
  tanstack: `${page}/tanstack-entry.ts`,
  fenwick: `${page}/fenwick.ts`,
  recycle: `${page}/recycle-entry.ts`,
};
const out = {};
for (const [engine, entry] of Object.entries(entries)) {
  try {
    const result = await build({
      entryPoints: [path.join(root, entry)],
      bundle: true,
      minify: true,
      format: 'esm',
      write: false,
      platform: 'browser',
      external: ['react', 'react-dom', 'react/jsx-runtime', '@stylexjs/stylex', '@astryxdesign/*'],
      absWorkingDir: path.join(root, 'apps/sandbox'),
      logLevel: 'silent',
    });
    const code = result.outputFiles[0].contents;
    out[engine] = {minBytes: code.length, gzipBytes: zlib.gzipSync(code, {level: 9}).length};
  } catch (error) {
    out[engine] = {error: String(error).slice(0, 300)};
  }
}
// Reference libraries, installed (scripts off) into VBENCH_REFS_DIR by CI.
const refsDir = process.env.VBENCH_REFS_DIR;
if (refsDir && fs.existsSync(refsDir)) {
  const refs = {
    'virtua (Virtualizer + WindowVirtualizer)': "export {Virtualizer, WindowVirtualizer} from 'virtua';",
    '@tanstack/react-virtual (useVirtualizer + useWindowVirtualizer, with virtual-core)':
      "export {useVirtualizer, useWindowVirtualizer} from '@tanstack/react-virtual';",
    'react-window (List)': "export {List} from 'react-window';",
    'react-virtuoso (Virtuoso)': "export {Virtuoso} from 'react-virtuoso';",
  };
  out.refs = {};
  for (const [name, contents] of Object.entries(refs)) {
    try {
      const result = await build({
        stdin: {contents, resolveDir: refsDir, loader: 'js'},
        bundle: true,
        minify: true,
        format: 'esm',
        write: false,
        platform: 'browser',
        external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
        logLevel: 'silent',
      });
      const code = result.outputFiles[0].contents;
      out.refs[name] = {minBytes: code.length, gzipBytes: zlib.gzipSync(code, {level: 9}).length};
    } catch (error) {
      out.refs[name] = {error: String(error).slice(0, 300)};
    }
  }
}
const file = process.argv[2] ?? 'vbench-bundles.json';
fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out));
