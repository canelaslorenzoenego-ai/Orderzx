/**
 * Workflow/task live smoke — the record → replay → background-job engine
 * against a REAL browser, driven the way a human + the panel would:
 *
 *   1. recording refuses while the agent owns the pointer;
 *   2. a viewer promotes itself (takeover on a view token), arms recording,
 *      and demonstrates: click a field, type, click a password field, type a
 *      secret, click a link (all through the signed control route);
 *   3. the saved workflow is plain JSON on disk — and the secret NEVER is:
 *      it became a required {{variable}};
 *   4. replay without the variable refuses; with it, the fixture's click
 *      counter proves the replayed gesture actually landed;
 *   5. browser_task runs the same workflow as a cancellable background job;
 *   6. delete removes it; stop tears the session down.
 *
 * Needs: DSH_BROWSER_LIVE=1, DSH_BROWSER_LIVE_PROVIDER=cdp,
 * DSH_BROWSER_LIVE_CDP=http://127.0.0.1:9222 (same contract as the other
 * live suites). SKIPs (exit 0) without DSH_BROWSER_LIVE so `npm test` chains
 * can include it unconditionally.
 */
import { readFileSync } from 'node:fs'
import http from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createMiniWebServer, createStepReporter } from './_smoke-harness.mjs'

if (process.env.DSH_BROWSER_LIVE !== '1') {
  console.log('workflow smoke skipped: set DSH_BROWSER_LIVE=1')
  process.exit(0)
}
const LIVE_PROVIDER = process.env.DSH_BROWSER_LIVE_PROVIDER ?? 'patchright'
const LIVE_CDP = process.env.DSH_BROWSER_LIVE_CDP ?? null

const { step, finish } = createStepReporter()
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const { BrowserHostController } = await import(pathToFileURL(join(root, 'lib', 'host.js')).href)
const { AccessController, profileRoot } = await import(pathToFileURL(join(root, 'lib', 'access.js')).href)
const { Routes, mountRoutes } = await import(pathToFileURL(join(root, 'lib', 'routes.js')).href)
const { resolveConfig } = await import(pathToFileURL(join(root, 'lib', 'config.js')).href)
const { createBrowserTools } = await import(pathToFileURL(join(root, 'lib', 'tools.js')).href)
const protocol = await import(pathToFileURL(join(root, 'lib', 'protocol.js')).href)
if (LIVE_PROVIDER === 'cdp' && LIVE_CDP) {
  const { configureCdpEndpoint } = await import(pathToFileURL(join(root, 'lib', 'engine', 'cdp.js')).href)
  configureCdpEndpoint(LIVE_CDP)
}

// ── fixture page: search box, password box, counted link ───────────────────
const clicked = { count: 0 }
const fixture = http.createServer((req, res) => {
  if (req.url === '/click' && req.method === 'POST') {
    clicked.count += 1
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, count: clicked.count }))
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><html><head><title>Workflow Fixture</title></head><body>
<h1>dsh-browser workflow fixture</h1>
<input id="q" aria-label="Search" />
<input id="pw" type="password" aria-label="Password" />
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

// ── real host + real routes ────────────────────────────────────────────────
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
  config: {
    autoSolver: config.challenge.autoSolver,
    adapter: config.challenge.adapter,
    allowedDomains: config.challenge.allowedDomains,
    handoffByDefault: config.challenge.handoffByDefault,
    handoffTimeoutMs: config.challenge.handoffTimeoutMs,
  },
  adapters: new Map(),
  handoff: async () => 'abandoned',
  approveDomain: async () => false,
  audit: () => {},
})
const tools = createBrowserTools(host, { vision: {}, challenge, requestApproval: async () => true })
const runTool = (name, args = {}) =>
  tools[name].execute(args, { callId: `wf-${name}`, rootCallId: `wf-${name}`, name, arguments: args, signal: AbortSignal.timeout(60_000) })

const web = createMiniWebServer()
const unmount = mountRoutes(web, new Routes(host, access))
await new Promise(resolve => web.server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${web.server.address().port}`
const ORIGIN = base

const post = async (path, body, token) => {
  const qs = token ? `?token=${encodeURIComponent(token)}` : ''
  const response = await fetch(`${base}${path}${qs}`, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  const text = await response.text()
  try { return { status: response.status, body: JSON.parse(text) } } catch { return { status: response.status, body: text } }
}

try {
  // ── 1. session up ──────────────────────────────────────────────────────────
  const start = await runTool('browser_start', { url: fixtureUrl, label: 'workflow-probe' })
  step('session starts on the fixture', start?.ok === true && typeof start.session === 'string', JSON.stringify(start).slice(0, 160))
  const session = start.session

  // ── 2. recording refuses while the agent drives ───────────────────────────
  const refused = await runTool('browser_workflow', { session, action: 'start', name: 'probe-demo' })
  step('recording refuses while the agent owns the pointer', refused?.ok === false && refused.refused === 'pointer-owned', JSON.stringify(refused).slice(0, 140))

  // Element boxes for the human demo (viewport px → normalized).
  const see = await runTool('browser_see', { session })
  const viewport = see?.viewport ?? { width: 1366, height: 768 }
  const boxOf = label => (see?.marks ?? []).find(m => (m.name ?? '').includes(label))?.box
  const qBox = boxOf('Search')
  const pwBox = boxOf('Password')
  const linkBox = boxOf('Click me')
  step('see found the demo targets', !!qBox && !!pwBox && !!linkBox, JSON.stringify({ q: !!qBox, pw: !!pwBox, link: !!linkBox }))
  const center = box => ({ x: (box.x + box.width / 2) / viewport.width, y: (box.y + box.height / 2) / viewport.height })

  // ── 3. viewer promotes itself, drive grant, recording armed ───────────────
  const viewGrant = await post(protocol.GRANT_ROUTE_PATH, { session, scope: 'view' })
  step('view grant minted', viewGrant.status === 200 && typeof viewGrant.body?.stream?.token === 'string', `status ${viewGrant.status}`)
  const takeoverMsg = await post(protocol.SESSION_ROUTE_PATH, { kind: 'takeover' }, viewGrant.body.control.token)
  step('takeover succeeds on the view token', takeoverMsg.status === 200 && takeoverMsg.body?.ok === true, JSON.stringify(takeoverMsg.body).slice(0, 120))
  const driveGrant = await post(protocol.GRANT_ROUTE_PATH, { session, scope: 'drive' })
  step('drive granted while takeover active', driveGrant.status === 200 && driveGrant.body?.scope === 'drive', `status ${driveGrant.status} scope ${driveGrant.body?.scope}`)
  const drive = driveGrant.body.control.token

  const armed = await post(protocol.SESSION_ROUTE_PATH, { kind: 'set-recording', enabled: true, name: 'probe-demo' }, drive)
  step('recording arms for the human', armed.status === 200 && armed.body?.ok === true, JSON.stringify(armed.body).slice(0, 120))

  // ── 4. the human demonstrates (through the signed control route) ──────────
  const gesture = async message => {
    const r = await post(protocol.CONTROL_ROUTE_PATH, message, drive)
    if (r.status !== 200) throw new Error(`gesture ${message.kind} → ${r.status} ${JSON.stringify(r.body).slice(0, 100)}`)
    await new Promise(res => setTimeout(res, 120))
  }
  const click = async box => {
    const p = center(box)
    await gesture({ kind: 'pointer-down', x: p.x, y: p.y, button: 'left' })
    await gesture({ kind: 'pointer-up', x: p.x, y: p.y, button: 'left' })
  }
  await click(qBox)
  for (const ch of ['h', 'i']) await gesture({ kind: 'key', key: ch, text: ch })
  await click(pwBox)
  for (const ch of ['s', '3', 'c', 'r', 'e', 't']) await gesture({ kind: 'key', key: ch, text: ch })
  const clicksBefore = clicked.count
  await click(linkBox)
  await new Promise(res => setTimeout(res, 600)) // async-fetch settle, same as the replay assertions
  step('the demonstrated link click reached the fixture', clicked.count === clicksBefore + 1, `count ${clicked.count}`)

  const saved = await post(protocol.SESSION_ROUTE_PATH, { kind: 'set-recording', enabled: false }, drive)
  step('recording stops and saves', saved.status === 200 && saved.body?.ok === true && saved.body?.steps >= 5, JSON.stringify(saved.body).slice(0, 160))
  step('the secret became a required variable', Array.isArray(saved.body?.variables) && saved.body.variables.length === 1, JSON.stringify(saved.body?.variables))
  const secretVar = saved.body?.variables?.[0]

  // ── 5. the artifact on disk never contains the secret ─────────────────────
  const disk = readFileSync(join(profileRoot(), 'workflows', 'probe-demo.json'), 'utf8')
  // Secrets are stored as `{ kind: 'type', variable: 'password' }` — the text
  // is NEVER accumulated (appendKeyEvent), so the artifact must carry the
  // variable marker and must not carry the typed secret.
  step('the saved JSON is plain and secret-free', /"variable"\s*:\s*"password"/.test(disk) && !disk.includes('s3cret'), disk.replace(/\s+/g, ' ').slice(0, 160))

  // ── 6. agent resumes; replay refuses without vars, runs with them ─────────
  const resumed = await post(protocol.SESSION_ROUTE_PATH, { kind: 'resume' }, drive)
  step('resume hands the pointer back', resumed.status === 200 && resumed.body?.ok === true, JSON.stringify(resumed.body).slice(0, 120))

  const list = await runTool('browser_workflow', { session, action: 'list' })
  step('workflow list shows the saved demo', list?.ok === true && (list.workflows ?? []).some(w => w.name === 'probe-demo'), JSON.stringify(list).slice(0, 160))

  const noVars = await runTool('browser_workflow', { session, action: 'run', name: 'probe-demo' })
  step('replay without the variable refuses', noVars?.ok === false && /variable/i.test(noVars.message ?? ''), JSON.stringify(noVars).slice(0, 140))

  const before = clicked.count
  const run = await runTool('browser_workflow', { session, action: 'run', name: 'probe-demo', vars: { [secretVar]: 's3cret' } })
  // The anchor's click handler fires an async fetch POST — let it settle before
  // counting, or the assertion races the network (latent since day one; the
  // patchright driver's input timing made it deterministic).
  await new Promise(res => setTimeout(res, 600))
  step('replay runs and the gesture lands again', run?.ok === true && clicked.count === before + 1, `run=${JSON.stringify(run).slice(0, 120)} count ${before}→${clicked.count}`)

  // The replayed typing actually typed (evaluate is policy-allowed here).
  await new Promise(res => setTimeout(res, 400))
  const typed = await runTool('browser_evaluate', { session, script: "(() => ({ q: document.getElementById('q').value, pw: document.getElementById('pw').value }))()" })
  step('replay typed the literal text and the substituted secret', typed?.ok === true && typed.result?.q === 'hi' && typed.result?.pw === 's3cret', JSON.stringify(typed).slice(0, 160))

  // ── 7. background job: the same workflow through browser_task ─────────────
  const job = await runTool('browser_task', { session, action: 'start', workflow: 'probe-demo', vars: { [secretVar]: 's3cret' } })
  step('task start returns a job handle', job?.ok === true && typeof job.job === 'string', JSON.stringify(job).slice(0, 160))
  let done = null
  for (let i = 0; i < 60 && job?.job; i += 1) {
    await new Promise(res => setTimeout(res, 500))
    const status = await runTool('browser_task', { session, action: 'status', job: job.job })
    if (['done', 'failed', 'canceled', 'cancelled'].includes(status?.status)) { done = status; break }
    if (status?.ok === false) { done = status; break }
  }
  step('the background job finishes', done?.status === 'done', JSON.stringify(done).slice(0, 160))
  await new Promise(res => setTimeout(res, 600)) // same async-fetch settle as above
  step('the job replayed the click too', clicked.count === before + 2, `count ${clicked.count} (expected ${before + 2})`)

  // ── 8. cancel path: a second job stopped mid-flight ───────────────────────
  const job2 = await runTool('browser_task', { session, action: 'start', workflow: 'probe-demo', vars: { [secretVar]: 's3cret' } })
  await new Promise(res => setTimeout(res, 150))
  const cancel = await runTool('browser_task', { session, action: 'cancel', job: job2?.job })
  step('a running job cancels between steps', cancel?.ok === true, JSON.stringify(cancel).slice(0, 140))

  // ── 9. delete + teardown ──────────────────────────────────────────────────
  const del = await runTool('browser_workflow', { session, action: 'delete', name: 'probe-demo' })
  step('workflow delete removes it', del?.ok === true, JSON.stringify(del).slice(0, 120))
  const list2 = await runTool('browser_workflow', { session, action: 'list' })
  step('the list no longer shows it', !(list2?.workflows ?? []).some(w => w.name === 'probe-demo'), JSON.stringify(list2).slice(0, 120))

  const stop = await runTool('browser_stop', { session })
  step('session stops', stop?.ok === true, JSON.stringify(stop).slice(0, 120))
} catch (error) {
  step(`workflow conversation failed: ${error?.message ?? error}`, false)
} finally {
  unmount()
  web.server.close()
  fixture.close()
  await host.dispose()
}

finish()
