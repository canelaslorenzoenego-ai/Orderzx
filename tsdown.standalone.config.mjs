// Node 20 floor: tsdown gates on Promise.withResolvers (Node >= 22) at
// startup; the polyfill must load in THIS process before defineConfig runs,
// which a NODE_OPTIONS --require does not reliably reach. No-op on Node 22+.
import './scripts/node20-polyfill.cjs'

import { defineConfig } from 'tsdown'

/**
 * Standalone panel bundle: ONE self-contained script.
 *
 * The opposite policy of tsdown.config.mjs — there, React MUST stay external so
 * the DSH host keeps a single React realm. Here there is no host: the page this
 * lands in is served by GET /panel and this script is the entire app, so React
 * and ReactDOM are bundled in and nothing is external.
 */
export default defineConfig({
  entry: ['src/client/standalone.tsx'],
  format: ['iife'],
  platform: 'browser',
  target: 'es2022',
  outDir: '.standalone-build',
  clean: true,
  sourcemap: false,
  dts: false,
  treeshake: true,
  // Bundle EVERYTHING — no externals exist for a standalone page.
  deps: { alwaysBundle: [/.*/u] },
  logLevel: 'warn',
})
