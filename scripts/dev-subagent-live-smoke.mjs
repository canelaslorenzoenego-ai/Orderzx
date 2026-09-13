/**
 * Sub-agent isolation live smoke — every agent (main or sub) gets its OWN
 * browser session, and sessions never see or disturb each other:
 *
 *   - two concurrent sessions, distinct ids and labels;
 *   - each session's tab strip lists ONLY its own pages (an attached CDP
 *     browser is shared, but page ownership is per session — foreign tabs and
 *     the user's own tabs are invisible and untouchable);
 *   - popups (target=_blank) stay owned by the session whose page opened them;
 *   - interleaved navigation/evaluation never crosses sessions;
 *   - browser_status lists both;
 *   - stopping one session leaves the other fully operational.
 *
 * Needs: DSH_BROWSER_LIVE=1, DSH_BROWSER_LIVE_PROVIDER=cdp,
 * DSH_BROWSER_LIVE_CDP=http://127.0.0.1:9222. SKIPs (exit 0) without
 * DSH_BROWSER_LIVE=1.
 */
import http from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createStepReporter } from './_smoke-harness.mjs'

if (process.env.DSH_BROWSER_LIVE !== '1') {
  console.log('subagent-live smoke skipped: set DSH_BROWSER_LIVE=1')
  process.exit(0)
}
const LIVE_PROVIDER = process.env.DSH_BROWSER_LIVE_PROVIDER ?? 'patchright'
const LIVE_CDP = process.env.DSH_BROWSER_LIVE_CDP ?? null

const { step, finish } = createStepReporter()
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const { BrowserHostController } = await import(pathToFileURL(join(root, 'lib', 'host.js')).href)
const { AccessController } = await import(pathToFileURL(join(root, 'lib', 'access.js')).href)
const { resolveConfig } = await import(pathToFileURL(join(root, 'lib', 'config.js')).href)
const { createBrowserTools } = await import(pathToFileURL(join(root, 'lib', 'tools.js')).href)
const { ChallengePipeline } = await import(pathToFileURL(join(root, 'lib', 'challenge', 'pipeline.js')).href)
if (LIVE_PROVIDER === 'cdp' && LIVE_CDP) {
  const { configureCdpEndpoint } = await import(pathToFileURL(join(root, 'lib', 'engine', 'cdp.js')).href)
  configureCdpEndpoint(LIVE_CDP)
}

// ── fixture ─────────────────────────────────────────────────────────────────
const fixture = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><html><head><title>Fixture ${req.url}</title></head><body>
<h1>page ${req.url}</h1>
<a id="pop" href="/popup" target="_blank">popup</a>
</body></html>`)
})
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${fixture.address().port}/`

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
const host = new BrowserHostController({ config, access: new AccessController(), onEvent: () => {} })
const challenge = new ChallengePipeline({
  config: { autoSolver: 'off', adapter: null, allowedDomains: [], handoffByDefault: true, handoffTimeoutMs: 1_000 },
  adapters: new Map(), handoff: async () => 'abandoned', approveDomain: async () => false, audit: () => {},
})
// ONE toolset — the same tools a harness registers once; sub-agents are
// distinguished by the session id they pass, exactly like nested agent calls.
const tools = createBrowserTools(host, { vision: {}, challenge, requestApproval: async () => true })
const run = (name, args = {}) =>
  tools[name].execute(args, { callId: `sa-${name}`, rootCallId: `sa-${name}`, name, arguments: args, signal: AbortSignal.timeout(45_000) })

try {
  const main = await run('browser_start', { url: `${url}?main`, label: 'main-agent' })
  step('the main agent gets a session', main?.ok === true && typeof main.session === 'string', JSON.stringify({ ok: main?.ok, session: main?.session }).slice(0, 120))
  const sub = await run('browser_start', { url: `${url}?sub`, label: 'sub-agent' })
  step('the sub-agent gets its OWN session', sub?.ok === true && sub.session !== main.session, JSON.stringify({ ok: sub?.ok, session: sub?.session, main: main?.session }).slice(0, 160))

  const tabsMain = await run('browser_tabs', { session: main.session, action: 'list' })
  const tabsSub = await run('browser_tabs', { session: sub.session, action: 'list' })
  step('each session sees only its own tab',
    tabsMain?.tabs?.length === 1 && tabsSub?.tabs?.length === 1
    && (tabsMain.tabs[0].url ?? '').includes('?main') && (tabsSub.tabs[0].url ?? '').includes('?sub'),
    JSON.stringify({ main: tabsMain?.tabs?.map(t => t.url.slice(-12)), sub: tabsSub?.tabs?.map(t => t.url.slice(-12)) }).slice(0, 160))

  await run('browser_evaluate', { session: sub.session, script: 'document.getElementById("pop").click()' })
  await new Promise(resolve => setTimeout(resolve, 1_200))
  const tabsSub2 = await run('browser_tabs', { session: sub.session, action: 'list' })
  const tabsMain2 = await run('browser_tabs', { session: main.session, action: 'list' })
  step('a popup stays owned by the session that opened it',
    tabsSub2?.tabs?.length === 2 && tabsMain2?.tabs?.length === 1,
    JSON.stringify({ sub: tabsSub2?.tabs?.length, main: tabsMain2?.tabs?.length }))

  const here = s => run('browser_evaluate', { session: s, script: 'location.search' })
  const [qMain, qSub] = [await here(main.session), await here(sub.session)]
  step('interleaved evaluation reads each session’s own page',
    qMain?.result === '?main' && qSub?.result === '?sub',
    JSON.stringify({ main: qMain?.result, sub: qSub?.result }))

  const navMain = await run('browser_navigate', { session: main.session, url: `${url}?main2` })
  const qSub2 = await here(sub.session)
  step('main navigating does not disturb the sub-agent',
    navMain?.ok === true && qSub2?.result === '?sub',
    JSON.stringify({ nav: navMain?.ok, subStill: qSub2?.result }).slice(0, 140))

  const status = await run('browser_status', {})
  const labels = (status?.status?.sessions ?? []).map(s => s.label)
  step('browser_status lists both sessions',
    labels.includes('main-agent') && labels.includes('sub-agent'),
    JSON.stringify(labels).slice(0, 140))

  const stopMain = await run('browser_stop', { session: main.session })
  const qSub3 = await here(sub.session)
  step('stopping the main session leaves the sub-agent fully operational',
    stopMain?.ok === true && qSub3?.ok === true && qSub3.result === '?sub',
    JSON.stringify({ stop: stopMain?.ok, subStill: qSub3?.result }).slice(0, 140))

  const stopSub = await run('browser_stop', { session: sub.session })
  step('the sub-agent session stops cleanly', stopSub?.ok === true, JSON.stringify(stopSub).slice(0, 120))
} finally {
  await host.dispose().catch(() => {})
  fixture.close()
  finish()
}
