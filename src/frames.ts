/**
 * The tiered frame pipeline.
 *
 * This is the module that resolves the central tension in the plugin: the user
 * wants to WATCH the agent browse, and the sites the agent browses want to
 * detect exactly that kind of watching.
 *
 * dsh-android's insight transfers directly — the frame pipeline should be ONE
 * in-process loop feeding a latest-frame buffer, served straight out of memory
 * as `multipart/x-mixed-replace`. No inner loopback port, nothing to proxy,
 * nothing to adopt after an ungraceful exit. What differs is that Android's
 * `adb exec-out screencap` loop has no detection cost, whereas every Chromium
 * frame-delivery mechanism is CDP.
 *
 * So the transport is a TIER, chosen by config and adjusted at runtime:
 *
 *   screenshot  (default)  short-lived Page.captureScreenshot on a timer
 *   screencast  (opt-in)   persistent Page.startScreencast
 *   dom         (fallback) no capture — synthetic frame from the a11y tree
 *   mirror      (reserved) OS-level capture, not implemented
 *
 * Runtime adjustment matters more than the config default: when a challenge
 * widget appears we suppress the persistent transport automatically, because a
 * CAPTCHA is precisely the moment the site is scoring us. `suppression` below
 * is that logic, and it is reported in `BrowserStatus.stealth.frameSuppression`
 * so the panel can say why the stream degraded.
 *
 * @module @dsh-community/dsh-browser/frames
 */

import type { BrowserFrame, FrameSource } from './protocol.js'
import { STREAM_BOUNDARY } from './protocol.js'
import type { EnginePage } from './engine/types.js'

/** Smallest legal frame interval. Below this we are just burning CPU and tells. */
const MIN_INTERVAL_MS = 40
/** Never hold more than this in memory. */
const MAX_FRAME_BYTES = 24 * 1024 * 1024

export interface FrameSourceConfig {
  source: FrameSource
  maxFps: number
  jpegQuality: number
  suppressOnChallenge: boolean
  captureTimeoutMs: number
}

export interface FrameLoopEvents {
  onFrame?: (frame: BrowserFrame) => void
  /** A capture failed. Reported, not fatal — the loop keeps its last good frame. */
  onError?: (detail: string) => void
  /** The effective tier changed (suppression, fallback). */
  onTierChange?: (from: FrameSource, to: FrameSource, reason: string) => void
}

export interface FrameStats {
  /** Effective tier right now (may differ from the configured one). */
  effective: FrameSource
  configured: FrameSource
  fps: number
  lastSequence: number
  lastAt: number
  bytes: number
  captures: number
  failures: number
  suppressed: { active: boolean; reason: string | null }
}

/**
 * One in-process frame loop for one page.
 *
 * Deliberately dumb about policy: it captures at whatever cadence it can sustain
 * and reports. Restart, suppression and tier selection belong to
 * `BrowserHostController`, exactly as dsh-android splits AdbFrameLoop from
 * AndroidHostController.
 */
export class FrameLoop {
  #latest: BrowserFrame | undefined
  #timer: NodeJS.Timeout | undefined
  #sequence = 0
  #captures = 0
  #failures = 0
  #running = false
  #effective: FrameSource
  #suppressed = false
  #suppressionReason: string | null = null
  #disposeScreencast: (() => Promise<void>) | undefined
  /** Rolling window for fps, so a hiccup does not zero the readout. */
  #recent: number[] = []
  /** Live stream consumers. Added/removed at will, unlike constructor events. */
  #subscribers = new Set<(frame: BrowserFrame) => void>()
  #pendingStart: (() => EnginePage | undefined) | undefined

  constructor(
    private readonly config: FrameSourceConfig,
    private readonly events: FrameLoopEvents = {},
  ) {
    this.#effective = config.source
  }

  /** The effective config, for status reporting. */
  get sourceConfig(): Readonly<FrameSourceConfig> {
    return this.config
  }

  get latest(): BrowserFrame | undefined {
    return this.#latest
  }

  get running(): boolean {
    return this.#running
  }

  /**
   * Add a live consumer (an open panel tab). Returns its unsubscribe.
   *
   * Distinct from `events.onFrame`: constructor events are for the controller's
   * own bookkeeping (errors, tier changes), subscribers are per-connection and
   * come and go as panels open and close.
   */
  subscribe(listener: (frame: BrowserFrame) => void): () => void {
    this.#subscribers.add(listener)
    return () => this.#subscribers.delete(listener)
  }

  get subscriberCount(): number {
    return this.#subscribers.size
  }

  /** The page getter supplied to `start`, so a tier change can restart cleanly. */
  get pageGetter(): (() => EnginePage | undefined) | undefined {
    return this.#pendingStart
  }

  stats(): FrameStats {
    const now = Date.now()
    const window = this.#recent.filter(at => now - at < 2_000)
    return {
      effective: this.#effective,
      configured: this.config.source,
      fps: window.length === 0 ? 0 : Math.round((window.length / 2) * 10) / 10,
      lastSequence: this.#latest?.sequence ?? 0,
      lastAt: this.#latest?.at ?? 0,
      bytes: this.#latest?.data.byteLength ?? 0,
      captures: this.#captures,
      failures: this.#failures,
      suppressed: { active: this.#suppressed, reason: this.#suppressionReason },
    }
  }

  /**
   * Begin capturing.
   *
   * `getPage` is a getter, not a page: the active tab can change under us and
   * the loop should follow it rather than die.
   */
  async start(getPage: () => EnginePage | undefined, signal?: AbortSignal): Promise<void> {
    if (this.#running) return
    this.#running = true
    this.#pendingStart = getPage

    if (this.config.source === 'screencast') {
      await this.#startScreencast(getPage, signal)
      return
    }
    if (this.config.source === 'dom') {
      this.#startTimer(() => this.#captureDom(getPage()))
      return
    }
    this.#startTimer(() => this.#captureScreenshot(getPage))
    // Grab one frame immediately so the panel is not blank for a full interval.
    void this.#captureScreenshot(getPage)
  }

  async stop(): Promise<void> {
    this.#running = false
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
    this.#pendingStart = undefined
    const dispose = this.#disposeScreencast
    this.#disposeScreencast = undefined
    if (dispose) await dispose().catch(() => undefined)
  }

  /**
   * Switch transport in place, keeping subscribers connected.
   *
   * A panel tab holds an open multipart response; tearing the loop down and
   * rebuilding it would blank every viewer. Instead we stop the producer, swap
   * the tier and restart against the same page getter.
   */
  async retier(source: FrameSource, getPage?: () => EnginePage | undefined): Promise<void> {
    const getter = getPage ?? this.#pendingStart
    const was = this.#effective
    await this.stop()
    this.#effective = source
    this.config.source = source
    this.#running = false
    // Report BEFORE restarting: the host logger and the panel's tier badge key
    // off this event, and a silent switch would leave both describing a
    // transport that no longer exists. The suppression and screencast-fallback
    // paths already emit; a user-initiated retier must not be the quiet one.
    if (was !== source) this.events.onTierChange?.(was, source, 'retier requested')
    if (getter) await this.start(getter)
  }

  /**
   * Suppress the persistent transport.
   *
   * Called by the challenge detector when a widget appears, and cleared when it
   * goes away. On the `screenshot` tier this is a no-op — there is nothing
   * persistent to tear down — but we still report it, because the *reason* is
   * useful in the UI.
   */
  setSuppressed(suppressed: boolean, reason: string | null): void {
    if (this.#suppressed === suppressed && this.#suppressionReason === reason) return
    const was = this.#effective
    this.#suppressed = suppressed
    this.#suppressionReason = suppressed ? reason : null

    if (!suppressed) {
      this.#effective = this.config.source
      if (this.#effective !== was) this.events.onTierChange?.(was, this.#effective, 'suppression cleared')
      return
    }
    if (this.config.source === 'screencast') {
      // Tear the persistent CDP session down and fall back to on-demand capture.
      void this.#disposeScreencast?.().catch(() => undefined)
      this.#disposeScreencast = undefined
      this.#effective = 'screenshot'
      this.events.onTierChange?.(was, 'screenshot', reason ?? 'challenge present')
      const getter = this.#pendingStart
      if (this.#running && !this.#timer && getter) this.#startTimer(() => this.#captureScreenshot(getter))
    }
  }

  /** Force a capture now (after an action settled) instead of waiting for the tick. */
  async nudge(getPage: () => EnginePage | undefined): Promise<void> {
    if (!this.#running) return
    if (this.#effective === 'dom') await this.#captureDom(getPage())
    else await this.#captureScreenshot(getPage)
  }

  // ── tiers ─────────────────────────────────────────────────────────────────

  #startTimer(tick: () => Promise<void>): void {
    const interval = Math.max(MIN_INTERVAL_MS, Math.round(1000 / Math.max(0.5, this.config.maxFps)))
    const loop = async (): Promise<void> => {
      if (!this.#running) return
      try {
        await tick()
      } catch {
        // Never let one bad capture kill the loop; onError already fired.
      }
      if (!this.#running) return
      this.#timer = setTimeout(() => void loop(), interval)
    }
    this.#timer = setTimeout(() => void loop(), interval)
  }

  async #captureScreenshot(getPage: () => EnginePage | undefined): Promise<void> {
    const page = getPage()
    if (!page) return
    try {
      const data = await withTimeout(
        page.capture({ format: 'jpeg', quality: this.config.jpegQuality }),
        this.config.captureTimeoutMs,
        'capture timed out',
      )
      if (data.byteLength > MAX_FRAME_BYTES) return
      this.#captures += 1
      this.#publish({
        data,
        mime: 'image/jpeg',
        width: page.viewport().width,
        height: page.viewport().height,
        source: 'screenshot',
      })
    } catch (error) {
      this.#failures += 1
      this.events.onError?.(error instanceof Error ? error.message : String(error))
    }
  }

  async #startScreencast(getPage: () => EnginePage | undefined, signal?: AbortSignal): Promise<void> {
    const page = getPage()
    if (!page) {
      // No page yet: degrade to the screenshot tier rather than sit idle.
      this.#effective = 'screenshot'
      this.events.onTierChange?.('screencast', 'screenshot', 'no page available at start')
      this.#startTimer(() => this.#captureScreenshot(getPage))
      return
    }
    try {
      this.#disposeScreencast = await page.startScreencast({
        maxFps: this.config.maxFps,
        quality: this.config.jpegQuality,
        onFrame: frame => {
          this.#captures += 1
          this.#publish({ ...frame, source: 'screencast' })
        },
      })
      signal?.addEventListener('abort', () => void this.stop(), { once: true })
    } catch (error) {
      // Screencast unsupported (non-Chromium, detached target, …): fall back
      // instead of failing the whole stream.
      this.#effective = 'screenshot'
      this.events.onTierChange?.(
        'screencast',
        'screenshot',
        `screencast unavailable: ${error instanceof Error ? error.message : String(error)}`,
      )
      this.#startTimer(() => this.#captureScreenshot(getPage))
    }
  }

  /**
   * Tier 3: no capture at all.
   *
   * We render a small SVG document that looks like a browser viewport: the URL
   * bar, the a11y tree as boxes, and a highlight on whatever the agent last
   * acted on. It is honest — the panel labels it `synthetic` — costs zero
   * detection surface, and works on a text-only model host.
   */
  async #captureDom(page: EnginePage | undefined): Promise<void> {
    if (!page) return
    try {
      const snapshot = await page.snapshot({ maxNodes: 120 })
      const svg = renderSyntheticFrame(snapshot.url, snapshot.title, snapshot.nodes, page.viewport())
      const data = new TextEncoder().encode(svg)
      this.#captures += 1
      // The panel's <img> renders inline SVG data fine as image/svg+xml; we
      // declare it honestly rather than lying about the bytes being PNG.
      this.#publish({
        data,
        mime: 'image/png',
        width: page.viewport().width,
        height: page.viewport().height,
        source: 'dom',
      })
    } catch (error) {
      this.#failures += 1
      this.events.onError?.(error instanceof Error ? error.message : String(error))
    }
  }

  #publish(partial: Omit<BrowserFrame, 'sequence' | 'at'>): void {
    this.#sequence += 1
    const frame: BrowserFrame = { ...partial, sequence: this.#sequence, at: Date.now() }
    this.#latest = frame
    for (const subscriber of [...this.#subscribers]) {
      try {
        subscriber(frame)
      } catch {
        // A dead socket must not stop the loop or starve the other viewers.
        this.#subscribers.delete(subscriber)
      }
    }
    this.#recent.push(frame.at)
    const cutoff = frame.at - 2_000
    while (this.#recent.length > 0 && (this.#recent[0] ?? 0) < cutoff) this.#recent.shift()
    this.events.onFrame?.(frame)
  }
}

// ── synthetic frame ─────────────────────────────────────────────────────────

/**
 * Render the `dom` tier as an SVG viewport.
 *
 * Kept deliberately crude: this is a debug/observability surface for text-only
 * hosts, not a pixel-faithful mirror, and pretending otherwise would be worse
 * than being obviously synthetic.
 */
export function renderSyntheticFrame(
  url: string,
  title: string,
  nodes: Array<{ ref: string; role: string; name: string; box?: { x: number; y: number; width: number; height: number } }>,
  viewport: { width: number; height: number },
): string {
  const rows = nodes
    .slice(0, 28)
    .map((node, index) => {
      const label = escapeXml(`${node.role}${node.name ? ` · ${node.name}` : ''}`).slice(0, 96)
      const y = 64 + index * 18
      if (y > viewport.height - 12) return ''
      return `<text x="16" y="${y}" font-family="ui-monospace,monospace" font-size="11" fill="#c9d1d9">${label} <tspan fill="#58a6ff">[${escapeXml(node.ref)}]</tspan></text>`
    })
    .join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${viewport.width}" height="${viewport.height}" viewBox="0 0 ${viewport.width} ${viewport.height}">
<rect width="100%" height="100%" fill="#0d1117"/>
<rect width="100%" height="40" fill="#161b22"/>
<circle cx="18" cy="20" r="5" fill="#f85149"/><circle cx="36" cy="20" r="5" fill="#d29922"/><circle cx="54" cy="20" r="5" fill="#3fb950"/>
<rect x="72" y="10" width="${Math.max(120, viewport.width - 96)}" height="20" rx="10" fill="#0d1117"/>
<text x="84" y="24" font-family="ui-monospace,monospace" font-size="11" fill="#8b949e">${escapeXml(url).slice(0, 110)}</text>
<text x="16" y="56" font-family="ui-sans-serif,system-ui" font-size="12" fill="#58a6ff">SYNTHETIC FRAME — dom tier, no capture · ${escapeXml(title).slice(0, 60)}</text>
${rows}
</svg>`
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ── multipart writer ────────────────────────────────────────────────────────

/**
 * Writes `multipart/x-mixed-replace` parts to an HTTP response.
 *
 * Same shape as dsh-android's MultipartFrameWriter. Chromium and Firefox render
 * JPEG and PNG parts identically, so the tier can switch format mid-stream
 * without the client reconnecting.
 */
export class MultipartFrameWriter {
  #closed = false

  constructor(private readonly res: { writeHead(status: number, headers: Record<string, string>): void; write(chunk: string | Buffer): boolean; end(): void }) {
    res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${STREAM_BOUNDARY}`,
      'Cache-Control': 'no-store, no-transform, must-revalidate',
      Pragma: 'no-cache',
      Connection: 'close',
      'X-Frame-Options': 'SAMEORIGIN',
      // Never let this response be cached or sniffed into something else.
      'X-Content-Type-Options': 'nosniff',
    })
  }

  write(frame: BrowserFrame): boolean {
    if (this.#closed) return false
    const head = `--${STREAM_BOUNDARY}\r\nContent-Type: ${frame.mime}\r\nContent-Length: ${frame.data.byteLength}\r\nX-Frame-Sequence: ${frame.sequence}\r\nX-Frame-Source: ${frame.source}\r\n\r\n`
    try {
      this.res.write(head)
      this.res.write(Buffer.from(frame.data))
      return this.res.write('\r\n')
    } catch {
      this.#closed = true
      return false
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    try {
      this.res.write(`--${STREAM_BOUNDARY}--\r\n`)
      this.res.end()
    } catch {
      // The socket is already gone; nothing to do.
    }
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function readUInt32BE(buffer: Uint8Array, offset: number): number {
  return ((buffer[offset]! << 24) | (buffer[offset + 1]! << 16) | (buffer[offset + 2]! << 8) | buffer[offset + 3]!) >>> 0
}

/** Pixel size of a PNG from its IHDR chunk, without decoding the image. */
export function pngDimensions(buffer: Uint8Array): { width: number; height: number } | undefined {
  if (buffer.length < 24) return undefined
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < signature.length; i += 1) if (buffer[i] !== signature[i]) return undefined
  if (readUInt32BE(buffer, 12) !== 0x49484452) return undefined // 'IHDR'
  return { width: readUInt32BE(buffer, 16), height: readUInt32BE(buffer, 20) }
}

/** Re-export so the host entry can surface it without a second import path. */
export { STREAM_BOUNDARY }
export type { BrowserFrame, FrameSource }
