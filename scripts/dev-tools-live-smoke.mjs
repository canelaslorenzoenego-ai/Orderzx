/**
 * Tools live smoke — the tool families no other live suite touches against a
 * REAL browser: files (upload fence + setInputFiles + click-download),
 * tabs (new/select/close), desktop_view (emulation toggle round-trip),
 * transcript (the page-text fallback on a non-YouTube page), and the
 * screencast frame tier (Page.startScreencast on an attached browser).
 *
 * Needs: DSH_BROWSER_LIVE=1, DSH_BROWSER_LIVE_PROVIDER=cdp,
 * DSH_BROWSER_LIVE_CDP=http://127.0.0.1:9222. SKIPs (exit 0) without
 * DSH_BROWSER_LIVE=1 so it can sit in CI chains unconditionally.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import http from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createStepReporter } from './_smoke-harness.mjs'

if (process.env.DSH_BROWSER_LIVE !== '1') {
  console.log('tools-live smoke skipped: set DSH_BROWSER_LIVE=1')
  process.exit(0)
}
const LIVE_PROVIDER = process.env.DSH_BROWSER_LIVE_PROVIDER ?? 'patchright'
const LIVE_CDP = process.env.DSH_BROWSER_LIVE_CDP ?? null

const { step, finish } = createStepReporter()
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const { BrowserHostController } = await import(pathToFileURL(join(root, 'lib', 'host.js')).href)
const { AccessController, profileRoot } = await import(pathToFileURL(join(root, 'lib', 'access.js')).href)
const { resolveConfig } = await import(pathToFileURL(join(root, 'lib', 'config.js')).href)
const { createBrowserTools } = await import(pathToFileURL(join(root, 'lib', 'tools.js')).href)
if (LIVE_PROVIDER === 'cdp' && LIVE_CDP) {
  const { configureCdpEndpoint } = await import(pathToFileURL(join(root, 'lib', 'engine', 'cdp.js')).href)
  configureCdpEndpoint(LIVE_CDP)
}

// ── fixture: file input, download link, plain text ─────────────────────────
const fixture = http.createServer((req, res) => {
  if (req.url === '/file') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="report.txt"' })
    res.end('downloaded-bytes')
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><html><head><title>Tools Fixture</title></head><body>
<h1>dsh-browser tools fixture</h1>
<p>Some transcript-worthy body text lives here.</p>
<input type="file" id="f" aria-label="Upload" />
<a id="dl" href="/file" download="report.txt">Download report</a>
</body></html>`)
})
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`

// ── real host + tools ───────────────────────────────────────────────────────
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
  tools[name].execute(args, { callId: `tl-${name}`, rootCallId: `tl-${name}`, name, arguments: args, signal: AbortSignal.timeout(45_000) })

try {
  const start = await runTool('browser_start', { url: fixtureUrl, label: 'tools-live' })
  step('session starts on the fixture', start?.ok === true, JSON.stringify(start).slice(0, 140))
  const session = start.session

  const obs = await runTool('browser_observe', { session })
  const refOf = name => (obs?.elements ?? []).find(e => (e.name ?? '').includes(name))?.ref
  const uploadRef = refOf('Upload')
  const downloadRef = refOf('Download report')
  step('observe exposes the file input and download link refs', !!uploadRef && !!downloadRef, JSON.stringify({ uploadRef, downloadRef }))

  // ── files: the fence ──────────────────────────────────────────────────────
  const fenced = await runTool('browser_files', { session, action: 'upload', ref: uploadRef, paths: ['/etc/passwd'] })
  step('upload outside the profile root is fenced', fenced?.ok === false && /fence/i.test(fenced.message ?? ''), JSON.stringify(fenced).slice(0, 140))
  const traversal = await runTool('browser_files', { session, action: 'upload', ref: uploadRef, paths: [join(profileRoot(), '..', '..', 'etc', 'passwd')] })
  step('upload traversal out of the profile root is fenced', traversal?.ok === false && /fence/i.test(traversal.message ?? ''), JSON.stringify(traversal).slice(0, 140))

  // ── files: a staged upload lands on the input ─────────────────────────────
  mkdirSync(profileRoot(), { recursive: true })
  const staged = join(profileRoot(), 'tools-live-upload.txt')
  writeFileSync(staged, 'staged-bytes-for-upload')
  const uploaded = await runTool('browser_files', { session, action: 'upload', ref: uploadRef, paths: [staged] })
  step('a staged file uploads', uploaded?.ok === true && uploaded.uploaded === 1, JSON.stringify(uploaded).slice(0, 140))
  const filesLen = await runTool('browser_evaluate', { session, script: 'document.getElementById("f").files.length' })
  step('the input actually holds the file', filesLen?.ok === true && filesLen.result === 1, JSON.stringify(filesLen).slice(0, 120))

  // ── files: click-download streams into the profile ────────────────────────
  const downloaded = await runTool('browser_files', { session, action: 'download', ref: downloadRef, timeoutMs: 15_000 })
  step('download by ref saves under the profile', downloaded?.ok === true && typeof downloaded.path === 'string' && downloaded.bytes > 0, JSON.stringify(downloaded).slice(0, 180))
  step('the saved bytes are the served bytes', downloaded?.ok === true && existsSync(downloaded.path) && readFileSync(downloaded.path, 'utf8') === 'downloaded-bytes', downloaded?.path ?? '')
  step('the site filename was sanitized, not trusted as a path', downloaded?.suggested === 'report.txt', String(downloaded?.suggested))

  // ── tabs (relative counts — the attached browser may hold unrelated tabs) ──
  const listed = await runTool('browser_tabs', { session, action: 'list' })
  const before = listed?.tabs?.length ?? 0
  const fixtureIndex = (listed?.tabs ?? []).findIndex(t => (t.url ?? '').startsWith(`http://127.0.0.1:${fixture.address().port}/`) && !(t.url ?? '').includes('tab=2'))
  const opened = await runTool('browser_tabs', { session, action: 'new', url: `${fixtureUrl}?tab=2` })
  const openedIndex = (opened?.tabs ?? []).findIndex(t => (t.url ?? '').includes('tab=2'))
  step('tabs new opens a tab', opened?.ok === true && (opened.tabs?.length ?? 0) === before + 1 && openedIndex >= 0, JSON.stringify({ before, openedIndex, total: opened?.tabs?.length }).slice(0, 160))
  const back = await runTool('browser_tabs', { session, action: 'select', index: fixtureIndex })
  step('tabs select returns to the fixture tab', back?.ok === true && back.active === fixtureIndex, JSON.stringify({ fixtureIndex, active: back?.active }).slice(0, 140))
  const closed = await runTool('browser_tabs', { session, action: 'close', index: openedIndex })
  step('tabs close removes the tab it opened', closed?.ok === true && (closed.tabs?.length ?? 0) === before, JSON.stringify({ before, total: closed?.tabs?.length }).slice(0, 140))

  // ── desktop_view round-trip ───────────────────────────────────────────────
  const dvOn = await runTool('browser_desktop_view', { session, enabled: true })
  step('desktop_view on succeeds', dvOn?.ok === true, JSON.stringify(dvOn).slice(0, 140))
  const dvOff = await runTool('browser_desktop_view', { session, enabled: false })
  step('desktop_view off succeeds', dvOff?.ok === true, JSON.stringify(dvOff).slice(0, 140))
  const afterDv = await runTool('browser_observe', { session })
  step('the page is still observable after the emulation round-trip', /Tools Fixture/.test(afterDv?.title ?? '') && !afterDv?.refused, JSON.stringify(afterDv?.title))

  // ── transcript: the page-text fallback on a non-YouTube page ─────────────
  const transcript = await runTool('browser_transcript', { session })
  step('transcript falls back to page text', transcript?.ok === true && transcript.source === 'page-text' && (transcript.lines ?? []).join(' ').includes('transcript-worthy'), JSON.stringify(transcript).slice(0, 180))

  // ── screencast tier on an attached browser ────────────────────────────────
  const toScreencast = await host.setFrameSource(session, 'screencast')
  step('setFrameSource accepts screencast', toScreencast?.ok === true, JSON.stringify(toScreencast).slice(0, 120))
  await new Promise(resolve => setTimeout(resolve, 2500))
  const statsSc = host.session(session)?.frames?.stats?.()
  step('the screencast tier actually produces frames', statsSc?.effective === 'screencast' && statsSc.lastSequence > 0 && statsSc.bytes > 0, JSON.stringify(statsSc))
  const toShot = await host.setFrameSource(session, 'screenshot')
  await new Promise(resolve => setTimeout(resolve, 800))
  const statsShot = host.session(session)?.frames?.stats?.()
  step('back to screenshot tier cleanly', toShot?.ok === true && statsShot?.effective === 'screenshot' && statsShot.lastSequence > 0, JSON.stringify(statsShot))

  const stop = await runTool('browser_stop', { session })
  step('session stops', stop?.ok === true, JSON.stringify(stop).slice(0, 120))
} catch (error) {
  step(`tools-live conversation failed: ${error?.message ?? error}`, false)
} finally {
  await host.dispose()
  fixture.close()
}

finish()
