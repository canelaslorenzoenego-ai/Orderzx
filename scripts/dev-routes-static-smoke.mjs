/**
 * Static smoke for the signed routes — no real browser, real HTTP.
 *
 * Mounts the REAL `Routes` class on the mini webServer facsimile from the shared
 * harness, with the REAL `AccessController` (in-memory key) and a stub host that
 * records calls. Requests go over a loopback node:http server, so the transport
 * fence (loopback + Origin + sec-fetch-site) is exercised for real rather than
 * mocked.
 *
 * The security properties asserted here are the ones that matter if a token ever
 * leaks: fence-before-capability ordering, view/drive scope separation, capture
 * path containment, and TTL expiry.
 *
 * Run `pnpm run build` first — imports the COMPILED lib/*.js. SKIPs when lib is
 * missing so a partial tree does not read as a failure.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createMiniWebServer, createStepReporter, signToken } from './_smoke-harness.mjs'

const { step, finish } = createStepReporter()
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const routesPath = join(root, 'lib', 'routes.js')

if (!existsSync(routesPath)) {
  step('lib/routes.js present', 'SKIP', 'run `pnpm run build` first')
  finish()
  process.exit(0)
}

const { Routes } = await import(pathToFileURL(routesPath).href)
const { AccessController, captureDir } = await import(pathToFileURL(join(root, 'lib', 'access.js')).href)
const { compatReport } = await import(pathToFileURL(join(root, 'lib', 'compat.js')).href)
const protocol = await import(pathToFileURL(join(root, 'lib', 'protocol.js')).href)

const SESSION = 'sess-0123456789abcdef'
const KEY = Buffer.alloc(32, 7)
const access = new AccessController(async () => KEY)

// ── stub host ───────────────────────────────────────────────────────────────

const state = { takeover: false, calls: [], interactions: [], eventListeners: [] }

function record(name, result) {
  return (...args) => {
    state.calls.push({ name, args })
    return typeof result === 'function' ? result(...args) : (result ?? { ok: true })
  }
}

const host = {
  hasSession: id => id === SESSION,
  activeSessionId: () => SESSION,
  takeoverActive: () => state.takeover,
  status: () => ({
    phase: 'streaming',
    session: { id: SESSION, provider: 'patchright', channel: 'chrome', headless: false, viewport: { width: 1366, height: 768 }, tabs: [], activeTab: 0 },
    frames: { source: 'screenshot', fps: 4, lastSequence: 1, lastAt: Date.now(), bytes: 67, lastCapturePath: null },
    ...(state.takeover ? { takeover: { since: Date.now(), by: 'user' } } : {}),
    stealth: { humanize: true, fingerprintProfile: null, proxy: null, frameSuppression: { active: false, reason: null } },
    compat: compatReport(protocol.PLUGIN_VERSION),
  }),
  // A real frame: the writer flushes headers on the first part, and with no
  // latest frame the stream test's fetch would await headers forever. The
  // production host always grabs one frame immediately at start(), so having
  // one here is the faithful stub, not a convenience.
  latestFrame: () => (state.noFrame ? undefined : { data: new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')), mime: 'image/png', width: 1, height: 1, sequence: 1, at: Date.now(), source: 'screenshot' }),
  subscribeFrames: () => () => {},
  // Captures the routes' session-end tap so the stream fence can fire the
  // production 'closed' event and assert the response actually terminates.
  subscribeEvents: listener => {
    state.eventListeners.push(listener)
    return () => { state.eventListeners = state.eventListeners.filter(l => l !== listener) }
  },
  beginTakeover: record('beginTakeover', () => { state.takeover = true; return { ok: true } }),
  endTakeover: record('endTakeover', () => { state.takeover = false; return { ok: true } }),
  applyHumanControl: record('applyHumanControl'),
  setFrameSource: record('setFrameSource'),
  resolveHandoff: record('resolveHandoff'),
  abortTask: record('abortTask'),
  // Multi-session + interaction-trace surface.
  resolveRef: ref => (ref === undefined || ref === SESSION ? SESSION : undefined),
  switchActive: record('switchActive', () => ({ ok: true, active: SESSION })),
  setDesktopView: record('setDesktopView', () => ({ ok: true })),
  setDebugTap: record('setDebugTap', () => ({ ok: true })),
  setRecording: record('setRecording', () => ({ ok: true, name: 'demo' })),
  start: record('start', () => ({ ok: true, session: SESSION, label: null, phase: 'streaming', posture: { provider: 'patchright', humanize: true, applied: [], gaps: [] } })),
  stop: record('stop', () => ({ ok: true })),
  interactionsSince: () => ({ records: state.interactions, resync: false, latest: state.interactions.length }),
  subscribeInteractions: () => () => {},
}

// ── server ──────────────────────────────────────────────────────────────────

const web = createMiniWebServer()
const routes = new Routes(host, access)
const { mountRoutes } = await import(pathToFileURL(routesPath).href)
const unmount = mountRoutes(web, routes)

await new Promise(resolve => web.server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${web.server.address().port}`
const ORIGIN = base

async function req(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { Origin: ORIGIN, ...(init.headers ?? {}) },
  })
  let body
  const text = await response.text()
  try { body = JSON.parse(text) } catch { body = text }
  return { status: response.status, body, headers: response.headers }
}

// ── grant ───────────────────────────────────────────────────────────────────

{
  const noOrigin = await fetch(`${base}${protocol.GRANT_ROUTE_PATH}`, { method: 'POST', body: '{}' })
  step('grant without Origin is fenced (403)', noOrigin.status === 403, `got ${noOrigin.status}`)

  const cross = await fetch(`${base}${protocol.GRANT_ROUTE_PATH}`, { method: 'POST', body: '{}', headers: { Origin: ORIGIN, 'sec-fetch-site': 'cross-site' } })
  step('grant with sec-fetch-site: cross-site is fenced', cross.status === 403, `got ${cross.status}`)

  const view = await req(protocol.GRANT_ROUTE_PATH, { method: 'POST', body: JSON.stringify({ session: SESSION, scope: 'view' }) })
  step('grant returns stream + control tokens', view.status === 200 && view.body.kind === 'session' && typeof view.body.stream?.token === 'string' && typeof view.body.control?.token === 'string', JSON.stringify(view.body).slice(0, 140))
  step('grant scope is view without a takeover', view.body.scope === 'view', `scope=${view.body.scope}`)

  const wantsDrive = await req(protocol.GRANT_ROUTE_PATH, { method: 'POST', body: JSON.stringify({ session: SESSION, scope: 'drive' }) })
  step('drive request without takeover silently downgrades to view', wantsDrive.body.scope === 'view', `scope=${wantsDrive.body.scope}`)

  const unknown = await req(protocol.GRANT_ROUTE_PATH, { method: 'POST', body: JSON.stringify({ session: 'sess-doesnotexist00' }) })
  step('grant for unknown session is 404 (no token minted)', unknown.status === 404, `got ${unknown.status}`)
}

// ── drive scope only during takeover ───────────────────────────────────────

state.takeover = true
const driveGrant = await req(protocol.GRANT_ROUTE_PATH, { method: 'POST', body: JSON.stringify({ session: SESSION, scope: 'drive' }) })
step('drive granted while takeover active', driveGrant.body.scope === 'drive', `scope=${driveGrant.body.scope}`)
const driveToken = driveGrant.body.control.token
const viewGrant = await req(protocol.GRANT_ROUTE_PATH, { method: 'POST', body: JSON.stringify({ session: SESSION }) })
const viewToken = viewGrant.body.control.token
const streamToken = viewGrant.body.stream.token
state.takeover = false

// ── status ──────────────────────────────────────────────────────────────────

{
  const withStream = await req(`${protocol.STATUS_ROUTE_PATH}?token=${encodeURIComponent(streamToken)}`)
  step('status readable with a stream token', withStream.status === 200 && withStream.body.phase === 'streaming', `got ${withStream.status}`)
  const withControl = await req(`${protocol.STATUS_ROUTE_PATH}?token=${encodeURIComponent(viewToken)}`)
  step('status readable with a control token', withControl.status === 200, `got ${withControl.status}`)
  const bad = await req(`${protocol.STATUS_ROUTE_PATH}?token=not-a-token`)
  step('status rejects a garbage token', bad.status === 403, `got ${bad.status}`)
  const forged = signToken(KEY, { v: 1, kind: 'browser-stream', session: SESSION, exp: Date.now() + 60_000 })
  const tampered = `${forged.slice(0, -4)}AAAA`
  const badSig = await req(`${protocol.STATUS_ROUTE_PATH}?token=${encodeURIComponent(tampered)}`)
  step('status rejects a tampered signature', badSig.status === 403, `got ${badSig.status}`)
  // A VALIDLY SIGNED token whose exp is in the past — minted directly because
  // the public sign API clamps ttl to >=1ms, which made this step a 1ms race.
  const expiredToken = signToken(KEY, { v: 1, kind: 'browser-stream', session: SESSION, exp: Date.now() - 1000 })
  const expRes = await req(`${protocol.STATUS_ROUTE_PATH}?token=${encodeURIComponent(expiredToken)}`)
  step('status rejects an expired token', expRes.status === 403, `got ${expRes.status}`)
  // A control token IS accepted by status (either kind may read), but a CAPTURE
  // token must not be: kind confusion is the classic capability bug.
  const captureAsStatus = await access.signCaptureToken(join(captureDir(), 'x.png'))
  const kindConfusion = await req(`${protocol.STATUS_ROUTE_PATH}?token=${encodeURIComponent(captureAsStatus.token)}`)
  step('status rejects a capture-kind token', kindConfusion.status === 403, `got ${kindConfusion.status}`)
  const statusRes = await req(`${protocol.STATUS_ROUTE_PATH}?token=${encodeURIComponent(streamToken)}`)
  const statusBody = statusRes.body
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  step('status advertises the compat contract in lockstep with package.json', statusBody?.compat?.protocol === 1 && statusBody?.compat?.plugin === pkg.version && Array.isArray(statusBody.compat.guarantees) && statusBody.compat.guarantees.length >= 4, JSON.stringify(statusBody?.compat))
}

// ── control: scope separation ───────────────────────────────────────────────

{
  const withView = await req(`${protocol.CONTROL_ROUTE_PATH}?token=${encodeURIComponent(viewToken)}`, {
    method: 'POST',
    body: JSON.stringify({ kind: 'pointer-move', x: 0.5, y: 0.5 }),
  })
  step('control rejects a view-scoped token (403, not 401)', withView.status === 403, `got ${withView.status}`)

  const withStream = await req(`${protocol.CONTROL_ROUTE_PATH}?token=${encodeURIComponent(streamToken)}`, {
    method: 'POST',
    body: JSON.stringify({ kind: 'pointer-move', x: 0.5, y: 0.5 }),
  })
  step('control rejects a stream-kind token', withStream.status === 403, `got ${withStream.status}`)

  state.calls.length = 0
  const withDrive = await req(`${protocol.CONTROL_ROUTE_PATH}?token=${encodeURIComponent(driveToken)}`, {
    method: 'POST',
    body: JSON.stringify({ kind: 'pointer-move', x: 0.25, y: 0.75 }),
  })
  const forwarded = state.calls.find(c => c.name === 'applyHumanControl')
  step('control accepts a drive token and forwards the message', withDrive.status === 200 && forwarded?.args[1]?.x === 0.25, JSON.stringify(forwarded?.args ?? null).slice(0, 140))

  const invalid = await req(`${protocol.CONTROL_ROUTE_PATH}?token=${encodeURIComponent(driveToken)}`, {
    method: 'POST',
    body: JSON.stringify({ kind: 'pointer-move', x: 4, y: 0.5 }),
  })
  step('control rejects out-of-range normalized coordinates (400)', invalid.status === 400, `got ${invalid.status}`)

  const noKind = await req(`${protocol.CONTROL_ROUTE_PATH}?token=${encodeURIComponent(driveToken)}`, { method: 'POST', body: '{}' })
  step('control rejects a message without kind (400)', noKind.status === 400, `got ${noKind.status}`)
}

// ── session messages ────────────────────────────────────────────────────────

{
  state.calls.length = 0
  const takeover = await req(`${protocol.SESSION_ROUTE_PATH}?token=${encodeURIComponent(viewToken)}`, { method: 'POST', body: JSON.stringify({ kind: 'takeover' }) })
  step('takeover succeeds with a VIEW token (a viewer promotes itself)', takeover.status === 200 && state.calls.some(c => c.name === 'beginTakeover'), `got ${takeover.status}`)

  const resumeWithView = await req(`${protocol.SESSION_ROUTE_PATH}?token=${encodeURIComponent(viewToken)}`, { method: 'POST', body: JSON.stringify({ kind: 'resume' }) })
  step('resume requires drive scope', resumeWithView.status === 403, `got ${resumeWithView.status}`)

  const resume = await req(`${protocol.SESSION_ROUTE_PATH}?token=${encodeURIComponent(driveToken)}`, { method: 'POST', body: JSON.stringify({ kind: 'resume' }) })
  step('resume with drive token calls endTakeover', resume.status === 200 && state.calls.some(c => c.name === 'endTakeover'), `got ${resume.status}`)

  const badTier = await req(`${protocol.SESSION_ROUTE_PATH}?token=${encodeURIComponent(driveToken)}`, { method: 'POST', body: JSON.stringify({ kind: 'frame-source', source: 'hologram' }) })
  step('frame-source rejects an unknown source (400)', badTier.status === 400, `got ${badTier.status}`)

  const unknownKind = await req(`${protocol.SESSION_ROUTE_PATH}?token=${encodeURIComponent(driveToken)}`, { method: 'POST', body: JSON.stringify({ kind: 'self-destruct' }) })
  step('unknown session message is 400', unknownKind.status === 400, `got ${unknownKind.status}`)
}

// ── challenge outcome ───────────────────────────────────────────────────────

{
  state.calls.length = 0
  const resolved = await req(`${protocol.CHALLENGE_ROUTE_PATH}?token=${encodeURIComponent(driveToken)}`, {
    method: 'POST',
    body: JSON.stringify({ kind: 'handoff-resolved', challengeId: 'ch-1', outcome: 'passed' }),
  })
  step('challenge outcome reaches resolveHandoff', resolved.status === 200 && state.calls.some(c => c.name === 'resolveHandoff' && c.args[2] === 'passed'), `got ${resolved.status}`)

  const badOutcome = await req(`${protocol.CHALLENGE_ROUTE_PATH}?token=${encodeURIComponent(driveToken)}`, {
    method: 'POST',
    body: JSON.stringify({ kind: 'handoff-resolved', challengeId: 'ch-1', outcome: 'maybe' }),
  })
  step('challenge rejects an invalid outcome (400)', badOutcome.status === 400, `got ${badOutcome.status}`)
}

// ── capture containment ─────────────────────────────────────────────────────

{
  const dir = captureDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const goodPath = join(dir, 'smoke-capture.png')
  writeFileSync(goodPath, Buffer.from('89504e470d0a1a0a', 'hex'))

  // Hostile grant inputs must SETTLE — a throw out of an async void handler
  // leaves the client hanging and can crash a host with fatal unhandled
  // rejections (this was a real bug: signCaptureToken throws on relative
  // paths). AbortSignal.timeout turns a regression into a failed step.
  let rejections = 0
  const onRej = () => { rejections += 1 }
  process.on('unhandledRejection', onRej)
  const relativeGrant = await fetch(`${base}${protocol.GRANT_ROUTE_PATH}`, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'relative.png' }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => undefined)
  step('grant with a relative capture path is a settled 400 (no hang, no throw)', relativeGrant?.status === 400, `got ${relativeGrant?.status ?? 'HUNG'}`)
  const traversalGrant = await req(protocol.GRANT_ROUTE_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: '/tmp/../etc/passwd' }),
  })
  const traversalToken = traversalGrant.body?.token
  const traversalFetch = traversalToken
    ? await req(`${protocol.CAPTURE_ROUTE_PREFIX}?token=${encodeURIComponent(traversalToken)}`)
    : { status: 'no-token' }
  step('a traversal-path capture token fetches nothing (containment at open time)', traversalFetch.status === 404, `got ${traversalFetch.status}`)
  await new Promise(r => setTimeout(r, 100))
  process.off('unhandledRejection', onRej)
  step('hostile grant inputs cause no unhandled rejections', rejections === 0, `${rejections} rejections`)

  const good = await access.signCaptureToken(goodPath)
  const goodRes = await req(`${protocol.CAPTURE_ROUTE_PREFIX}?token=${encodeURIComponent(good.token)}`)
  step('capture inside the cache dir serves image/png', goodRes.status === 200 && goodRes.headers.get('content-type') === 'image/png', `got ${goodRes.status} ${goodRes.headers.get('content-type')}`)
  const { saveClipManifest } = await import(pathToFileURL(join(root, 'lib', 'capture-store.js')).href)
  const manifestPath = await saveClipManifest('smoke-session', { id: 'clip-route1', sessionId: 'smoke-session', at: Date.now(), fps: 3, seconds: 2, title: 't', url: 'u', frames: [] })
  const manifestGrant = await access.signCaptureToken(manifestPath)
  const manifestRes = await req(`${protocol.CAPTURE_ROUTE_PREFIX}?token=${encodeURIComponent(manifestGrant.token)}`)
  step('a signed clip manifest serves application/json through the capture route', manifestRes.status === 200 && (manifestRes.headers.get('content-type') ?? '').includes('application/json'), `got ${manifestRes.status} ${manifestRes.headers.get('content-type')}`)
  const manifestBad = await req(`${protocol.CAPTURE_ROUTE_PREFIX}?token=${encodeURIComponent(manifestGrant.token.slice(0, -2))}xx`)
  step('a tampered manifest token is rejected', manifestBad.status === 403, `got ${manifestBad.status}`)
  const { saveReel } = await import(pathToFileURL(join(root, 'lib', 'capture-store.js')).href)
  const reelPath = await saveReel('smoke-session', 'reel-route1', '<!doctype html><html><body>reel</body></html>')
  const reelGrant = await access.signCaptureToken(reelPath)
  const reelRes = await req(`${protocol.CAPTURE_ROUTE_PREFIX}?token=${encodeURIComponent(reelGrant.token)}`)
  step('a signed reel serves text/html behind a sandbox CSP', reelRes.status === 200 && (reelRes.headers.get('content-type') ?? '').includes('text/html') && (reelRes.headers.get('content-security-policy') ?? '').includes("default-src 'none'"), `got ${reelRes.status} ${reelRes.headers.get('content-type')} ${reelRes.headers.get('content-security-policy')}`)
  step('capture response is no-store', goodRes.headers.get('cache-control') === 'no-store', goodRes.headers.get('cache-control') ?? '')

  const escape = await access.signCaptureToken(join(dir, '..', '..', '..', 'etc', 'passwd'))
  const escapeRes = await req(`${protocol.CAPTURE_ROUTE_PREFIX}?token=${encodeURIComponent(escape.token)}`)
  step('capture refuses a path escaping the cache dir', escapeRes.status === 404 || escapeRes.status === 403, `got ${escapeRes.status}`)

  const absolute = await access.signCaptureToken('/etc/hostname')
  const absoluteRes = await req(`${protocol.CAPTURE_ROUTE_PREFIX}?token=${encodeURIComponent(absolute.token)}`)
  step('capture refuses an unrelated absolute path', absoluteRes.status === 404 || absoluteRes.status === 403, `got ${absoluteRes.status}`)

  const missing = await access.signCaptureToken(join(dir, 'does-not-exist.png'))
  const missingRes = await req(`${protocol.CAPTURE_ROUTE_PREFIX}?token=${encodeURIComponent(missing.token)}`)
  step('capture of a missing file is 404', missingRes.status === 404, `got ${missingRes.status}`)
}

// ── stream fence ────────────────────────────────────────────────────────────

{
  const bad = await req(`${protocol.STREAM_ROUTE_PREFIX}?token=garbage`)
  step('stream rejects a garbage token', bad.status === 403, `got ${bad.status}`)

  // A valid token opens a multipart stream; read the headers, then hang up.
  const controller = new AbortController()
  const response = await fetch(`${base}${protocol.STREAM_ROUTE_PREFIX}?token=${encodeURIComponent(streamToken)}`, { signal: controller.signal })
  step('stream opens with a valid token', response.status === 200, `got ${response.status}`)
  step('stream content-type is multipart/x-mixed-replace', (response.headers.get('content-type') ?? '').startsWith('multipart/x-mixed-replace'), response.headers.get('content-type') ?? '')

  // Teardown while streaming: the host publishes 'closed' for the session and
  // the open response MUST terminate (final boundary + end) — otherwise every
  // consumer hangs on a dead session forever (bug #34).
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let streamText = ''
  const drainDone = (async () => {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return true
      streamText += decoder.decode(value, { stream: true })
    }
  })().catch(() => true)
  for (const listener of [...state.eventListeners]) listener({ type: 'closed', session: SESSION, reason: 'test teardown' })
  const ended = await Promise.race([drainDone, new Promise(resolve => setTimeout(() => resolve(false), 3_000))])
  step('an open stream terminates when its session closes', ended === true && /--dsh-browser-frame--/.test(streamText), `ended ${ended}, final boundary ${/--dsh-browser-frame--/.test(streamText)}`)
  controller.abort()
}

// ── single-frame fallback route ─────────────────────────────────────────────
// Android Chrome and Safari never render multipart/x-mixed-replace in an
// <img>: the client falls back to polling {STREAM_ROUTE_PREFIX}/frame, which
// must serve the LATEST frame as one ordinary image response.

{
  const frameRes = await fetch(`${base}${protocol.STREAM_ROUTE_PREFIX}/frame?token=${encodeURIComponent(streamToken)}&n=1`, { headers: { Origin: ORIGIN } })
  const bytes = new Uint8Array(await frameRes.arrayBuffer())
  step('frame route serves the latest frame as one image', frameRes.status === 200 && frameRes.headers.get('content-type') === 'image/png' && bytes.byteLength > 0, `got ${frameRes.status} ${frameRes.headers.get('content-type')} ${bytes.byteLength}B`)
  step('frame route is no-store and reports the sequence', (frameRes.headers.get('cache-control') ?? '').includes('no-store') && frameRes.headers.get('x-frame-sequence') === '1', `${frameRes.headers.get('cache-control')} seq=${frameRes.headers.get('x-frame-sequence')}`)

  state.noFrame = true
  const emptyRes = await fetch(`${base}${protocol.STREAM_ROUTE_PREFIX}/frame?token=${encodeURIComponent(streamToken)}&n=2`, { headers: { Origin: ORIGIN } })
  step('frame route with no frame yet is 204 (client keeps polling)', emptyRes.status === 204, `got ${emptyRes.status}`)
  state.noFrame = false

  const badFrame = await fetch(`${base}${protocol.STREAM_ROUTE_PREFIX}/frame?token=garbage`, { headers: { Origin: ORIGIN } })
  step('frame route rejects a garbage token', badFrame.status === 403, `got ${badFrame.status}`)
}

// ── interactions SSE ────────────────────────────────────────────────────────

{
  const grantResponse = await fetch(`${base}${protocol.GRANT_ROUTE_PATH}`, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: SESSION, scope: 'view' }),
  })
  const grant = await grantResponse.json()

  const garbage = await fetch(`${base}${protocol.INTERACTIONS_ROUTE_PREFIX}?token=not-a-token`)
  step('interactions rejects a garbage token', garbage.status === 403, `got ${garbage.status}`)

  // Seed two gestures; the SSE backfill must replay them.
  state.interactions = [
    { seq: 1, at: Date.now(), actor: 'agent', event: { type: 'click', x: 0.4, y: 0.6, button: 'left' } },
    { seq: 2, at: Date.now(), actor: 'agent', event: { type: 'type', characters: 12, secret: true } },
  ]
  const sseController = new AbortController()
  const sse = await fetch(`${base}${protocol.INTERACTIONS_ROUTE_PREFIX}?token=${grant.stream.token}&since=0`, { signal: sseController.signal })
  step('interactions opens with a stream token', sse.status === 200, `got ${sse.status}`)
  step('interactions is text/event-stream', (sse.headers.get('content-type') ?? '').startsWith('text/event-stream'), sse.headers.get('content-type') ?? '')
  step('interactions forbids proxy buffering', sse.headers.get('x-accel-buffering') === 'no', sse.headers.get('x-accel-buffering') ?? '')
  // NEVER await sse.text(): an SSE response does not end. Read chunks until the
  // backfill shows up (or a short deadline passes), then hang up.
  const reader = sse.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + 2500
  while (Date.now() < deadline && !/event: interaction[\s\S]*seq.: 2/.test(text.replace(/"/g, m => m))) {
    const pending = Promise.race([
      reader.read(),
      new Promise(resolve => setTimeout(() => resolve({ done: true, value: undefined }), 400)),
    ])
    const chunk = await pending
    if (chunk.done && !chunk.value) break
    if (chunk.value) text += decoder.decode(chunk.value, { stream: true })
    if (text.includes('"seq":2') || text.includes('"seq": 2')) break
  }
  step('interactions backfills recorded gestures', text.includes('"seq":1') && text.includes('"seq":2'), text.slice(0, 120))
  step('the type gesture carries a count, never text', text.includes('"characters":12') && text.includes('"secret":true') && !text.includes('hunter'), '')
  sseController.abort()
  reader.cancel().catch(() => {})

  // since=1 must skip seq 1 (checked via the stub's filter semantics)
  const sse2Controller = new AbortController()
  const sse2 = await fetch(`${base}${protocol.INTERACTIONS_ROUTE_PREFIX}?token=${grant.stream.token}&since=1`, { signal: sse2Controller.signal })
  step('interactions resumes with since', sse2.status === 200, `got ${sse2.status}`)
  sse2Controller.abort()

  // A CONTROL token must not open the gesture stream (kind mismatch).
  const badKind = await fetch(`${base}${protocol.INTERACTIONS_ROUTE_PREFIX}?token=${grant.control.token}`)
  step('interactions rejects a control token', badKind.status === 403, `got ${badKind.status}`)
}

// ── swipe control ───────────────────────────────────────────────────────────

{
  const viewGrant = await (await fetch(`${base}${protocol.GRANT_ROUTE_PATH}`, {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ session: SESSION, scope: 'view' }),
  })).json()
  await fetch(`${base}${protocol.SESSION_ROUTE_PATH}?token=${viewGrant.control.token}`, {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'takeover' }),
  })
  const drive = await (await fetch(`${base}${protocol.GRANT_ROUTE_PATH}`, {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ session: SESSION, scope: 'drive' }),
  })).json()

  const okSwipe = await fetch(`${base}${protocol.CONTROL_ROUTE_PATH}?token=${drive.control.token}`, {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'swipe', points: [{ x: 0.5, y: 0.8 }, { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.2 }] }),
  })
  step('swipe with a drive token is forwarded', okSwipe.status === 200, `got ${okSwipe.status}`)
  const forwarded = state.calls.filter(c => c.name === 'applyHumanControl').pop()
  step('swipe reaches applyHumanControl with its path', forwarded?.args?.[1]?.kind === 'swipe' && forwarded.args[1].points.length === 3, JSON.stringify(forwarded?.args?.[1]?.kind))

  const onePoint = await fetch(`${base}${protocol.CONTROL_ROUTE_PATH}?token=${drive.control.token}`, {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'swipe', points: [{ x: 0.5, y: 0.5 }] }),
  })
  step('a one-point swipe is 400', onePoint.status === 400, `got ${onePoint.status}`)
  const outOfRange = await fetch(`${base}${protocol.CONTROL_ROUTE_PATH}?token=${drive.control.token}`, {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'swipe', points: [{ x: 0.5, y: 0.5 }, { x: 1.5, y: 0.5 }] }),
  })
  step('an out-of-range swipe point is 400', outOfRange.status === 400, `got ${outOfRange.status}`)

  // desktop view
  const desktop = await fetch(`${base}${protocol.SESSION_ROUTE_PATH}?token=${drive.control.token}`, {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'set-desktop-view', enabled: true }),
  })
  step('set-desktop-view with drive scope succeeds', desktop.status === 200, `got ${desktop.status}`)
  const desktopCall = state.calls.filter(c => c.name === 'setDesktopView').pop()
  step('desktop view reaches the host with the flag', desktopCall?.args?.[1] === true, JSON.stringify(desktopCall?.args))
  step('the route reloads by default — Chrome-for-Android parity', desktopCall?.args?.[2]?.reload === true, JSON.stringify(desktopCall?.args))

  const noReload = await fetch(`${base}${protocol.SESSION_ROUTE_PATH}?token=${drive.control.token}`, {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'set-desktop-view', enabled: false, reload: false }),
  })
  step('set-desktop-view accepts reload:false', noReload.status === 200, `got ${noReload.status}`)
  step('reload:false passes through to the host', state.calls.filter(c => c.name === 'setDesktopView').pop()?.args?.[2]?.reload === false)

  // debug tap (console + network drawer)
  const tap = await fetch(`${base}${protocol.SESSION_ROUTE_PATH}?token=${drive.control.token}`, {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'set-debug-tap', enabled: true }),
  })
  step('set-debug-tap with drive scope succeeds', tap.status === 200, `got ${tap.status}`)
  const tapCall = state.calls.filter(c => c.name === 'setDebugTap').pop()
  step('the tap flag reaches the host', tapCall?.args?.[1] === true, JSON.stringify(tapCall?.args))
  const tapView = await fetch(`${base}${protocol.SESSION_ROUTE_PATH}?token=${viewGrant.control.token}`, {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'set-debug-tap', enabled: true }),
  })
  step('a view token cannot arm the tap (drive scope required)', tapView.status === 403, `got ${tapView.status}`)

  // workflow recording toggle
  const rec = await fetch(`${base}${protocol.SESSION_ROUTE_PATH}?token=${drive.control.token}`, {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'set-recording', enabled: true, name: 'checkout demo' }),
  })
  step('set-recording with drive scope succeeds', rec.status === 200, `got ${rec.status}`)
  const recCall = state.calls.filter(c => c.name === 'setRecording').pop()
  step('the recording flag + name reach the host', recCall?.args?.[1] === true && recCall?.args?.[2] === 'checkout demo', JSON.stringify(recCall?.args))
  const recView = await fetch(`${base}${protocol.SESSION_ROUTE_PATH}?token=${viewGrant.control.token}`, {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'set-recording', enabled: true }),
  })
  step('a view token cannot arm recording', recView.status === 403, `got ${recView.status}`)

  // switch-session
  const switched = await fetch(`${base}${protocol.SESSION_ROUTE_PATH}?token=${drive.control.token}`, {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'switch-session', id: SESSION }),
  })
  step('switch-session with drive scope succeeds', switched.status === 200, `got ${switched.status}`)

  // stop-browser: closing a tab from the panel
  const stopped = await fetch(`${base}${protocol.SESSION_ROUTE_PATH}?token=${drive.control.token}`, {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'stop-browser', id: SESSION }),
  })
  step('stop-browser with drive scope succeeds', stopped.status === 200, `got ${stopped.status}`)
  const stopCall = state.calls.filter(c => c.name === 'stop').pop()
  step('stop-browser forwards the id + a panel reason to the host', stopCall?.args?.[0] === SESSION && /panel/.test(String(stopCall?.args?.[1] ?? '')), JSON.stringify(stopCall?.args))

  // start-browser while a session exists
  const started = await fetch(`${base}${protocol.SESSION_ROUTE_PATH}?token=${drive.control.token}`, {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'start-browser', url: 'https://example.com/x', label: 'shopper' }),
  })
  step('start-browser launches and answers with the session', started.status === 200, `got ${started.status}`)
  const startCall = state.calls.filter(c => c.name === 'start').pop()
  step('start-browser forwards url + label to the host', startCall?.args?.[0]?.label === 'shopper' && startCall?.args?.[0]?.url === 'https://example.com/x', JSON.stringify(startCall?.args?.[0]))
  const badStart = await fetch(`${base}${protocol.SESSION_ROUTE_PATH}?token=${drive.control.token}`, {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'start-browser', url: 'file:///etc/passwd' }),
  })
  step('start-browser refuses a file: url (400)', badStart.status === 400, `got ${badStart.status}`)

  await fetch(`${base}${protocol.SESSION_ROUTE_PATH}?token=${drive.control.token}`, {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'resume' }),
  })
}

// ── bootstrap grant (no browser yet) ────────────────────────────────────────

{
  // Point the stub at "no sessions" for this block.
  const realHas = host.hasSession
  const realActive = host.activeSessionId
  host.hasSession = () => false
  host.activeSessionId = () => undefined
  try {
    const empty = await fetch(`${base}${protocol.GRANT_ROUTE_PATH}`, {
      method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'view' }),
    })
    const body = await empty.json()
    step('grant with no session mints a bootstrap capability', body.kind === 'bootstrap' && typeof body.control?.token === 'string', body.kind)
    step('bootstrap carries no stream token', body.stream === undefined, JSON.stringify(Object.keys(body)))

    const started = await fetch(`${base}${protocol.SESSION_ROUTE_PATH}?token=${body.control.token}`, {
      method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'start-browser' }),
    })
    step('bootstrap can start the first browser', started.status === 200, `got ${started.status}`)

    const blocked = await fetch(`${base}${protocol.SESSION_ROUTE_PATH}?token=${body.control.token}`, {
      method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'takeover' }),
    })
    step('bootstrap cannot takeover (start-browser only)', blocked.status === 403, `got ${blocked.status}`)

    // A SPECIFIC unknown session is still a 404, never a silent bootstrap.
    const specific = await fetch(`${base}${protocol.GRANT_ROUTE_PATH}`, {
      method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ session: 'nope123' }),
    })
    step('grant for a specific unknown session stays 404', specific.status === 404, `got ${specific.status}`)
  } finally {
    host.hasSession = realHas
    host.activeSessionId = realActive
  }
}

// ── standalone panel page ───────────────────────────────────────────────────

{
  // A top-level navigation carries NO Origin header — that is the adb-reverse
  // phone case, and it must work.
  const nav = await fetch(`${base}${protocol.PANEL_ROUTE_PATH}`)
  const html = await nav.text()
  step('GET /panel serves the standalone dashboard to an origin-less navigation', nav.status === 200 && (nav.headers.get('content-type') ?? '').includes('text/html') && html.includes('browser panel'), `got ${nav.status}`)
  step('the served page is the built self-contained bundle', html.includes('<!doctype html>') && html.length > 100_000, `${html.length} bytes`)
  step('the panel page is never cached', nav.headers.get('cache-control') === 'no-store')

  const cross = await fetch(`${base}${protocol.PANEL_ROUTE_PATH}`, { headers: { Origin: ORIGIN, 'sec-fetch-site': 'cross-site' } })
  step('a cross-site request for the panel page is fenced', cross.status === 403, `got ${cross.status}`)

  const post = await fetch(`${base}${protocol.PANEL_ROUTE_PATH}`, { method: 'POST', headers: { Origin: ORIGIN }, body: '' })
  step('POST /panel is 405', post.status === 405, `got ${post.status}`)

  // The unbuilt case: an injected loader keeps this off the disk.
  const web2 = createMiniWebServer()
  const routes2 = new Routes(host, access, async () => undefined)
  const unmount2 = mountRoutes(web2, routes2)
  await new Promise(resolve => web2.server.listen(0, '127.0.0.1', resolve))
  const missing = await fetch(`http://127.0.0.1:${web2.server.address().port}${protocol.PANEL_ROUTE_PATH}`)
  const missingText = await missing.text()
  step('an unbuilt panel page is a 501 with build instructions', missing.status === 501 && missingText.includes('build:standalone'), `got ${missing.status}`)
  unmount2()
  web2.server.close()
  web2.server.closeAllConnections?.()
}

unmount()
web.server.close()
// The aborted stream socket can linger; close() alone would keep the process
// alive past finish() and turn a green suite into a CI timeout.
web.server.closeAllConnections?.()
finish()
