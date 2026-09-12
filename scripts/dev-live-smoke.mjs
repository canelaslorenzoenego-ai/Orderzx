/**
 * LIVE smoke for dsh-browser — runs a real browser.
 *
 * Opt-in: `DSH_BROWSER_LIVE=1 node scripts/dev-live-smoke.mjs`
 * (or `pnpm run test:live`). Without the env flag it prints SKIP and exits 0,
 * so CI without a display never fails on it.
 *
 * Requirements on the machine:
 *   - `pnpm run build` has been run (imports compiled lib/*.js)
 *   - patchright installed (`npm i patchright && npx patchright install chrome`)
 *   - a display (the engine launches headed by default — headless is a
 *     detection surface; pass DSH_BROWSER_LIVE_HEADLESS=1 only if you must)
 *
 * What it proves end-to-end, against a local HTTP fixture (no third-party site
 * is ever contacted — a live suite that phones home is a suite that flakes and
 * a plugin that scrapes without consent):
 *   1. start() reaches `streaming` and a frame loop produces real frames;
 *   2. navigate + observe return real DOM state with stable refs;
 *   3. click through a ref actually clicks (the fixture records it);
 *   4. the signed routes serve the stream and a capture over real HTTP;
 *   5. takeover flips tools to `pointer-owned` refusals and resume flips back;
 *   6. dispose leaves no browser process behind.
 */

import { existsSync } from 'node:fs'
import http from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createMiniWebServer, createStepReporter } from './_smoke-harness.mjs'

const { step, finish } = createStepReporter()

if (process.env.DSH_BROWSER_LIVE !== '1') {
  step('live suite', 'SKIP', 'set DSH_BROWSER_LIVE=1 to run against a real browser')
  finish()
  process.exit(0)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const hostPath = join(root, 'lib', 'host.js')
if (!existsSync(hostPath)) {
  step('lib/host.js present', 'SKIP', 'run `pnpm run build` first')
  finish()
  process.exit(0)
}

const { BrowserHostController } = await import(pathToFileURL(hostPath).href)
const { AccessController } = await import(pathToFileURL(join(root, 'lib', 'access.js')).href)
const { Routes, mountRoutes } = await import(pathToFileURL(join(root, 'lib', 'routes.js')).href)
const { resolveConfig } = await import(pathToFileURL(join(root, 'lib', 'config.js')).href)
const { createBrowserTools } = await import(pathToFileURL(join(root, 'lib', 'tools.js')).href)

// ── local fixture page ──────────────────────────────────────────────────────

const clicked = { count: 0 }
const fixture = http.createServer((req, res) => {
  if (req.url === '/video.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html><head><title>Video Fixture</title></head><body>
<canvas id="c" width="320" height="180"></canvas>
<video id="v" muted autoplay playsinline style="width:320px;height:180px"></video>
<script>
  const canvas = document.getElementById('c')
  const ctx = canvas.getContext('2d')
  let t = 0
  setInterval(() => {
    t += 1
    ctx.fillStyle = 'hsl(' + ((t * 7) % 360) + ' 70% 45%)'
    ctx.fillRect(0, 0, 320, 180)
    ctx.fillStyle = '#fff'
    ctx.font = '28px sans-serif'
    ctx.fillText('frame ' + t, 20, 100)
  }, 100)
  const video = document.getElementById('v')
  video.srcObject = canvas.captureStream(10)
  video.play().catch(() => {})
</script>
</body></html>`)
    return
  }
  if (req.url === '/click' && req.method === 'POST') {
    clicked.count += 1
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, count: clicked.count }))
    return
  }
  // Two cookies ride along on every page load: one plain, one HttpOnly — the
  // live cookie test asserts the flags survive into metadata and the VALUES
  // never do.
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Set-Cookie': ['livesmoke=present; Path=/', 'hsess=sekrit; Path=/; HttpOnly'],
  })
  res.end(`<!doctype html><html><head><title>Live Smoke Fixture</title></head><body>
<h1>dsh-browser live fixture</h1>
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

// ── host under test ─────────────────────────────────────────────────────────

const events = []
// Provider is overridable so CI sandboxes without a Chrome channel can attach
// to a running browser instead:
//   DSH_BROWSER_LIVE_PROVIDER=cdp DSH_BROWSER_LIVE_CDP=http://127.0.0.1:9222
const LIVE_PROVIDER = process.env.DSH_BROWSER_LIVE_PROVIDER ?? 'patchright'
const LIVE_CDP = process.env.DSH_BROWSER_LIVE_CDP ?? null
const config = resolveConfig({
  engine: {
    provider: LIVE_PROVIDER,
    ...(LIVE_CDP ? { cdpEndpoint: LIVE_CDP } : {}),
    headless: process.env.DSH_BROWSER_LIVE_HEADLESS === '1',
    launchTimeoutMs: 90_000,
    idleTimeoutMs: 300_000,
  },
  frames: { source: 'screenshot', maxFps: 5 },
  // The URL policy refuses loopback by default (SSRF guard); an explicit
  // allowedDomains entry is the documented override. This also fences the live
  // suite to the local fixture — it can never wander onto a third-party site.
  policy: { allowedDomains: ['127.0.0.1'] },
})

// The plugin entry normally does this from config in apply(); this suite builds
// the host directly, so it must wire the endpoint itself.
if (LIVE_PROVIDER === 'cdp') {
  const { configureCdpEndpoint } = await import(pathToFileURL(join(root, 'lib', 'engine', 'cdp.js')).href)
  configureCdpEndpoint(LIVE_CDP)
}

const access = new AccessController()
const host = new BrowserHostController({ config, access, onEvent: event => events.push(event) })

const noopVision = { attachmentFor: async () => undefined, imageInputActive: () => false }
const { buildAdapters } = await import(pathToFileURL(join(root, 'lib', 'challenge', 'adapters.js')).href)
const { ChallengePipeline } = await import(pathToFileURL(join(root, 'lib', 'challenge', 'pipeline.js')).href)

// Constructed the same way src/index.ts does: PipelineDeps takes a config block,
// the adapter map, and the three policy callbacks. Tier 3 stays off here, and
// `handoff` resolves immediately so a surprise challenge cannot hang the suite.
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
const tools = createBrowserTools(host, { vision: noopVision, challenge, requestApproval: async () => true })

function makeExec(name, args) {
  return { callId: `live-${name}`, rootCallId: `live-${name}`, name, arguments: args, signal: new AbortController().signal }
}
const runTool = (name, args = {}) => tools[name].execute(args, makeExec(name, args))

try {
  // 1. boot
  const started = await runTool('browser_start', { url: fixtureUrl })
  step('browser_start reaches ok with the fixture url', started?.ok === true, JSON.stringify(started).slice(0, 200))
  const sessionId = started?.session
  step('start reports a session id', typeof sessionId === 'string' && sessionId.length > 0, String(sessionId))

  const status1 = host.status(sessionId)
  step('host phase is streaming or ready', ['streaming', 'ready', 'navigating'].includes(status1?.phase), String(status1?.phase))
  // The posture must report what the ENGINE actually does. Launch providers
  // humanize input; the cdp provider attaches to a browser it does not own and
  // honestly reports humanize:false plus the gap, which is the correct answer
  // there — a posture that claimed humanization it does not perform would be
  // the real failure.
  const postureGaps = JSON.stringify(started?.stealth?.gaps ?? started?.posture?.gaps ?? [])
  const humanizeOk = LIVE_PROVIDER === 'cdp'
    ? status1?.stealth?.humanize === false && /humaniz/i.test(postureGaps)
    : status1?.stealth?.humanize === true
  step('stealth posture honestly reports the humanization actually in effect', humanizeOk, `humanize=${status1?.stealth?.humanize} gaps=${postureGaps.slice(0, 120)}`)

  // frames actually flow
  await new Promise(resolve => {
    const unsubscribe = host.subscribeFrames(sessionId, () => { unsubscribe(); resolve() })
    setTimeout(resolve, 8000)
  })
  const frames = host.status(sessionId)?.frames
  step('the frame loop produced at least one frame', (frames?.lastSequence ?? 0) >= 1, JSON.stringify(frames))

  // 2. observe
  const observed = await runTool('browser_observe', { session: sessionId })
  step('observe returns the fixture title', observed?.title === 'Live Smoke Fixture', String(observed?.title))
  step('observe returns flattened elements with refs', Array.isArray(observed?.elements) && observed.elements.length > 0 && observed.elements.every(node => typeof node.ref === 'string'), `${observed?.elements?.length ?? 0} elements`)

  // 3. click by ref — the fixture counts real DOM clicks
  const target = (observed?.elements ?? []).find(node => /click me/i.test(node.name ?? ''))
  if (target) {
    const before = clicked.count
    const clickResult = await runTool('browser_click', { session: sessionId, ref: target.ref })
    await new Promise(resolve => setTimeout(resolve, 600))
    step('click by ref triggers a real DOM click', clicked.count > before && clickResult?.ok === true, `clicks ${before} → ${clicked.count}, ok=${clickResult?.ok}`)
  } else {
    step('click by ref triggers a real DOM click', false, 'no "Click me" node found in the elements')
  }

  // 3b. browser_cookies against the real profile
  const cookieList = await runTool('browser_cookies', { session: sessionId })
  step('browser_cookies lists the fixture cookies as metadata', cookieList?.ok === true && (cookieList.cookies ?? []).some(c => c.name === 'livesmoke') && (cookieList.cookies ?? []).every(c => !('value' in c)), JSON.stringify(cookieList?.cookies ?? []).slice(0, 200))
  step('cookie flags survive into metadata (httpOnly)', (cookieList?.cookies ?? []).find(c => c.name === 'hsess')?.httpOnly === true, JSON.stringify((cookieList?.cookies ?? []).find(c => c.name === 'hsess') ?? null))
  const cookieClear = await runTool('browser_cookies', { session: sessionId, action: 'clear', domain: '127.0.0.1' })
  step('clearing the fixture domain reports the removed count', cookieClear?.ok === true && (cookieClear.cleared ?? 0) >= 2, JSON.stringify(cookieClear).slice(0, 140))
  const cookiesAfter = await runTool('browser_cookies', { session: sessionId })
  step('the domain is empty after clearing', cookiesAfter?.ok === true && (cookiesAfter.cookies ?? []).length === 0, JSON.stringify(cookiesAfter?.cookies ?? []).slice(0, 120))

  // 3c. self-healing refs: a reload kills every ref in the engine's map. The
  //     click must heal exactly once (same role + accessible name in the fresh
  //     tree) and STILL land on the real element.
  const preHeal = await runTool('browser_observe', { session: sessionId })
  const healTarget = (preHeal?.elements ?? []).find(node => /click me/i.test(node.name ?? ''))
  if (healTarget) {
    const beforeHeal = clicked.count
    await runTool('browser_navigate', { session: sessionId, action: 'reload' })
    const healedClick = await runTool('browser_click', { session: sessionId, ref: healTarget.ref })
    await new Promise(resolve => setTimeout(resolve, 600))
    step('a ref killed by a reload self-heals and still clicks', healedClick?.ok === true && healedClick?.healedFrom === healTarget.ref && clicked.count > beforeHeal, `healedFrom=${healedClick?.healedFrom} clicks ${beforeHeal} → ${clicked.count}`)
  } else {
    step('a ref killed by a reload self-heals and still clicks', false, 'no "Click me" node to heal')
  }

  // 4. signed routes over real HTTP
  const web = createMiniWebServer()
  const unmount = mountRoutes(web, new Routes(host, access))
  await new Promise(resolve => web.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${web.server.address().port}`
  const origin = base

  const grantRes = await fetch(`${base}/_dsh/dsh-browser/grant`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: sessionId }),
  })
  const grant = await grantRes.json()
  step('grant mints stream + control over real HTTP', grantRes.status === 200 && typeof grant.stream?.token === 'string' && typeof grant.control?.token === 'string', `status=${grantRes.status}`)

  const streamRes = await fetch(`${base}/_dsh/dsh-browser/stream?token=${encodeURIComponent(grant.stream.token)}`, { signal: AbortSignal.timeout(5000) }).catch(() => undefined)
  step('stream route opens multipart', streamRes?.status === 200 && /multipart/.test(streamRes?.headers.get('content-type') ?? ''), `${streamRes?.status} ${streamRes?.headers.get('content-type') ?? ''}`)
  streamRes?.body?.cancel?.().catch?.(() => {})

  const capturePath = host.status(sessionId)?.frames?.lastCapturePath
  if (capturePath) {
    const capGrant = await fetch(`${base}/_dsh/dsh-browser/grant`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: capturePath }) }).then(r => r.json())
    const capRes = await fetch(`${base}/_dsh/dsh-browser/capture?token=${encodeURIComponent(capGrant.token)}`)
    step('capture route serves a real image', capRes.status === 200 && /image\//.test(capRes.headers.get('content-type') ?? ''), `${capRes.status} ${capRes.headers.get('content-type')}`)
  } else {
    // Force a capture through the tool so the path exists.
    const shot = await runTool('browser_observe', { session: sessionId, capture: true })
    const path = shot?.capturePath
    step('observe produced a capture path', typeof path === 'string', String(path))
    if (typeof path === 'string') {
      const capGrant = await fetch(`${base}/_dsh/dsh-browser/grant`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) }).then(r => r.json())
      const capRes = await fetch(`${base}/_dsh/dsh-browser/capture?token=${encodeURIComponent(capGrant.token)}`)
      step('capture route serves a real image', capRes.status === 200 && /image\//.test(capRes.headers.get('content-type') ?? ''), `${capRes.status}`)
    }
  }
  unmount()
  web.server.close()

  // 5. takeover semantics
  const began = await host.beginTakeover(sessionId, 'user')
  step('beginTakeover succeeds', began?.ok === true, JSON.stringify(began).slice(0, 160))
  const duringTakeover = await runTool('browser_click', { session: sessionId, x: 0.5, y: 0.5 })
  step('tools refuse with pointer-owned during takeover', duringTakeover?.ok === false && /pointer|owned|takeover/i.test(`${duringTakeover?.refused} ${duringTakeover?.message}`), JSON.stringify(duringTakeover).slice(0, 200))
  const ended = await host.endTakeover(sessionId)
  step('endTakeover succeeds', ended?.ok === true, JSON.stringify(ended).slice(0, 160))
  const afterTakeover = await runTool('browser_status', { session: sessionId })
  step('status works again after resume', afterTakeover?.ok !== false, JSON.stringify(afterTakeover).slice(0, 160))

  // 5b. C9: video-aware boost + clip delivery against a genuinely playing page
  // the section-4 web server was closed after the grant/capture steps; the
  // manifest rides the same verified capture route, so stand up a fresh one.
  const clipWeb = createMiniWebServer()
  const clipUnmount = mountRoutes(clipWeb, new Routes(host, access))
  await new Promise(resolve => clipWeb.server.listen(0, '127.0.0.1', resolve))
  const clipBase = `http://127.0.0.1:${clipWeb.server.address().port}`
  const toVideo = await runTool('browser_navigate', { session: sessionId, url: `${fixtureUrl}video.html` })
  step('navigate reaches the video fixture', toVideo?.ok === true, JSON.stringify(toVideo).slice(0, 140))
  await new Promise(resolve => setTimeout(resolve, 2600)) // probe cadence is 1.5s
  const boosted = host.status(sessionId)?.frames
  step('a playing <video> puts the frame loop in boost cadence', boosted?.boost === true, JSON.stringify(boosted))
  const clip = await runTool('browser_clip', { session: sessionId, seconds: 2, fps: 2 })
  step('browser_clip records the playing page and delivers it to session + chat-line', clip?.ok === true && clip.frames >= 3 && clip.delivered?.includes('session') === true && clip.delivered?.includes('chat-line') === true && typeof clip.chatLine === 'string', JSON.stringify(clip).slice(0, 200))
  // manifest/frame urls are origin-relative (the panel fetches them same-origin);
  // Node's fetch needs the base prepended.
  const manifestRes = await fetch(`${clipBase}${clip.manifest}`).catch(() => undefined)
  const manifestJson = await manifestRes?.json().catch(() => undefined)
  step('the signed manifest url serves the clip as json', manifestRes?.status === 200 && /application\/json/.test(manifestRes.headers.get('content-type') ?? '') && Array.isArray(manifestJson?.frames) && manifestJson.frames.length === clip.frames, `${manifestRes?.status} ${manifestRes?.headers.get('content-type') ?? ''}`)
  const firstFrame = await fetch(`${clipBase}${manifestJson?.frames?.[0]?.url}`).catch(() => undefined)
  step('clip frames serve real jpeg bytes through their signed urls', firstFrame?.status === 200 && /image\//.test(firstFrame.headers.get('content-type') ?? ''), `${firstFrame?.status}`)
  const away = await runTool('browser_navigate', { session: sessionId, url: fixtureUrl })
  await new Promise(resolve => setTimeout(resolve, 2600))
  const calm = host.status(sessionId)?.frames
  step('boost relaxes once playback is gone', away?.ok === true && calm?.boost === false, JSON.stringify(calm))
  clipUnmount()
  clipWeb.server.close()

  // 6. phase events were emitted for the logger
  step('host emitted lifecycle events', events.length > 0, `${events.length} events`)
} catch (error) {
  step('live suite completed without throwing', false, error?.stack?.split('\n').slice(0, 3).join(' | ') ?? String(error))
} finally {
  await host.dispose().catch(() => undefined)
  fixture.close()
  // Give the engine a moment to actually exit, then check nothing lingers.
  await new Promise(resolve => setTimeout(resolve, 1500))
  step('dispose closed the session list', host.listSessions().length === 0, JSON.stringify(host.listSessions()))
}

finish()
// The attached CDP browser and the aborted stream socket can keep handles alive
// after teardown; a live suite that lingers turns green runs into CI timeouts.
process.exit(process.exitCode ?? 0)
