// Node 20 compatibility for the build toolchain (tsdown requires Node >= 22
// for exactly one API it uses at startup). Loaded via NODE_OPTIONS=--require
// by the build:* npm scripts, so `pnpm run build` works on the plugin's
// documented floor (engines.node >= 20) instead of silently skipping the
// client/standalone bundles — a stale lib/client.js means a stale panel with
// no way to notice. No-op on Node >= 22.
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function withResolvers() {
    let resolve, reject
    const promise = new Promise((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  }
}
