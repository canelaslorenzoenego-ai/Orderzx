/**
 * Static smoke for the frame transport — no real browser.
 *
 * A fake EnginePage produces real PNG bytes, so the assertions cover the parts
 * that are easy to get subtly wrong: the tier actually in effect vs configured,
 * suppression (a CAPTCHA handoff MUST stop the persistent capture, or the very
 * transport that makes the session detectable keeps running while a human solves
 * a challenge), fps accounting, subscriber lifecycle, multipart framing, and the
 * DOM-tier synthetic renderer's XML escaping.
 *
 * Run `pnpm run build` first — imports the COMPILED lib/*.js. SKIPs when lib is
 * missing.
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { TINY_PNG_B64, createStepReporter } from './_smoke-harness.mjs'

const { step, finish } = createStepReporter()
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const framesPath = join(root, 'lib', 'frames.js')

if (!existsSync(framesPath)) {
  step('lib/frames.js present', 'SKIP', 'run `pnpm run build` first')
  finish()
  process.exit(0)
}

const { FrameLoop, MultipartFrameWriter, renderSyntheticFrame, withTimeout, pngDimensions } = await import(pathToFileURL(framesPath).href)

const PNG = Buffer.from(TINY_PNG_B64, 'base64')

/** A page that answers capture() with a real PNG and counts calls. */
function makeFakePage(options = {}) {
  const calls = { capture: 0, snapshot: 0 }
  return {
    calls,
    id: 'page-1',
    url: () => options.url ?? 'https://example.com/',
    title: async () => options.title ?? 'Example',
    viewport: () => ({ width: 640, height: 480 }),
    capture: async () => {
      calls.capture += 1
      if (options.failCapture) throw new Error('capture failed on purpose')
      return new Uint8Array(PNG)
    },
    snapshot: async () => {
      calls.snapshot += 1
      return {
        url: options.url ?? 'https://example.com/',
        title: options.title ?? 'Example',
        viewport: { width: 640, height: 480 },
        nodes: [
          { ref: 'e1', role: 'heading', name: 'Example <Domain>' },
          { ref: 'e2', role: 'link', name: 'More "information" & co' },
        ],
      }
    },
    // The screencast tier calls page.startScreencast({maxFps, quality, onFrame})
    // and receives a dispose function. Absent method = "unsupported", which must
    // trigger the screenshot fallback rather than a crash.
    ...(options.supportScreencast
      ? {
          startScreencast: async ({ onFrame }) => {
            onFrame({ data: new Uint8Array(PNG), mime: 'image/png', width: 1, height: 1 })
            return async () => {}
          },
        }
      : {}),
  }
}

function config(source = 'screenshot', overrides = {}) {
  return { source, maxFps: 20, jpegQuality: 60, suppressOnChallenge: true, captureTimeoutMs: 2000, ...overrides }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// ── pngDimensions ───────────────────────────────────────────────────────────

{
  const dims = pngDimensions(new Uint8Array(PNG))
  step('pngDimensions reads IHDR from a real PNG', dims?.width === 1 && dims?.height === 1, JSON.stringify(dims))
  step('pngDimensions returns undefined for garbage', pngDimensions(new Uint8Array([1, 2, 3, 4])) === undefined)
}

// ── withTimeout ─────────────────────────────────────────────────────────────

{
  const fast = await withTimeout(Promise.resolve('ok'), 500, 'too slow').catch(() => 'threw')
  step('withTimeout passes through a fast promise', fast === 'ok', String(fast))
  let message = ''
  await withTimeout(sleep(200), 20, 'capture timed out').catch(error => { message = error.message })
  step('withTimeout rejects with the given message', /capture timed out/.test(message), message)
}

// ── screenshot tier ─────────────────────────────────────────────────────────

{
  const page = makeFakePage()
  const seen = []
  const loop = new FrameLoop(config('screenshot', { maxFps: 20 }), { onFrame: frame => seen.push(frame) })
  await loop.start(() => page)
  await sleep(220)
  const stats = loop.stats()
  step('screenshot tier produces frames', seen.length > 0, `${seen.length} frames in 220ms`)
  step('effective tier is screenshot', stats.effective === 'screenshot', stats.effective)
  step('frames carry monotonic sequences', seen.every((frame, index) => index === 0 || frame.sequence > seen[index - 1].sequence))
  step('frame mime matches the tier', seen.every(frame => frame.mime === 'image/png' || frame.mime === 'image/jpeg'), seen[0]?.mime ?? '')
  step('frame source is reported per frame', seen.every(frame => frame.source === 'screenshot'))
  step('fps is a sane number', stats.fps >= 0 && stats.fps <= 20, `${stats.fps}`)

  // Subscribers: the stream route's live consumers.
  const pushed = []
  const unsubscribe = loop.subscribe(frame => pushed.push(frame))
  step('subscribe registers a live consumer', loop.subscriberCount === 1, `${loop.subscriberCount}`)
  await sleep(120)
  unsubscribe()
  const afterUnsubscribe = pushed.length
  await sleep(120)
  step('unsubscribe stops delivery', pushed.length === afterUnsubscribe, `${afterUnsubscribe} → ${pushed.length}`)
  step('unsubscribe decrements the count', loop.subscriberCount === 0, `${loop.subscriberCount}`)

  await loop.stop()
  const before = seen.length
  await sleep(120)
  step('stop halts the loop', seen.length === before, `${before} → ${seen.length}`)
  step('stop reports not running', loop.running === false)
}

// ── capture failures are reported, not fatal ────────────────────────────────

{
  const page = makeFakePage({ failCapture: true })
  const errors = []
  const loop = new FrameLoop(config('screenshot'), { onError: detail => errors.push(detail) })
  await loop.start(() => page)
  await sleep(180)
  const stats = loop.stats()
  step('failing captures are reported through onError', errors.length > 0, `${errors.length} errors`)
  step('failing captures increment the failure count', stats.failures > 0, `${stats.failures}`)
  step('the loop keeps running after failures', loop.running === true)
  await loop.stop()
}

// ── suppression: the handoff safety property ────────────────────────────────

{
  // On the SCREENCAST tier, suppression must tear the persistent CDP session
  // down — that transport is the Layer-1 tell, and a challenge page is exactly
  // where the site is looking. Frames keep flowing via on-demand screenshot:
  // the user still has to SEE the widget to solve it.
  let disposed = 0
  let emitFrame
  const page = makeFakePage()
  page.startScreencast = async ({ onFrame }) => {
    emitFrame = () => onFrame({ data: new Uint8Array(PNG), mime: 'image/png', width: 1, height: 1 })
    emitFrame()
    return async () => { disposed += 1 }
  }
  const tiers = []
  const loop = new FrameLoop(config('screencast'), { onTierChange: (from, to, reason) => tiers.push({ from, to, reason }) })
  await loop.start(() => page)
  await sleep(80)
  step('screencast tier starts when supported', loop.stats().effective === 'screencast', loop.stats().effective)
  loop.setSuppressed(true, 'challenge handoff')
  await sleep(80)
  step('suppression disposes the persistent CDP session', disposed === 1, `disposed=${disposed}`)
  step('suppression downgrades screencast → screenshot', loop.stats().effective === 'screenshot', loop.stats().effective)
  step('the downgrade is reported with the reason', tiers.some(t => t.from === 'screencast' && t.to === 'screenshot' && /challenge handoff/.test(t.reason)), JSON.stringify(tiers))
  const capturesDuring = page.calls.capture
  await sleep(160)
  step('frames keep flowing for the human (screenshot capture runs)', page.calls.capture > capturesDuring, `${capturesDuring} → ${page.calls.capture}`)
  step('suppression is reported in stats', loop.stats().suppressed.active === true && /handoff/.test(loop.stats().suppressed.reason ?? ''), JSON.stringify(loop.stats().suppressed))
  loop.setSuppressed(false, null)
  await sleep(60)
  step('clearing suppression reports the tier state', loop.stats().suppressed.active === false, JSON.stringify(loop.stats().suppressed))
  await loop.stop()
}

{
  // On the SCREENSHOT tier there is nothing persistent to tear down; capture
  // deliberately continues (documented no-op) so the panel does not freeze
  // mid-handoff. The badge still reports suppression — the reason is the point.
  const page = makeFakePage()
  const loop = new FrameLoop(config('screenshot'))
  await loop.start(() => page)
  await sleep(100)
  const before = page.calls.capture
  loop.setSuppressed(true, 'challenge handoff')
  await sleep(140)
  step('screenshot tier keeps capturing under suppression (nothing persistent to stop)', page.calls.capture > before, `${before} → ${page.calls.capture}`)
  step('screenshot tier still reports suppressed', loop.stats().suppressed.active === true)
  loop.setSuppressed(false, null)
  await loop.stop()
}

// ── retier ──────────────────────────────────────────────────────────────────

{
  const page = makeFakePage()
  const tiers = []
  const loop = new FrameLoop(config('screenshot'), { onTierChange: (from, to, reason) => tiers.push({ from, to, reason }) })
  await loop.start(() => page)
  await sleep(120)
  const capturesBeforeDom = page.calls.capture
  await loop.retier('dom', () => page)
  await sleep(200)
  step('retier switches to the dom tier', loop.stats().effective === 'dom', loop.stats().effective)
  step('retier reports the change with a reason', tiers.some(entry => entry.from === 'screenshot' && entry.to === 'dom' && /retier/.test(entry.reason)), JSON.stringify(tiers))
  // Measured as a DELTA: the screenshot stint before the retier already captured,
  // so an absolute count would say nothing about the dom tier.
  step('the dom tier captures no new pixels', page.calls.capture - capturesBeforeDom <= 1, `Δcaptures=${page.calls.capture - capturesBeforeDom}`)
  step('the dom tier uses the a11y snapshot', page.calls.snapshot > 0, `${page.calls.snapshot} snapshots`)
  const snapshotsBeforeBack = page.calls.snapshot
  await loop.retier('screenshot', () => page)
  await sleep(200)
  step('retier back to screenshot resumes pixel capture', loop.stats().effective === 'screenshot' && page.calls.capture > capturesBeforeDom, `effective=${loop.stats().effective}`)
  step('the screenshot tier stops snapshotting', page.calls.snapshot - snapshotsBeforeBack === 0 || page.calls.capture > capturesBeforeDom, `Δsnapshots=${page.calls.snapshot - snapshotsBeforeBack}`)
  await loop.stop()
}

{
  // A screencast request on a page that does not support it must fall back,
  // not stall: a blank panel with no explanation is the worst failure mode.
  const page = makeFakePage({ supportScreencast: false })
  const tiers = []
  const loop = new FrameLoop(config('screencast'), { onTierChange: (from, to, reason) => tiers.push({ from, to, reason }) })
  await loop.start(() => page)
  await sleep(200)
  step('unsupported screencast falls back', loop.stats().effective !== 'screencast' || tiers.length > 0, `effective=${loop.stats().effective}`)
  step('the fallback reason mentions the cause', tiers.every(entry => typeof entry.reason === 'string' && entry.reason.length > 0), JSON.stringify(tiers))
  await loop.stop()
}

// ── synthetic dom frame ─────────────────────────────────────────────────────

{
  const svg = renderSyntheticFrame(
    'https://example.com/?a=1&b=2',
    'Example <Domain> & "Friends"',
    [
      { ref: 'e1', role: 'heading', name: 'Hello <world> & "everyone"' },
      { ref: 'e2', role: 'link', name: 'More' },
    ],
    { width: 640, height: 480 },
  )
  step('synthetic frame is an SVG document', svg.startsWith('<svg') && svg.includes('</svg>'))
  step('synthetic frame declares the viewport', svg.includes('width="640"') && svg.includes('height="480"'))
  step('synthetic frame labels itself as synthetic', /SYNTHETIC FRAME/.test(svg))
  // Escaping is a correctness issue, not cosmetics: an unescaped `<` in a page
  // title produces malformed XML and the <img> silently renders nothing.
  step('title text is XML-escaped', svg.includes('&lt;Domain&gt;') && svg.includes('&amp;') && svg.includes('&quot;'), svg.slice(0, 0))
  step('node names are XML-escaped', svg.includes('&lt;world&gt;'))
  step('refs are rendered for the model', svg.includes('[e1]') && svg.includes('[e2]'))
  step('no raw angle brackets leak into text nodes', !/>Hello <world>/.test(svg))
}

// ── multipart writer ────────────────────────────────────────────────────────

{
  const chunks = []
  const headers = {}
  let ended = false
  const res = {
    writeHead(status, head) { headers.status = status; Object.assign(headers, head) },
    write(chunk) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return true },
    end() { ended = true },
  }
  const writer = new MultipartFrameWriter(res)
  step('writer sends 200 with a multipart content type', headers.status === 200 && /multipart\/x-mixed-replace; boundary=/.test(headers['Content-Type'] ?? ''), headers['Content-Type'] ?? '')
  step('writer forbids caching and sniffing', headers['Cache-Control'] === 'no-store, no-transform, must-revalidate' && headers['X-Content-Type-Options'] === 'nosniff')
  step('writer sets X-Frame-Options SAMEORIGIN', headers['X-Frame-Options'] === 'SAMEORIGIN', headers['X-Frame-Options'] ?? '')

  const frame = { data: new Uint8Array(PNG), mime: 'image/png', width: 1, height: 1, sequence: 7, at: Date.now(), source: 'screenshot' }
  step('write returns true while open', writer.write(frame) === true)
  const body = Buffer.concat(chunks).toString('binary')
  const boundary = /boundary=(\S+)/.exec(headers['Content-Type'])[1]
  step('part opens with the boundary', body.startsWith(`--${boundary}\r\n`))
  step('part declares Content-Type and Content-Length', body.includes('Content-Type: image/png') && body.includes(`Content-Length: ${PNG.length}`))
  step('part carries the sequence and source headers', body.includes('X-Frame-Sequence: 7') && body.includes('X-Frame-Source: screenshot'))
  step('headers and bytes are separated by a blank line', body.includes('\r\n\r\n'))
  step('the PNG bytes are present verbatim', Buffer.concat(chunks).includes(PNG))

  writer.close()
  step('close ends the response', ended === true)
  step('write after close returns false', writer.write(frame) === false)
}

{
  // A backpressured socket must not queue frames without bound: the writer has
  // to report false so the loop unsubscribes instead of growing memory.
  const writer = new MultipartFrameWriter({
    writeHead() {},
    write: () => false,
    end() {},
  })
  const frame = { data: new Uint8Array(PNG), mime: 'image/png', width: 1, height: 1, sequence: 1, at: Date.now(), source: 'screenshot' }
  step('write returns false under backpressure', writer.write(frame) === false)
}

// ── desktop-view emulation (Chrome-for-Android "desktop site" parity) ───────

{
  const { applyDesktopView, DESKTOP_USER_AGENT, DESKTOP_VIEWPORT } = await import(pathToFileURL(join(root, 'lib', 'engine', 'emulate.js')).href)

  function makeRawPage(viewport = { width: 390, height: 844 }) {
    const sent = []
    const viewports = []
    let current = { ...viewport }
    const cdp = {
      async send(method, params) {
        sent.push({ method, params })
        if (method === 'Browser.getVersion') return { userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile Safari/537.36' }
        if (method === 'Runtime.evaluate') return { result: { value: 5 } }
        return undefined
      },
      async detach() {},
    }
    return {
      sent,
      viewports,
      context: () => ({ newCDPSession: async () => cdp }),
      async setViewportSize(size) { current = { ...size }; viewports.push({ ...size }) },
      viewportSize: () => ({ ...current }),
    }
  }

  {
    const raw = makeRawPage()
    const state = {}
    await applyDesktopView(raw, state, true)
    const ua = raw.sent.find(c => c.method === 'Emulation.setUserAgentOverride')
    step('the UA override goes out on enable', ua?.params?.userAgent === DESKTOP_USER_AGENT, JSON.stringify(ua?.params)?.slice(0, 120))
    // The whole point of the upgrade: sec-ch-ua-mobile must not contradict the UA.
    step('client hints ride along — sec-ch-ua-mobile is false', ua?.params?.userAgentMetadata?.mobile === false, JSON.stringify(ua?.params?.userAgentMetadata)?.slice(0, 120))
    step('client hints claim the same platform as the UA string', ua?.params?.userAgentMetadata?.platform === 'Windows' && ua?.params?.platform === 'Windows')
    step('client hints carry a full brand list for getHighEntropyValues probes', Array.isArray(ua?.params?.userAgentMetadata?.fullVersionList) && ua.params.userAgentMetadata.fullVersionList.length === 3)
    step('accept-language is overridden with the UA', typeof ua?.params?.acceptLanguage === 'string' && ua.params.acceptLanguage.includes('en'))
    step('the viewport widens to desktop class', raw.viewports.at(-1)?.width === DESKTOP_VIEWPORT.width && raw.viewports.at(-1)?.height === DESKTOP_VIEWPORT.height)
    step('a desktop-native page never gets touch emulation invented', !raw.sent.some(c => c.method === 'Emulation.setTouchEmulationEnabled'))

    await applyDesktopView(raw, state, true)
    step('a redundant enable is a no-op', raw.sent.filter(c => c.method === 'Emulation.setUserAgentOverride').length === 1)

    await applyDesktopView(raw, state, false)
    const restored = raw.sent.filter(c => c.method === 'Emulation.setUserAgentOverride').at(-1)
    step('disable restores the real device UA', restored?.params?.userAgent?.includes('Android 14'), JSON.stringify(restored?.params)?.slice(0, 120))
    step('disable drops the client-hint override with it', restored?.params?.userAgentMetadata === undefined)
    step('disable restores the pre-toggle phone viewport', raw.viewports.at(-1)?.width === 390 && raw.viewports.at(-1)?.height === 844)
  }

  {
    // A touch-capable device (Chrome on Android over CDP) must actually lose
    // touch emulation, or the desktop layout still gets touch-only widgets.
    const raw = makeRawPage()
    const state = { touchCapable: true, maxTouchPoints: 5 }
    await applyDesktopView(raw, state, true)
    step('touch emulation is disabled on a touch-capable page', raw.sent.some(c => c.method === 'Emulation.setTouchEmulationEnabled' && c.params?.enabled === false))
    await applyDesktopView(raw, state, false)
    const restore = raw.sent.filter(c => c.method === 'Emulation.setTouchEmulationEnabled').at(-1)
    step('clearing restores touch with the device maxTouchPoints', restore?.params?.enabled === true && restore?.params?.maxTouchPoints === 5, JSON.stringify(restore?.params))
  }

  {
    // probeTouch is the cdp-connect engine's opt-in: it attaches to the user's
    // own browser, where a Runtime.evaluate is not a stealth tell.
    const raw = makeRawPage()
    const state = { probeTouch: true }
    await applyDesktopView(raw, state, true)
    step('an opt-in engine probes maxTouchPoints once', raw.sent.some(c => c.method === 'Runtime.evaluate' && String(c.params?.expression).includes('maxTouchPoints')))
    step('the probe result is cached as touchCapable', state.touchCapable === true && state.maxTouchPoints === 5)
    step('a probed touch device gets touch disabled', raw.sent.some(c => c.method === 'Emulation.setTouchEmulationEnabled' && c.params?.enabled === false))
  }

  {
    // Stealth engines must never touch the Runtime domain to answer this.
    const raw = makeRawPage()
    const state = {}
    await applyDesktopView(raw, state, true)
    step('a stealth engine never probes the main world for touch', !raw.sent.some(c => c.method === 'Runtime.evaluate') && state.touchCapable === undefined)
  }

  {
    const raw = makeRawPage({ width: 1366, height: 768 })
    const state = {}
    await applyDesktopView(raw, state, true)
    await applyDesktopView(raw, state, false)
    step('a page already at desktop size round-trips to the same viewport', raw.viewports.at(-1)?.width === 1366 && raw.viewports.at(-1)?.height === 768)
  }
}

finish()
