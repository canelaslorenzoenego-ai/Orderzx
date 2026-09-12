/**
 * Signed HTTP routes, mounted on the OPTIONAL `webServer` service.
 *
 * Headless and sdk profiles have no webServer, so everything here is
 * optional-injected and every tool still works without it — the same
 * degradation contract dsh-android holds. `installRoutes` is the only entry
 * point the host uses; `mountRoutes` is exported separately so the smoke
 * scripts can exercise the handlers against a fake webServer with no harness.
 *
 * Route inventory
 * ───────────────
 *   GET  /stream     multipart/x-mixed-replace frame stream   (view)
 *   GET  /capture/*  one PNG/JPEG capture                     (view)
 *   POST /grant      mint a capability for this client        (session-scoped)
 *   GET  /status     phase + tabs + frames + stealth posture  (view)
 *   POST /control    human → browser input                    (drive)
 *   POST /session    takeover / resume / abort / tier switch  (drive)
 *   POST /challenge  human resolved the challenge             (drive)
 *   GET  /panel      the STANDALONE dashboard page            (fence only)
 *
 * Every handler runs the transport fence FIRST (`isTrustedRequest`), then the
 * capability check, then the work. That ordering is not stylistic: a capability
 * is a bearer token, and the fence is what stops a token leaked to a LAN peer
 * from being usable.
 *
 * @module @dsh-community/dsh-browser/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  CAPTURE_ROUTE_PREFIX,
  CHALLENGE_ROUTE_PATH,
  CONTROL_ROUTE_PATH,
  GRANT_ROUTE_PATH,
  INTERACTIONS_ROUTE_PREFIX,
  PANEL_ROUTE_PATH,
  SESSION_ROUTE_PATH,
  STATUS_ROUTE_PATH,
  STREAM_ROUTE_PREFIX,
} from './protocol.js'
import type { BrowserStatus, ControlMessage, FrameSource, SessionMessage } from './protocol.js'
import { FRAME_SOURCES } from './protocol.js'
import { AccessController, isTrustedRequest, openVerifiedCapture } from './access.js'
import { MultipartFrameWriter } from './frames.js'
import type { BrowserHostController } from './host.js'

/** The slice of `webServer` we use. Structural, so a version bump that adds members still type-checks. */
export interface WebServerMount {
  register(route: { kind: 'prefix' | 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }): () => void
}

export interface RouteHandlers {
  handleStream(req: IncomingMessage, res: ServerResponse): void
  handleCapture(req: IncomingMessage, res: ServerResponse): Promise<void>
  handleGrant(req: IncomingMessage, res: ServerResponse): Promise<void>
  handleStatus(req: IncomingMessage, res: ServerResponse): Promise<void>
  handleControl(req: IncomingMessage, res: ServerResponse): Promise<void>
  handleSession(req: IncomingMessage, res: ServerResponse): Promise<void>
  handleChallenge(req: IncomingMessage, res: ServerResponse): Promise<void>
  handleInteractions(req: IncomingMessage, res: ServerResponse): void
  handlePanel(req: IncomingMessage, res: ServerResponse): Promise<void>
}

/**
 * The pseudo-session a bootstrap control token is minted for.
 *
 * A panel opened BEFORE any browser exists has nothing to scope a token to, but
 * its home tab must still be able to ask for the first launch. The bootstrap
 * token is drive-scoped for `start-browser` ONLY — every other session message
 * and both data routes 404 on it, because no session carries the id.
 */
const BOOTSTRAP_SESSION = 'bootstrap'

const MAX_BODY_BYTES = 64 * 1024

/** Supplies lib/standalone.html; undefined means "not built". Injectable so the smoke suite needs no disk. */
export type PanelHtmlLoader = () => Promise<string | undefined>

/** Default loader: the compiled routes.js lives in lib/ next to standalone.html. */
const defaultPanelLoader: PanelHtmlLoader = async () => {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    return await readFile(join(here, 'standalone.html'), 'utf8')
  } catch {
    return undefined
  }
}

export class Routes implements RouteHandlers {
  #panelHtml: string | undefined
  #panelLoaded = false

  constructor(
    private readonly host: BrowserHostController,
    private readonly access: AccessController,
    private readonly loadPanelHtml: PanelHtmlLoader = defaultPanelLoader,
  ) {}

  // ── standalone panel page ─────────────────────────────────────────────────

  /**
   * GET /panel — the full dashboard as a standalone page.
   *
   * Fence with requireOrigin=FALSE: this is a top-level navigation, and
   * navigations carry no Origin header — requiring one would make the page
   * unopenable by definition. The fence still enforces loopback + the
   * Fetch-Metadata cross-site refusal, the page contains no secrets, and every
   * capability it needs comes from a subsequent fetch to /grant, which IS
   * origin-fenced. Serving the shell is no more sensitive than serving the
   * extension's own HTML.
   */
  async handlePanel(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') return this.#fail(res, 405, 'GET only')
    if (!this.#fence(req, res, false)) return
    if (!this.#panelLoaded) {
      this.#panelLoaded = true
      this.#panelHtml = await this.loadPanelHtml()
    }
    if (this.#panelHtml === undefined) {
      res.writeHead(501, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end('<!doctype html><meta charset="utf-8"><title>panel not built</title>'
        + '<body style="font:14px system-ui;padding:32px;max-width:60ch">'
        + '<h3>The standalone panel page is not built.</h3>'
        + '<p>Run <code>pnpm run build:standalone</code> in the dsh-browser checkout, then reload.</p>')
      return
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(this.#panelHtml)),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(req.method === 'HEAD' ? undefined : this.#panelHtml)
  }

  // ── stream ────────────────────────────────────────────────────────────────

  handleStream(req: IncomingMessage, res: ServerResponse): void {
    if (!this.#fence(req, res, false)) return
    const url = requestUrl(req)
    if (!url) return this.#fail(res, 400, 'bad request')
    void (async () => {
      const payload = await this.access.verifyStreamToken(url.searchParams.get('token') ?? '')
      if (!payload) return this.#fail(res, 403, 'invalid or expired stream token')
      if (!this.host.hasSession(payload.session)) return this.#fail(res, 404, 'no such browser session')

      const writer = new MultipartFrameWriter(res)
      // Push the frame we already have so the panel paints instantly instead of
      // waiting up to a full interval.
      const latest = this.host.latestFrame(payload.session)
      if (latest) writer.write(latest)

      const unsubscribe = this.host.subscribeFrames(payload.session, frame => {
        if (!writer.write(frame)) unsubscribe()
      })
      const onClose = (): void => {
        unsubscribe()
        writer.close()
      }
      res.on('close', onClose)
      res.on('error', onClose)
    })().catch(() => this.#fail(res, 500, 'stream error'))
  }

  // ── capture ───────────────────────────────────────────────────────────────

  async handleCapture(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.#fence(req, res, false)) return
    const url = requestUrl(req)
    if (!url) return this.#fail(res, 400, 'bad request')
    const payload = await this.access.verifyCaptureToken(url.searchParams.get('token') ?? '')
    if (!payload) return this.#fail(res, 403, 'invalid or expired capture token')
    const file = await openVerifiedCapture(payload.path)
    if (!file) return this.#fail(res, 404, 'capture unavailable')
    res.writeHead(200, {
      'Content-Type': payload.path.endsWith('.png') ? 'image/png' : 'image/jpeg',
      'Content-Length': String(file.bytes.byteLength),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(file.bytes)
  }

  // ── grant ─────────────────────────────────────────────────────────────────

  /**
   * Mint capabilities for the calling client.
   *
   * The client already has a DSH session cookie and reached this route through
   * the harness's own origin, so the fence is the authorization here; we then
   * scope the token to the session id the client asks for. A client asking for
   * a session that does not exist gets a 404 rather than a token.
   */
  async handleGrant(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.#fence(req, res, true)) return
    const body = await readJson<{ session?: string; scope?: string; path?: string }>(req)
    if (!body) return this.#fail(res, 400, 'invalid JSON body')

    // A capture grant is path-scoped and needs no live session.
    if (typeof body.path === 'string' && body.path.length > 0) {
      const capture = await this.access.signCaptureToken(body.path)
      return this.#json(res, 200, { kind: 'capture', ...capture })
    }

    let session = typeof body.session === 'string' && body.session.length > 0 ? body.session : this.host.activeSessionId()
    if (session) session = this.host.resolveRef(session) ?? session
    if (!session || !this.host.hasSession(session)) {
      if (typeof body.session === 'string' && body.session.length > 0) {
        // Asked for a SPECIFIC session that does not exist: that is a 404, not
        // a bootstrap — silently minting a launch capability for a typo would
        // surprise the caller.
        return this.#fail(res, 404, 'no such browser session')
      }
      // No browser yet: hand out a bootstrap token so the home tab can start
      // the first one. Drive-scoped, but `start-browser` is its only route.
      const bootstrap = await this.access.signControlToken(BOOTSTRAP_SESSION, 'drive')
      return this.#json(res, 200, { kind: 'bootstrap', session: BOOTSTRAP_SESSION, scope: 'drive', control: bootstrap })
    }

    // `drive` is only handed out when the human explicitly took over. Granting it
    // by default would let any panel tab steer the agent's browser.
    const wantsDrive = body.scope === 'drive'
    const allowed = wantsDrive && this.host.takeoverActive(session)
    const scope = allowed ? 'drive' : 'view'
    const [stream, control] = await Promise.all([
      this.access.signStreamToken(session),
      this.access.signControlToken(session, scope),
    ])
    this.#json(res, 200, { kind: 'session', session, scope, stream, control })
  }

  // ── status ────────────────────────────────────────────────────────────────

  async handleStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.#fence(req, res, false)) return
    const url = requestUrl(req)
    const token = url?.searchParams.get('token') ?? ''
    // Status is readable with either a stream or a control token: the capsule
    // polls it before it has asked for a stream grant.
    const streamPayload = await this.access.verifyStreamToken(token)
    const controlPayload = streamPayload ? undefined : await this.access.verifyControlToken(token)
    const session = streamPayload?.session ?? controlPayload?.session
    if (!session) return this.#fail(res, 403, 'invalid or expired status token')
    this.#json(res, 200, this.host.status(session))
  }

  // ── control (human → browser) ─────────────────────────────────────────────

  async handleControl(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.#fence(req, res, true)) return
    const url = requestUrl(req)
    const payload = await this.access.verifyControlToken(url?.searchParams.get('token') ?? '')
    if (!payload) return this.#fail(res, 403, 'invalid or expired control token')
    if (payload.scope !== 'drive') {
      // 403, not 401: the token is valid, it just does not carry this scope.
      return this.#fail(res, 403, 'this token is view-scoped; take over the session first')
    }
    const body = await readJson<ControlMessage>(req)
    if (!body || typeof body !== 'object' || typeof (body as { kind?: unknown }).kind !== 'string') {
      return this.#fail(res, 400, 'invalid control message')
    }
    const verdict = validateControl(body)
    if (!verdict.ok) return this.#fail(res, 400, verdict.reason)
    const result = await this.host.applyHumanControl(payload.session, body)
    this.#json(res, result.ok ? 200 : 409, result)
  }

  // ── session (takeover / resume / abort / tier) ────────────────────────────

  async handleSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.#fence(req, res, true)) return
    const url = requestUrl(req)
    const payload = await this.access.verifyControlToken(url?.searchParams.get('token') ?? '')
    if (!payload) return this.#fail(res, 403, 'invalid or expired control token')
    const body = await readJson<SessionMessage>(req)
    if (!body || typeof (body as { kind?: unknown }).kind !== 'string') return this.#fail(res, 400, 'invalid session message')
    if (payload.session === BOOTSTRAP_SESSION && body.kind !== 'start-browser') {
      return this.#fail(res, 403, 'a bootstrap token can only start the first browser')
    }

    switch (body.kind) {
      // Taking over needs only `view`: that is the whole point — a viewer
      // promotes itself, and the host records who owns the pointer.
      case 'takeover': {
        const result = await this.host.beginTakeover(payload.session, 'user')
        return this.#json(res, result.ok ? 200 : 409, result)
      }
      case 'resume': {
        if (payload.scope !== 'drive') return this.#fail(res, 403, 'drive scope required')
        const result = await this.host.endTakeover(payload.session)
        return this.#json(res, result.ok ? 200 : 409, result)
      }
      case 'abort': {
        if (payload.scope !== 'drive') return this.#fail(res, 403, 'drive scope required')
        const result = await this.host.abortTask(payload.session)
        return this.#json(res, result.ok ? 200 : 409, result)
      }
      case 'frame-source': {
        if (payload.scope !== 'drive') return this.#fail(res, 403, 'drive scope required')
        if (!FRAME_SOURCES.includes(body.source as FrameSource)) return this.#fail(res, 400, 'unknown frame source')
        const result = await this.host.setFrameSource(payload.session, body.source)
        return this.#json(res, result.ok ? 200 : 409, result)
      }
      case 'switch-session': {
        if (payload.scope !== 'drive') return this.#fail(res, 403, 'drive scope required')
        const result = this.host.switchActive(body.id)
        return this.#json(res, result.ok ? 200 : 404, result)
      }
      case 'stop-browser': {
        if (payload.scope !== 'drive') return this.#fail(res, 403, 'drive scope required')
        const result = await this.host.stop(body.id, 'closed from panel')
        return this.#json(res, result.ok ? 200 : 409, result)
      }
      case 'set-desktop-view': {
        if (payload.scope !== 'drive') return this.#fail(res, 403, 'drive scope required')
        const result = await this.host.setDesktopView(payload.session, body.enabled === true, { reload: body.reload !== false })
        return this.#json(res, result.ok ? 200 : 409, result)
      }
      case 'set-debug-tap': {
        if (payload.scope !== 'drive') return this.#fail(res, 403, 'drive scope required')
        const result = await this.host.setDebugTap(payload.session, body.enabled === true)
        return this.#json(res, result.ok ? 200 : 409, result)
      }
      case 'set-recording': {
        if (payload.scope !== 'drive') return this.#fail(res, 403, 'drive scope required')
        const result = await this.host.setRecording(payload.session, body.enabled === true, typeof body.name === 'string' ? body.name : undefined)
        return this.#json(res, result.ok ? 200 : 409, result)
      }
      case 'start-browser': {
        // View scope is enough: launching a NEW browser hijacks no pointer and
        // touches no existing session — same reasoning as `takeover` needing
        // only view. The origin fence is the real gate here.
        if (payload.session !== BOOTSTRAP_SESSION && !this.host.hasSession(payload.session)) {
          return this.#fail(res, 404, 'no such browser session')
        }
        if (body.url !== undefined) {
          const check = validateControl({ kind: 'address', url: body.url })
          if (!check.ok) return this.#fail(res, 400, check.reason)
        }
        if (body.label !== undefined && (typeof body.label !== 'string' || body.label.length > 40)) {
          return this.#fail(res, 400, 'label must be a string of at most 40 characters')
        }
        // Awaited on purpose: the home tab shows a spinner until the browser is
        // actually live, and the response carries the id the panel then grants
        // a real stream token for.
        const started = await this.host.start({
          ...(body.url ? { url: body.url } : {}),
          ...(body.label ? { label: body.label } : {}),
        })
        return this.#json(res, started.ok ? 200 : 409, started)
      }
      default:
        return this.#fail(res, 400, 'unknown session message')
    }
  }

  // ── interactions (SSE) ────────────────────────────────────────────────────

  /**
   * Gesture trace as Server-Sent Events.
   *
   * Readable with a STREAM token (view scope): the trace carries coordinates,
   * gesture shapes and typed-text LENGTHS — never text — so watching it is
   * exactly as privileged as watching the frames. `since=<seq>` replays what a
   * reconnecting panel missed; if the gap fell out of the ring, a `resync`
   * event tells the client to drop its local overlay state.
   */
  handleInteractions(req: IncomingMessage, res: ServerResponse): void {
    if (!this.#fence(req, res, false)) return
    const url = requestUrl(req)
    if (!url) return this.#fail(res, 400, 'bad request')
    void (async () => {
      const payload = await this.access.verifyStreamToken(url.searchParams.get('token') ?? '')
      if (!payload) return this.#fail(res, 403, 'invalid or expired stream token')
      if (!this.host.hasSession(payload.session)) return this.#fail(res, 404, 'no such browser session')

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        Connection: 'keep-alive',
        // Proxies buffer SSE by default; the gestures are the point, so buffering
        // them into 30-second batches would defeat the channel.
        'X-Accel-Buffering': 'no',
      })

      const since = Number.parseInt(url.searchParams.get('since') ?? '0', 10)
      const send = (event: string, data: unknown, id?: number): void => {
        if (res.writableEnded) return
        if (id !== undefined) res.write(`id: ${id}\n`)
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }

      const backfill = this.host.interactionsSince(payload.session, Number.isFinite(since) && since >= 0 ? since : 0)
      if (backfill.resync) send('resync', { latest: backfill.latest })
      for (const record of backfill.records) send('interaction', record, record.seq)

      const unsubscribe = this.host.subscribeInteractions(payload.session, record => {
        send('interaction', record, record.seq)
      })
      // Heartbeat comment: keeps idle connections alive through the harness's
      // webserver and lets the client distinguish "quiet page" from "dead SSE".
      const heartbeat = setInterval(() => {
        if (res.writableEnded) return
        res.write(': hb\n\n')
      }, 15_000)
      const onClose = (): void => {
        clearInterval(heartbeat)
        unsubscribe()
        if (!res.writableEnded) res.end()
      }
      res.on('close', onClose)
      res.on('error', onClose)
    })().catch(() => this.#fail(res, 500, 'interactions error'))
  }

  // ── challenge ─────────────────────────────────────────────────────────────

  async handleChallenge(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.#fence(req, res, true)) return
    const url = requestUrl(req)
    const payload = await this.access.verifyControlToken(url?.searchParams.get('token') ?? '')
    if (!payload) return this.#fail(res, 403, 'invalid or expired control token')
    const body = await readJson<Extract<SessionMessage, { kind: 'handoff-resolved' }>>(req)
    if (!body || body.kind !== 'handoff-resolved') return this.#fail(res, 400, 'invalid challenge message')
    if (body.outcome !== 'passed' && body.outcome !== 'failed' && body.outcome !== 'abandoned') {
      return this.#fail(res, 400, 'invalid outcome')
    }
    const result = await this.host.resolveHandoff(payload.session, body.challengeId, body.outcome)
    this.#json(res, result.ok ? 200 : 409, result)
  }

  // ── shared ────────────────────────────────────────────────────────────────

  /**
   * The fence. Applied before ANY capability is consulted.
   *
   * `requireOrigin` is false for GET routes (an `<img src>` sends no Origin) and
   * true for POST routes (a same-origin fetch always does). That asymmetry is
   * deliberate and matches upstream.
   */
  #fence(req: IncomingMessage, res: ServerResponse, requireOrigin: boolean): boolean {
    if (!isTrustedRequest(req, requireOrigin)) {
      this.#fail(res, 403, 'forbidden')
      return false
    }
    return true
  }

  #json(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(text)),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(text)
  }

  #fail(res: ServerResponse, status: number, message: string): void {
    this.#json(res, status, { error: message })
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function requestUrl(req: IncomingMessage): URL | undefined {
  try {
    return new URL(req.url ?? '/', 'http://127.0.0.1')
  } catch {
    return undefined
  }
}

async function readJson<T>(req: IncomingMessage): Promise<T | undefined> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    total += buffer.byteLength
    if (total > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  if (chunks.length === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
  } catch {
    return undefined
  }
}

/**
 * Validate a control message by hand.
 *
 * The harness validates TOOL arguments; these are not tool arguments, they come
 * straight off a socket, so nothing else is checking them. Normalized
 * coordinates must be finite and in 0..1 — an out-of-range value would otherwise
 * become a click outside the viewport or, worse, a NaN that the driver rejects
 * mid-gesture and leaves the pointer in an unknown state.
 */
export function validateControl(message: ControlMessage): { ok: true } | { ok: false; reason: string } {
  const inRange = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
  switch (message.kind) {
    case 'pointer-down':
    case 'pointer-move':
    case 'pointer-up':
      if (!inRange(message.x) || !inRange(message.y)) return { ok: false, reason: 'x and y must be finite numbers in 0..1' }
      // pointer-move carries no button; the other two do.
      if ('button' in message && message.button !== undefined && !['left', 'right', 'middle'].includes(message.button)) {
        return { ok: false, reason: 'unknown button' }
      }
      return { ok: true }
    case 'wheel':
      if (!Number.isFinite(message.deltaX) || !Number.isFinite(message.deltaY)) return { ok: false, reason: 'deltas must be finite' }
      if (Math.abs(message.deltaY) > 20_000) return { ok: false, reason: 'deltaY out of bounds' }
      return { ok: true }
    case 'key':
      if (typeof message.key !== 'string' || message.key.length === 0 || message.key.length > 32) {
        return { ok: false, reason: 'key must be a 1–32 char string' }
      }
      if (message.text !== undefined && message.text.length > 512) return { ok: false, reason: 'text too long' }
      return { ok: true }
    case 'nav':
      if (!['back', 'forward', 'reload', 'stop'].includes(message.action)) return { ok: false, reason: 'unknown nav action' }
      return { ok: true }
    case 'address': {
      // Only http(s). `file:`, `chrome:`, `devtools:` and `javascript:` URLs are
      // how a drive-scoped token becomes local file read or script execution.
      let parsed: URL
      try {
        parsed = new URL(message.url)
      } catch {
        return { ok: false, reason: 'invalid url' }
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, reason: `refusing to navigate to a ${parsed.protocol} url` }
      }
      return { ok: true }
    }
    case 'swipe': {
      if (!Array.isArray(message.points) || message.points.length < 2 || message.points.length > 96) {
        return { ok: false, reason: 'swipe needs 2–96 path points' }
      }
      for (const point of message.points) {
        if (!inRange(point?.x) || !inRange(point?.y)) return { ok: false, reason: 'swipe points must be finite numbers in 0..1' }
      }
      return { ok: true }
    }
    case 'tab':
      if (!['select', 'close', 'new'].includes(message.action)) return { ok: false, reason: 'unknown tab action' }
      if (message.index !== undefined && (!Number.isInteger(message.index) || message.index < 0 || message.index > 64)) {
        return { ok: false, reason: 'tab index out of bounds' }
      }
      return { ok: true }
    default:
      return { ok: false, reason: 'unknown control message' }
  }
}

// ── mounting ────────────────────────────────────────────────────────────────

export function mountRoutes(webServer: WebServerMount, routes: RouteHandlers): () => void {
  const disposers = [
    webServer.register({ kind: 'prefix', path: STREAM_ROUTE_PREFIX, handler: (req, res) => routes.handleStream(req, res) }),
    webServer.register({ kind: 'prefix', path: CAPTURE_ROUTE_PREFIX, handler: (req, res) => void routes.handleCapture(req, res) }),
    webServer.register({ kind: 'prefix', path: INTERACTIONS_ROUTE_PREFIX, handler: (req, res) => routes.handleInteractions(req, res) }),
    webServer.register({ kind: 'exact', path: GRANT_ROUTE_PATH, handler: (req, res) => void routes.handleGrant(req, res) }),
    webServer.register({ kind: 'exact', path: STATUS_ROUTE_PATH, handler: (req, res) => void routes.handleStatus(req, res) }),
    webServer.register({ kind: 'exact', path: CONTROL_ROUTE_PATH, handler: (req, res) => void routes.handleControl(req, res) }),
    webServer.register({ kind: 'exact', path: SESSION_ROUTE_PATH, handler: (req, res) => void routes.handleSession(req, res) }),
    webServer.register({ kind: 'exact', path: CHALLENGE_ROUTE_PATH, handler: (req, res) => void routes.handleChallenge(req, res) }),
    webServer.register({ kind: 'exact', path: PANEL_ROUTE_PATH, handler: (req, res) => void routes.handlePanel(req, res) }),
  ]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

/**
 * Mount on the optional `webServer` service.
 *
 * `ctx.inject` + `ctx.effect` so a headless profile (no webServer) simply never
 * mounts, and so unloading the plugin removes the routes instead of leaving
 * handlers bound to a disposed controller.
 */
export function installRoutes(ctx: Context, host: BrowserHostController, access: AccessController): void {
  ctx.inject(['webServer'], webCtx =>
    webCtx.effect(() => {
      const webServer = (webCtx as Context & { webServer: WebServerMount }).webServer
      const routes = new Routes(host, access)
      const dispose = mountRoutes(webServer, routes)
      ctx.logger.info('dsh-browser: signed routes mounted under /_dsh/dsh-browser')
      return dispose
    }, 'dsh-browser: stream routes'),
  )
}

export type { BrowserStatus }
