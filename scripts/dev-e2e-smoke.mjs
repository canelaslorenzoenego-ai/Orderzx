/**
 * END-TO-END smoke: the exact chain DSH web runs when an agent starts a browser.
 *
 *   real browser (CDP attach) → real BrowserHostController → real signed
 *   routes over real HTTP → the REAL client bundle (lib/client.js): wire
 *   functions, capsule poller, auto-open decision, boot state machine → SSR of
 *   the real panel components against the real host status.
 *
 * This is the "will the dashboard actually extend and show the browser?"
 * suite. Every other suite tests one side of the wire with a fake on the
 * other; this one has no fakes except the fixture page. It proves, in order:
 *
 *   1. browser_start reaches `streaming` with real frames;
 *   2. the capsule's REAL poller sees the real /status and the REAL
 *      autoOpenDecision fires — that fire is what extends the dashboard;
 *   3. the boot state machine walks to the `live` stage on real statuses;
 *   4. the stream URL yields real JPEG frame bytes;
 *   5. a real tool click arrives as a gesture record on the interactions SSE
 *      (the ghost cursor the user watches is drawn from these);
 *   6. view scope honestly cannot drive (the token separation, live);
 *   7. the panel components SSR against the real BrowserStatus shape.
 *
 * Gated like the live suite:
 *   DSH_BROWSER_LIVE=1 DSH_BROWSER_LIVE_PROVIDER=cdp \
 *   DSH_BROWSER_LIVE_CDP=http://127.0.0.1:9222 node scripts/dev-e2e-smoke.mjs
 */

import { existsSync, readFileSync } from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createMiniWebServer, createStepReporter, loadClientExports } from './_smoke-harness.mjs'

const { step, finish } = createStepReporter()

if (process.env.DSH_BROWSER_LIVE !== '1') {
  step('e2e suite', 'SKIP', 'set DSH_BROWSER_LIVE=1 (needs a real browser; see dev-live-smoke.mjs)')
  finish()
  process.exit(0)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const file of ['host.js', 'client.js']) {
  if (!existsSync(join(root, 'lib', file))) {
    step(`lib/${file} present`, 'SKIP', 'run `pnpm run build` first')
    finish()
    process.exit(0)
  }
}

const LIVE_PROVIDER = process.env.DSH_BROWSER_LIVE_PROVIDER ?? 'patchright'
const LIVE_CDP = process.env.DSH_BROWSER_LIVE_CDP ?? null

const { BrowserHostController } = await import(pathToFileURL(join(root, 'lib', 'host.js')).href)
const { AccessController } = await import(pathToFileURL(join(root, 'lib', 'access.js')).href)
const { Routes, mountRoutes } = await import(pathToFileURL(join(root, 'lib', 'routes.js')).href)
const { resolveConfig } = await import(pathToFileURL(join(root, 'lib', 'config.js')).href)
const { createBrowserTools } = await import(pathToFileURL(join(root, 'lib', 'tools.js')).href)
if (LIVE_PROVIDER === 'cdp') {
  const { configureCdpEndpoint } = await import(pathToFileURL(join(root, 'lib', 'engine', 'cdp.js')).href)
  configureCdpEndpoint(LIVE_CDP)
}

// The real client bundle, loaded exactly like a browser would.
const require2 = createRequire(import.meta.url)
const reactRequire = createRequire(require2.resolve('react-dom/server'))
const React = reactRequire('react')
const { renderToString } = reactRequire('react-dom/server')
const client = loadClientExports(
  readFileSync(join(root, 'lib', 'client.js'), 'utf8'),
  '@dsh-community/dsh-browser',
  specifier => reactRequire(specifier),
)
const el = React.createElement

// ── fixture page ────────────────────────────────────────────────────────────

const clicked = { count: 0 }
const fixture = http.createServer((req, res) => {
  if (req.url === '/click' && req.method === 'POST') {
    clicked.count += 1
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, count: clicked.count }))
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><html><head><title>E2E Fixture</title></head><body>
<h1>dsh-browser e2e fixture</h1>
<input id="q" aria-label="Search" />
<a id="target" href="#" role="button">Click me</a>
<script>
  document.getElementById('target').addEventListener('click', e => {
    e.preventDefault()
    fetch('/click', { method: 'POST' })
  })
</script>
</body></html>`)
})
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`

// ── real host + real routes ─────────────────────────────────────────────────

const config = resolveConfig({
  engine: {
    provider: LIVE_PROVIDER,
    ...(LIVE_CDP ? { cdpEndpoint: LIVE_CDP } : {}),
    headless: process.env.DSH_BROWSER_LIVE_HEADLESS === '1',
    launchTimeoutMs: 90_000,
    idleTimeoutMs: 300_000,
  },
  frames: { source: 'screenshot', maxFps: 5 },
  policy: { allowedDomains: ['127.0.0.1'] },
})
const access = new AccessController()
const host = new BrowserHostController({ config, access, onEvent: () => {} })
const { ChallengePipeline } = await import(pathToFileURL(join(root, 'lib', 'challenge', 'pipeline.js')).href)
const { buildAdapters } = await import(pathToFileURL(join(root, 'lib', 'challenge', 'adapters.js')).href)
// Constructed the way src/index.ts does; `handoff` resolves immediately so a
// surprise challenge cannot hang the suite.
const challenge = new ChallengePipeline({
  config: {
    autoSolver: config.challenge.autoSolver,
    adapter: config.challenge.adapter,
    allowedDomains: config.challenge.allowedDomains,
    handoffByDefault: config.challenge.handoffByDefault,
    handoffTimeoutMs: config.challenge.handoffTimeoutMs,
  },
  adapters: buildAdapters({ adapter: config.challenge.adapter }),
  handoff: async () => 'abandoned',
  approveDomain: async () => false,
  audit: () => {},
})
const tools = createBrowserTools(host, { vision: {}, challenge, requestApproval: async () => true })
const runTool = (name, args = {}) =>
  tools[name].execute(args, { callId: `e2e-${name}`, rootCallId: `e2e-${name}`, name, arguments: args, signal: new AbortController().signal })

const web = createMiniWebServer()
const unmount = mountRoutes(web, new Routes(host, access))
await new Promise(resolve => web.server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${web.server.address().port}`

// The wire functions use RELATIVE urls and rely on browser fetch semantics.
// Reproduce the two things a browser adds: base resolution and the same-origin
// Origin header (the fence requires it on POST /grant).
const nodeFetch = globalThis.fetch
globalThis.fetch = (url, init = {}) =>
  nodeFetch(typeof url === 'string' && url.startsWith('/') ? base + url : url, {
    ...init,
    headers: { Origin: base, ...(init.headers ?? {}) },
  })
const fetcher = (url, init) => globalThis.fetch(url, init)

try {
  // ── 1. the agent starts a browser ────────────────────────────────────────
  const started = await runTool('browser_start', { url: fixtureUrl })
  const sessionId = started?.session
  step('browser_start reaches streaming', started?.ok === true && started?.phase === 'streaming', JSON.stringify(started).slice(0, 120))

  // ── 2. the REAL client wire talks to the REAL routes ────────────────────
  const { requestGrant, requestStatus, streamUrl, sendControl, subscribeInteractions } = client
  const grant = await requestGrant(fetcher, { session: sessionId })
  step('the client wire mints a real grant', grant?.kind === 'session' && typeof grant.stream?.token === 'string', JSON.stringify(grant).slice(0, 120))

  const status = await requestStatus(fetcher, grant.stream.token)
  step('the client wire reads the real status', status?.phase === 'streaming' && Array.isArray(status.sessions), String(status?.phase))

  // ── 3. the capsule poller + auto-open decision: THE DASHBOARD EXTENDS ───
  {
    const { createCapsulePoller, autoOpenDecision, reduceStatus, resetBoot } = client
    const statuses = []
    let boot = resetBoot()
    let prevPhase = null
    let fired = false
    let reachedLive = false
    const poller = createCapsulePoller({
      fetcher,
      token: () => grant.stream.token,
      panelOpen: () => fired, // the real capsule stops polling once the panel opened
      intervalMs: 60,
      onStatus: s => {
        statuses.push(s.phase)
        boot = reduceStatus(boot, s)
        if (boot.stage === 'live') reachedLive = true
        const decision = autoOpenDecision({
          panelOpen: false,
          visible: true, // the capsule popped: a browser session exists
          alreadyOpened: fired,
          prevPhase,
          phase: boot.phase,
          hasHandler: true,
        })
        if (decision.fire) fired = true
        prevPhase = boot.phase
      },
    })
    poller.start()
    const deadline = Date.now() + 8_000
    while (!fired && Date.now() < deadline) await new Promise(r => setTimeout(r, 50))
    poller.stop()
    step('the real capsule poller polled the real host', poller.ticks() > 0 && statuses.length > 0, `${poller.ticks()} ticks: ${statuses.join(',')}`)
    step('autoOpenDecision fires — this is the moment the dashboard extends', fired === true)
    step('the boot machine reaches the live stage on real statuses', reachedLive === true, `stage=${boot.stage} phase=${boot.phase}`)
  }

  // ── 4. real frame bytes off the real stream route ───────────────────────
  {
    const response = await nodeFetch(`${base}${streamUrl(grant.stream.token)}`, {
      headers: { Origin: base },
      signal: AbortSignal.timeout(8_000),
    }).catch(() => undefined)
    step('the stream route answers the real client url helper', response?.status === 200 && /multipart\/x-mixed-replace/.test(response?.headers?.get?.('content-type') ?? ''), `${response?.status}`)
    let sawJpeg = false
    if (response?.body) {
      const reader = response.body.getReader()
      const readDeadline = Date.now() + 6_000
      while (!sawJpeg && Date.now() < readDeadline) {
        const { done, value } = await Promise.race([
          reader.read(),
          new Promise(resolve => setTimeout(() => resolve({ done: true }), 3_000)),
        ])
        if (done) break
        // JPEG SOI marker somewhere in the multipart body.
        for (let i = 0; i + 1 < value.length; i += 1) {
          if (value[i] === 0xff && value[i + 1] === 0xd8) { sawJpeg = true; break }
        }
      }
      reader.cancel().catch(() => {})
    }
    step('the stream carries real JPEG frames — this is what the panel paints', sawJpeg === true)
  }

  // ── 5. a real click becomes a real gesture record on the SSE channel ────
  {
    const records = []
    const subscription = subscribeInteractions({
      token: grant.stream.token,
      onEvent: record => records.push(record),
    })
    await new Promise(r => setTimeout(r, 300)) // let the SSE connect
    const observed = await runTool('browser_observe', { session: sessionId })
    const target = (observed?.elements ?? []).find(node => /click me/i.test(node.name ?? ''))
    const clickResult = target ? await runTool('browser_click', { session: sessionId, ref: target.ref }) : undefined
    const deadline = Date.now() + 6_000
    while (records.length === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 100))
    subscription.stop?.()
    step('the model clicked the real page through a real ref', clickResult?.ok === true && clicked.count > 0, `clicks=${clicked.count}`)
    step('the gesture arrived on the interactions SSE — the ghost cursor source', records.some(r => r.event?.type === 'click' || r.type === 'click'), `${records.length} records: ${JSON.stringify(records[0] ?? null).slice(0, 120)}`)
  }

  // ── 6. scope separation, live ───────────────────────────────────────────
  {
    const driven = await sendControl(fetcher, grant.stream.token, { kind: 'key', key: 'Enter' })
    step('a view token honestly cannot drive', driven?.ok === false, JSON.stringify(driven).slice(0, 120))
  }

  // ── 7. the real panel components render the real status ─────────────────
  {
    const { SessionTabStrip, HomeTab, TimelineDrawer } = client
    const fresh = await requestStatus(fetcher, grant.stream.token)
    const strip = renderToString(el(SessionTabStrip, { sessions: fresh.sessions ?? [], selected: fresh.sessions?.[0]?.id ?? 'home', onSelect() {}, narrow: true }))
    step('the tab strip renders the REAL session', strip.includes('Home') && strip.includes(String(fresh.sessions?.[0]?.id ?? '').slice(0, 8)), strip.slice(0, 100))
    const home = renderToString(el(HomeTab, { sessions: fresh.sessions ?? [], launching: false, onLaunch() {}, onOpenSession() {} }))
    step('the home tab lists the REAL running browser', home.includes('Running browsers'), '')
    const drawer = renderToString(el(TimelineDrawer, { entries: fresh.recent ?? [], open: true, onToggle() {} }))
    step('the timeline drawer renders the REAL action history', (fresh.recent ?? []).length === 0 || drawer.includes('click') || drawer.includes('start'), `${(fresh.recent ?? []).length} entries`)
  }

  step('the whole DSH-web chain ran without throwing', true)
} catch (error) {
  step('the e2e chain completed without throwing', false, error?.stack?.split('\n').slice(0, 3).join(' | ') ?? String(error))
} finally {
  await host.dispose().catch(() => undefined)
  unmount()
  fixture.close()
  web.server.close()
  web.server.closeAllConnections?.()
}

finish()
process.exit(process.exitCode ?? 0)
