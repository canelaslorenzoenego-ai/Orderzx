/**
 * Challenge live smoke — the tier-2/tier-3 challenge pipeline against a REAL
 * browser and REAL DOM detection (until now only unit-tested against static
 * probe payloads). Covers:
 *   - DOM detection of a Turnstile-style widget (vendor/blocking/sitekey/
 *     responseField/solved) via the isolated-world DOM_PROBE.
 *   - Tier 3 adapter solve, proven by a PAGE EFFECT: the fixture only unlocks
 *     when the hidden response field actually holds a value.
 *   - Re-challenge on a solved widget → continue, no second solve.
 *   - Unsupported vendor (DataDome marker) → fall through to handoff, adapter
 *     never consulted; browser_handoff runs the human dep and settles.
 *   - autoSolver off → straight to handoff, adapter never consulted.
 *   - Domain not in allowedDomains → blocked, approveDomain NOT called.
 *   - Domain configured but approval refused → blocked, approveDomain called
 *     with (domain, vendor, adapter).
 *   - Audit sink receives settled records.
 *
 * Needs: DSH_BROWSER_LIVE=1, DSH_BROWSER_LIVE_PROVIDER=cdp,
 * DSH_BROWSER_LIVE_CDP=http://127.0.0.1:9222. SKIPs (exit 0) without
 * DSH_BROWSER_LIVE=1 so it can sit in CI chains unconditionally.
 */
import http from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createStepReporter } from './_smoke-harness.mjs'

if (process.env.DSH_BROWSER_LIVE !== '1') {
  console.log('challenge-live smoke skipped: set DSH_BROWSER_LIVE=1')
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

// ── fixture: a Turnstile-style widget + a DataDome marker page ──────────────
const fixture = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  if ((req.url ?? '/').startsWith('/dd')) {
    res.end(`<!doctype html><html><head><title>DataDome Fixture</title></head><body>
<h1>datadome fixture</h1>
<div id="datadome-captcha"></div>
</body></html>`)
    return
  }
  res.end(`<!doctype html><html><head><title>Challenge Fixture</title></head><body>
<h1>challenge fixture</h1>
<div class="cf-turnstile" data-sitekey="0xTESTSITEKEY"></div>
<textarea name="cf-turnstile-response" id="resp"></textarea>
<button id="go">Unlock</button>
<p id="state">locked</p>
<script>
document.getElementById('go').addEventListener('click', () => {
  document.getElementById('state').textContent =
    document.getElementById('resp').value.trim() ? 'unlocked' : 'denied'
})
</script>
</body></html>`)
})
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`

// ── real host ───────────────────────────────────────────────────────────────
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

// ── stub tier-3 adapter: fills the response field IN the driven page ────────
let solveCalls = 0
const stubAdapter = {
  name: 'stub-solver',
  inSession: true,
  supports: vendor => vendor === 'cloudflare-turnstile',
  ready: async () => ({ ready: true }),
  solve: async ({ page }) => {
    solveCalls += 1
    const started = Date.now()
    await page.evaluateIsolated(`(() => { const el = document.querySelector('[name="cf-turnstile-response"]'); if (el) el.value = 'stub-token-xyz'; return !!el })()`)
    return { ok: true, latencyMs: Date.now() - started, inSession: true, detail: 'stub filled the response field' }
  },
}

function makeToolset({ autoSolver = 'off', adapter = null, allowedDomains = [], approve = false, withAdapter = false } = {}) {
  const audits = []
  const approveCalls = []
  const pipeline = new ChallengePipeline({
    config: { autoSolver, adapter, allowedDomains, handoffByDefault: true, handoffTimeoutMs: 1_000 },
    adapters: new Map(withAdapter ? [['stub-solver', stubAdapter]] : []),
    handoff: async () => 'passed',
    approveDomain: async (domain, vendor, adapterName) => {
      approveCalls.push({ domain, vendor, adapter: adapterName })
      return approve
    },
    audit: record => audits.push(record),
  })
  const tools = createBrowserTools(host, { vision: {}, challenge: pipeline, requestApproval: async () => true })
  const run = (name, args = {}) =>
    tools[name].execute(args, { callId: `cl-${name}`, rootCallId: `cl-${name}`, name, arguments: args, signal: AbortSignal.timeout(45_000) })
  return { run, audits, approveCalls }
}

const A = makeToolset({ autoSolver: 'adapter', adapter: 'stub-solver', allowedDomains: ['127.0.0.1'], approve: true, withAdapter: true })
const B = makeToolset({ withAdapter: true }) // adapter registered but autoSolver off
const C = makeToolset({ autoSolver: 'adapter', adapter: 'stub-solver', allowedDomains: [], withAdapter: true }) // domain not configured
const D = makeToolset({ autoSolver: 'adapter', adapter: 'stub-solver', allowedDomains: ['127.0.0.1'], approve: false, withAdapter: true }) // configured, approval refused

try {
  const start = await A.run('browser_start', { url: fixtureUrl, label: 'challenge-live' })
  step('session starts on the challenge fixture', start?.ok === true, JSON.stringify(start).slice(0, 140))
  const session = start.session
  const clear = () => A.run('browser_evaluate', { session, script: `(() => { const el = document.querySelector('[name="cf-turnstile-response"]'); if (el) el.value = ''; const s = document.getElementById('state'); if (s) s.textContent = 'locked'; return true })()` })

  // ── tier 3: detection + adapter solve + page-effect proof ─────────────────
  const det = await A.run('browser_challenge', { session })
  const d = det?.detection ?? {}
  step('DOM probe detects the turnstile widget as blocking',
    det?.ok === true && d.present === true && d.vendor === 'cloudflare-turnstile' && d.blocking === true && d.sitekey === '0xTESTSITEKEY' && d.solved === false,
    JSON.stringify(d).slice(0, 180))
  const solvedRecord = A.audits.find(r => r.resolvedBy === 'adapter')
  step('the verdict is solved via the registered adapter, in-session',
    det?.action === 'solved' && solveCalls === 1 && solvedRecord?.adapter?.name === 'stub-solver' && solvedRecord?.adapter?.inSession === true,
    JSON.stringify({ action: det?.action, solveCalls, adapter: solvedRecord?.adapter }).slice(0, 180))
  const effect = await A.run('browser_evaluate', { session, script: `(() => { document.getElementById('go').click(); return document.getElementById('state').textContent })()` })
  step('the solve had a real page effect — the fixture unlocks', effect?.ok === true && effect.result === 'unlocked', JSON.stringify(effect).slice(0, 140))

  const again = await A.run('browser_challenge', { session })
  step('re-challenge on a solved widget continues without a second solve',
    again?.action === 'continue' && again?.detection?.solved === true && solveCalls === 1,
    JSON.stringify({ action: again?.action, solved: again?.detection?.solved, solveCalls }).slice(0, 160))

  // ── unsupported vendor falls through to handoff ───────────────────────────
  await clear()
  const nav = await A.run('browser_navigate', { session, url: `${fixtureUrl}dd` })
  step('navigates to the datadome fixture', nav?.ok === true, JSON.stringify(nav).slice(0, 120))
  const dd = await A.run('browser_challenge', { session })
  step('unsupported vendor (datadome) falls through to handoff, adapter untouched',
    dd?.action === 'handoff' && dd?.detection?.vendor === 'datadome' && solveCalls === 1,
    JSON.stringify({ action: dd?.action, vendor: dd?.detection?.vendor, solveCalls }).slice(0, 160))
  const ho = await A.run('browser_handoff', { session })
  step('browser_handoff runs the human dep and settles as passed',
    ho?.ok === true && ho.outcome === 'passed' && ho.vendor === 'datadome',
    JSON.stringify(ho).slice(0, 180))

  // ── autoSolver off → handoff without consulting the adapter ───────────────
  await A.run('browser_navigate', { session, url: fixtureUrl })
  const off = await B.run('browser_challenge', { session })
  step('autoSolver off routes straight to handoff, adapter never consulted',
    off?.action === 'handoff' && off?.detection?.vendor === 'cloudflare-turnstile' && solveCalls === 1,
    JSON.stringify({ action: off?.action, solveCalls }).slice(0, 160))

  // ── domain gates ──────────────────────────────────────────────────────────
  const notConfigured = await C.run('browser_challenge', { session })
  step('domain not in allowedDomains is blocked without an approval prompt',
    notConfigured?.action === 'blocked' && /not approved/i.test(notConfigured?.verdict ?? notConfigured?.reason ?? '') && C.approveCalls.length === 0,
    JSON.stringify({ action: notConfigured?.action, reason: (notConfigured?.verdict ?? notConfigured?.reason ?? '').slice(0, 100), approveCalls: C.approveCalls.length }).slice(0, 220))
  const refused = await D.run('browser_challenge', { session })
  step('configured domain with a refused approval is blocked, approveDomain was asked',
    refused?.action === 'blocked' && D.approveCalls.length === 1 && D.approveCalls[0]?.domain === '127.0.0.1' && D.approveCalls[0]?.vendor === 'cloudflare-turnstile' && D.approveCalls[0]?.adapter === 'stub-solver',
    JSON.stringify({ action: refused?.action, approveCalls: D.approveCalls }).slice(0, 220))

  // ── audit ─────────────────────────────────────────────────────────────────
  const settled = [...A.audits, ...D.audits, ...C.audits]
  step('the audit sink received settled records', settled.length >= 3 && settled.some(r => r.resolvedBy === 'adapter' && r.outcome === 'passed') && settled.some(r => r.resolvedBy === 'handoff'),
    JSON.stringify(settled.map(r => ({ vendor: r.vendor, by: r.resolvedBy, out: r.outcome }))).slice(0, 220))

  const stop = await A.run('browser_stop', { session })
  step('session stops', stop?.ok === true, JSON.stringify(stop).slice(0, 120))
} finally {
  await host.dispose().catch(() => {})
  fixture.close()
  finish()
}
