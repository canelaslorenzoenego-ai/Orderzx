// Node 20 floor: tsdown gates on Promise.withResolvers (Node >= 22) at
// startup; the polyfill must load in THIS process before defineConfig runs,
// which a NODE_OPTIONS --require does not reliably reach. No-op on Node 22+.
import './scripts/node20-polyfill.cjs'

import { defineConfig } from 'tsdown'

/**
 * Client bundle: CJS for the browser, ES2022, no externalised React.
 *
 * The harness's web client loads plugin client entries through its own module
 * graph, so everything except the host-provided packages must be inlined.
 * Host packages (`@deepseek-ai/dsh-client-*`, react, react-dom) stay external —
 * the `dsh.client.inject` manifest in package.json is what makes the host mount
 * them alongside this bundle.
 *
 * `neverBundle` uses PREFIX REGEXES, not bare names: `react-dom/client` and
 * `react/jsx-runtime` are distinct specifiers, and listing only `react-dom`
 * would inline the client-entry shim — which reaches into React internals and
 * trips scripts/build-client.mjs's second-React-realm guard (correctly: that
 * shim must come from the host's own React, not from ours).
 */
export default defineConfig({
  entry: ['src/client/index.tsx'],
  format: ['cjs'],
  platform: 'browser',
  target: 'es2022',
  outDir: '.client-build',
  clean: true,
  sourcemap: true,
  dts: false,
  treeshake: true,
  deps: {
    neverBundle: [
      /^react(?:\/|$)/,
      /^react-dom(?:\/|$)/,
      /^@deepseek-ai\//,
    ],
  },
  logLevel: 'warn',
})
