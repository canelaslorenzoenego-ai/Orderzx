/**
 * Stream teardown live smoke — the deferred abuse case from the routes audit:
 * a REAL multipart frame stream is open and actively delivering frames when
 * the session is stopped underneath it. Asserts the stream terminates cleanly
 * (reader completes — no hang, no crash), reports whether the final boundary
 * was written, and the host disposes without uncaught errors.
 *
 * Needs: DSH_BROWSER_LIVE=1, DSH_BROWSER_LIVE_PROVIDER=cdp,
 * DSH_BROWSER_LIVE_CDP=http://127.0.0.1:9222. SKIPs (exit 0) without
 * DSH_BROWSER_LIVE=1.
 */
import http from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createMiniWebServer, createStepReporter } from './_smoke-harness.mjs'

if (process.env.DSH_BROWSER_LIVE !== '1') {
  console.log('stream-teardown smoke skipped: set DSH_BROWSER_LIVE=1')
  process.exit(0)
}
const LIVE_PROVIDER = process.env.DSH_BROWSER_LIVE_PROVIDER ?? 'patchright'
const LIVE_CDP = process.env.DSH_BROWSER_LIVE_CDP ?? null

const { step, finish } = createStepReporter()
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const uncaught = []
process.on('uncaughtException', err => uncaught.push(String(err?.message ?? err)))
process.on('unhandledRejection', err => uncaught.push(`rejection: ${String(err?.message ?? err)}`))

const { BrowserHostController } = await import(pathToFileURL(join(root, 'lib', 'host.js')).href)
const { AccessController } = await import(pathToFileURL(join(root, 'lib', 'access.js')).href)
const { resolveConfig } = await import(pathToFileURL(join(root, 'lib', 'config.js')).href)
const { createBrowserTools } = await import(pathToFileURL(join(root, 'lib', 'tools.js')).href)
const { Routes, mountRoutes } = await import(pathToFileURL(join(root, 'lib', 'routes.js')).href)
const protocol = await import(pathToFileURL(join(root, 'lib', 'protocol.js')).href)
if (LIVE_PROVIDER === 'cdp' && LIVE_CDP) {
  const { configureCdpEndpoint } = await import(pathToFileURL(join(root, 'lib', 'engine', 'cdp.js')).href)
  configureCdpEndpoint(LIVE_CDP)
}

// ── fixture page (frames need something real to capture) ────────────────────
const fixture = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><html><head><title>Teardown Fixture</title></head><body>
<h1>teardown fixture</h1><p>a page worth streaming</p>
</body></html>`)
})
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`

const config = resolveConfig({
  engine: {
    provider: LIVE_PROVIDER,
    ...(LIVE_CDP ? { cdpEndpoint: LIVE_CDP } : {}),
    headless: process.env.DSH_BROWSER_LIVE_HEADLESS === '1',
    launchTimeoutMs: 90_000,
    idleTimeoutMs: 300_000,
  },
  frames: { source: 'screenshot', maxFps: 5 },
  policy: { allowedDomains: ['127.0.0.1'], allowEvaluate: true },
})
const access = new AccessController()
const host = new BrowserHostController({ config, access, onEvent: () => {} })
const { ChallengePipeline } = await import(pathToFileURL(join(root, 'lib', 'challenge', 'pipeline.js')).href)
const challenge = new ChallengePipeline({
  config: { autoSolver: 'off', adapter: null, allowedDomains: [], handoffByDefault: true, handoffTimeoutMs: 1_000 },
  adapters: new Map(),
  handoff: async () => 'abandoned',
  approveDomain: async () => false,
  audit: () => {},
})
const tools = createBrowserTools(host, { vision: {}, challenge, requestApproval: async () => true })
const runTool = (name, args = {}) =>
  tools[name].execute(args, { callId: `st-${name}`, rootCallId: `st-${name}`, name, arguments: args, signal: AbortSignal.timeout(45_000) })

// ── real HTTP mount ─────────────────────────────────────────────────────────
const web = createMiniWebServer()
const routes = new Routes(host, access)
const unmount = mountRoutes(web, routes)
await new Promise(resolve => web.server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${web.server.address().port}`

try {
  const start = await runTool('browser_start', { url: fixtureUrl, label: 'teardown' })
  step('session starts', start?.ok === true && start.phase === 'streaming', JSON.stringify(start).slice(0, 120))
  const session = start.session

  const grantRes = await fetch(`${base}${protocol.GRANT_ROUTE_PATH}`, {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, scope: 'view' }),
  })
  const grant = await grantRes.json()
  step('grant mints a stream token', grantRes.status === 200 && grant.kind === 'session' && typeof grant.stream?.token === 'string', JSON.stringify(grant).slice(0, 120))

  // Open the stream and consume frames until at least two boundaries arrive.
  const response = await fetch(`${base}${protocol.STREAM_ROUTE_PREFIX}?token=${encodeURIComponent(grant.stream.token)}`)
  step('stream opens multipart', response.status === 200 && (response.headers.get('content-type') ?? '').startsWith('multipart/x-mixed-replace'), `status ${response.status}, ct ${response.headers.get('content-type')}`)

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let boundaries = 0
  const guard = ms => new Promise(resolve => setTimeout(() => resolve('timeout'), ms))
  const drainUntil = async predicate => {
    // One continuous read loop (never abandon a pending read — that loses
    // chunks), bounded by an overall guard. Returns 'done' | 'pred' | 'timeout'.
    const loop = (async () => {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return 'done'
        text += decoder.decode(value, { stream: true })
        if (predicate()) return 'pred'
      }
    })()
    return Promise.race([loop, guard(20_000)])
  }
  const sawFrames = await drainUntil(() => {
    boundaries = (text.match(/--dsh-browser-frame\r?\n/g) ?? []).length
    return boundaries >= 2
  })
  step('frames were actually flowing before teardown', sawFrames === 'pred' && boundaries >= 2, `boundaries seen: ${boundaries}, drain: ${sawFrames}`)

  // ── teardown WHILE the stream is open ─────────────────────────────────────
  const stop = await runTool('browser_stop', { session })
  step('browser_stop succeeds mid-stream', stop?.ok === true, JSON.stringify(stop).slice(0, 120))

  let ended
  try {
    const result = await drainUntil(() => false) // read to 'done', 20 s guard
    ended = { ended: result === 'done', how: result }
  } catch (err) {
    // A network-level abort also counts as termination — the client is not hung.
    ended = { ended: true, how: 'error', error: String(err?.message ?? err) }
  }
  step('the open stream terminates after teardown — no hang', ended.ended === true, JSON.stringify(ended).slice(0, 160))
  const finalBoundary = /--dsh-browser-frame--/.test(text)
  step('teardown is observable to the client (final boundary or clean close)', ended.ended === true, `final boundary written: ${finalBoundary}`)

  const status = await fetch(`${base}${protocol.STATUS_ROUTE_PATH}?token=${encodeURIComponent(grant.stream.token)}`, { signal: AbortSignal.timeout(8_000) }).catch(() => null)
  step('status after teardown does not hang or crash', status !== null && status.status < 500, `status ${status?.status ?? 'fetch failed/hung'}`)

  step('no uncaught exceptions or unhandled rejections during teardown', uncaught.length === 0, JSON.stringify(uncaught).slice(0, 200))
} finally {
  unmount?.()
  web.server.close()
  await host.dispose().catch(() => {})
  fixture.close()
  step('host disposes cleanly after teardown', uncaught.length === 0, JSON.stringify(uncaught).slice(0, 200))
  finish()
}
