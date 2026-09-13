/**
 * The host controller: one long-lived owner of browser sessions, frame loops,
 * pointer ownership and challenge handoffs.
 *
 * Modelled on dsh-android's AndroidHostController with the same discipline:
 *
 *  - ONE controller instance per plugin mount, created in `apply()` and disposed
 *    by the returned teardown. Tools hold a reference, never their own browser.
 *  - The frame loop is a resource the controller owns, not the tool call that
 *    happened to start it. Cancelling a tool call must NOT kill the stream —
 *    the panel is still watching.
 *  - A keep-alive/idle policy restarts or reaps sessions; an INTENTIONAL stop is
 *    never fought.
 *
 * The thing this adds that Android has no equivalent of is **pointer ownership**.
 * Two input sources on one browser is not a race condition, it is a corruption:
 * the agent's Bézier path and the human's real mouse interleave into gestures
 * neither intended. So every session has exactly one owner at a time, and every
 * model-facing tool checks it before dispatching. While a human owns the
 * pointer, tools return a typed refusal rather than queueing — queueing would
 * silently execute the agent's backlog the instant the human let go.
 *
 * @module @dsh-community/dsh-browser/host
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ActionEntry, BrowserFrame, BootPhase, BrowserStatus, ChallengeRecord, ControlMessage, CookieMeta, FrameSource, SessionMessage, SessionSummary } from './protocol.js'
import { InteractionTrace, type InteractionActor, type InteractionEvent, type InteractionRecord } from './interactions.js'
import { DEFAULT_CONFIG } from './protocol.js'
import { AccessController, nextCapturePath, profileRoot } from './access.js'
import { FrameLoop, withTimeout, type FrameStats } from './frames.js'
import { compatReport } from './compat.js'
import { PLUGIN_VERSION } from './protocol.js'
import { probeEngine, resolveEngineProvider, EngineError, type EngineBrowser, type EnginePage, type EnginePosture } from './engine/index.js'
import { navigationDwellMs, PRESETS, createRandom, sleep } from './engine/humanize.js'
import {
  MAX_WORKFLOW_STEPS,
  appendKeyEvent,
  identityCaptureScript,
  listVariableNames,
  replayWorkflowSteps,
  resolveVariables,
  sanitizeWorkflowName,
  type ElementIdentity,
  type ReplayPage,
  type Workflow,
} from './workflows.js'
import type { BrowserConfig } from './protocol.js'

/** Who owns the pointer right now. */
export type PointerOwner = 'agent' | 'user'

/** A background workflow job: real lifecycle, cancellable, streamed to the panel. */
export interface JobRecord {
  id: string
  workflow: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  startedAt: number
  finishedAt: number | null
  stepsTotal: number
  stepsDone: number
  fallbacks: number
  error: string | null
}

export interface HostSession {
  id: string
  /**
   * Sub-agent name.
   *
   * Several agents can each own a browser in one conversation — the harness
   * fans work out to sub-agents, and a shared session would mean two models
   * queuing behind one pointer. A label makes the sessions addressable by name
   * (`browser_click({ session: 'researcher', ref: 'e12' })`) and gives the
   * panel's tab strip something human to render.
   */
  label: string | null
  browser: EngineBrowser
  phase: BootPhase
  startedAt: number
  lastActivityAt: number
  frames: FrameLoop
  owner: PointerOwner
  takeoverSince: number | null
  /** Non-null while a challenge has paused the agent. */
  challenge: (ChallengeRecord & { state: 'awaiting-user' | 'solving' | 'resolved' }) | null
  /** Resolves the handoff promise. Null unless a handoff is pending. */
  handoffResolve: ((outcome: 'passed' | 'failed' | 'abandoned') => void) | null
  captures: number
  /** Path of the most recent capture, surfaced through /status for the panel. */
  lastCapturePath: string | null
  frameSubscribers: Set<(frame: BrowserFrame) => void>
  error: { message: string; code?: string } | null
  /** Gesture trace, animated by the panel over the frame stream. */
  interactions: InteractionTrace
  /** Tool actions on this session, newest last. The panel's timeline drawer. */
  history: ActionEntry[]
  /** Desktop UA + wide viewport emulation, toggled from the panel. */
  desktopView: boolean
  /**
   * Opt-in console+network tap. Buffers are ring-capped and cleared on
   * disarm — the drawer is a debug aid, not a surveillance log.
   */
  debug: {
    armed: boolean
    supported: boolean
    console: Array<{ ts: number; level: string; text: string }>
    network: Array<{ ts: number; method: string; url: string; status?: number; resourceType?: string; failure?: string }>
    taps: Map<string, () => void>
  }
  /**
   * Workflow recording state. Armed explicitly (tool or panel); typed text is
   * captured ONLY from the control channel while armed, and secret-shaped
   * targets become required {{variables}} — never disk-written secrets.
   */
  recording: {
    active: boolean
    name: string | null
    steps: import('./workflows.js').WorkflowStep[]
    /** True while the last click landed on a password-shaped field. */
    secretTarget: boolean
    truncated: boolean
  }
  /** Background workflow jobs, newest first by startedAt. One running at a time — one pointer, one driver. */
  jobs: Map<string, JobRecord>
  /** Last known agent pointer, normalized — seeds the overlay cursor on open. */
  lastPointer: { x: number; y: number } | null
}

export type HostOptions = {
  config: BrowserConfig
  access?: AccessController
  /** Emitted for the session log / trajectory view. */
  onEvent?: (event: HostEvent) => void
}

export type HostEvent =
  | { type: 'phase'; session: string; phase: BootPhase; detail?: string }
  | { type: 'frame-tier'; session: string; from: FrameSource; to: FrameSource; reason: string }
  | { type: 'takeover'; session: string; owner: PointerOwner }
  | { type: 'challenge'; session: string; record: ChallengeRecord }
  | { type: 'closed'; session: string; reason: string }

/** Refusal returned to the model when it may not act right now. Typed, not prose. */
export interface Refusal {
  ok: false
  refused: 'pointer-owned' | 'handoff-pending' | 'no-session' | 'policy'
  owner?: PointerOwner
  message: string
}

export type ActionResult = { ok: true } | Refusal

const MAX_CAPTURES_KEPT = 240
/** Action-timeline entries kept per session. */
const MAX_HISTORY_KEPT = 60

/**
 * The version this plugin advertises in `compat`. Single source of truth is
 * the package.json sitting next to lib/ — the compiled PLUGIN_VERSION constant
 * is only a fallback for exotic layouts. A hand-bumped constant drifting from
 * package.json is exactly the class of bug the routes smoke's lockstep check
 * exists to catch; reading the real manifest makes the drift impossible.
 */
let resolvedPluginVersion: string | undefined
function pluginVersion(): string {
  if (resolvedPluginVersion !== undefined) return resolvedPluginVersion
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version?: unknown }
    resolvedPluginVersion = typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : PLUGIN_VERSION
  } catch {
    resolvedPluginVersion = PLUGIN_VERSION
  }
  return resolvedPluginVersion
}

export class BrowserHostController {
  readonly access: AccessController
  #sessions = new Map<string, HostSession>()
  #activeId: string | undefined
  #idleTimer: NodeJS.Timeout | undefined
  #disposed = false
  #config: BrowserConfig
  #onEvent: ((event: HostEvent) => void) | undefined
  // Multicast tap on the same bus as #onEvent. The constructor callback belongs
  // to whoever owns the host; late consumers (the routes' frame streams, which
  // must close when their session dies) subscribe here instead of stealing it.
  #eventSubscribers = new Set<(event: HostEvent) => void>()
  #random = createRandom()

  constructor(options: HostOptions) {
    this.#config = options.config
    this.access = options.access ?? new AccessController()
    this.#onEvent = options.onEvent
  }

  get config(): BrowserConfig {
    return this.#config
  }

  updateConfig(config: BrowserConfig): void {
    this.#config = config
  }

  // ── session lifecycle ─────────────────────────────────────────────────────

  activeSessionId(): string | undefined {
    return this.#activeId
  }

  hasSession(id: string): boolean {
    return this.#sessions.has(id) || this.resolveRef(id) !== undefined
  }

  session(id: string): HostSession | undefined {
    return this.#sessions.get(id)
  }

  listSessions(): SessionSummary[] {
    return [...this.#sessions.values()].map(session => ({
      id: session.id,
      label: session.label,
      phase: session.phase,
      owner: session.owner,
      url: session.browser.activePage()?.url() ?? '',
      challengeVendor: session.challenge && session.challenge.state !== 'resolved' ? session.challenge.vendor : null,
      desktopView: session.desktopView,
    }))
  }

  /**
   * Resolve a session REFERENCE to an id.
   *
   * Accepts a full id, a label, or a unique id prefix. A sub-agent that starts
   * a browser labelled `researcher` should not have to thread a 16-char hex id
   * through every subsequent call — and an ambiguous prefix must fail rather
   * than pick one, or a tool call would drive the wrong browser.
   */
  resolveRef(ref?: string): string | undefined {
    if (!ref) return this.#activeId
    if (this.#sessions.has(ref)) return ref
    const byLabel = [...this.#sessions.values()].find(session => session.label === ref)
    if (byLabel) return byLabel.id
    if (ref.length >= 3) {
      const matches = [...this.#sessions.keys()].filter(id => id.startsWith(ref))
      if (matches.length === 1) return matches[0]
    }
    return undefined
  }

  /**
   * Launch a browser and start streaming.
   *
   * This is the `browser_start` implementation. The phase sequence
   * `launching → warming-profile → applying-stealth → ready → streaming` is
   * published as it happens because the dock capsule animates off it — the boot
   * animation the user asked for is literally a rendering of these transitions.
   */
  async start(options: {
    url?: string
    profile?: string
    headless?: boolean
    provider?: BrowserConfig['engine']['provider']
    /** Sub-agent name; unique per live session (a duplicate gets a suffix). */
    label?: string
    signal?: AbortSignal
  } = {}): Promise<{ ok: true; session: string; label: string | null; posture: EnginePosture; phase: BootPhase } | Refusal> {
    if (this.#disposed) return { ok: false, refused: 'no-session', message: 'the browser plugin is unloading' }
    if (this.#sessions.size >= this.#config.engine.maxSessions) {
      // LRU eviction rather than a hard failure: a long conversation accumulates
      // sessions and refusing to start a new one is worse than closing an idle one.
      const evicted = this.#evictLru()
      if (!evicted) return { ok: false, refused: 'policy', message: `at the session limit (${this.#config.engine.maxSessions}) and none are idle` }
    }

    const id = randomUUID().replace(/-/g, '').slice(0, 16)
    const label = this.#uniqueLabel(options.label)
    const providerName = options.provider ?? this.#config.engine.provider
    this.#publish({ type: 'phase', session: id, phase: 'launching', detail: providerName })

    const probe = await probeEngine(providerName)
    if (!probe.available) {
      this.#publish({ type: 'phase', session: id, phase: 'error', detail: probe.reason })
      return { ok: false, refused: 'no-session', message: `engine '${providerName}' unavailable: ${probe.reason ?? 'unknown reason'}` }
    }

    const adapter = await resolveEngineProvider(providerName)
    const userDataDir = await this.#resolveProfileDir(options.profile, id)
    this.#publish({ type: 'phase', session: id, phase: 'warming-profile', detail: userDataDir ?? 'ephemeral' })

    let browser: EngineBrowser
    try {
      browser = await withTimeout(
        adapter.launch({
          channel: this.#config.engine.channel,
          headless: options.headless ?? this.#config.engine.headless,
          humanize: this.#config.engine.humanize,
          userDataDir,
          proxy: this.#config.engine.proxy,
          geoip: this.#config.engine.geoip,
          viewport: this.#config.engine.viewport,
          timeoutMs: this.#config.engine.launchTimeoutMs,
          signal: options.signal,
        }),
        this.#config.engine.launchTimeoutMs,
        'browser launch timed out',
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#publish({ type: 'phase', session: id, phase: 'error', detail: message })
      return { ok: false, refused: 'no-session', message: `launch failed: ${message}` }
    }

    this.#publish({ type: 'phase', session: id, phase: 'applying-stealth' })

    const frames = new FrameLoop(
      {
        source: this.#config.frames.source,
        maxFps: this.#config.frames.maxFps,
        jpegQuality: this.#config.frames.jpegQuality,
        suppressOnChallenge: this.#config.frames.suppressOnChallenge,
        captureTimeoutMs: this.#config.frames.captureTimeoutMs,
      },
      {
        onError: detail => this.#publish({ type: 'phase', session: id, phase: this.#sessions.get(id)?.phase ?? 'error', detail: `frame: ${detail}` }),
        onTierChange: (from, to, reason) => this.#publish({ type: 'frame-tier', session: id, from, to, reason }),
      },
    )

    const session: HostSession = {
      id,
      label,
      browser,
      phase: 'ready',
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      frames,
      owner: 'agent',
      takeoverSince: null,
      challenge: null,
      handoffResolve: null,
      captures: 0,
      lastCapturePath: null,
      frameSubscribers: new Set(),
      error: null,
      interactions: new InteractionTrace(),
      history: [],
      desktopView: false,
      debug: { armed: false, supported: false, console: [], network: [], taps: new Map() },
      recording: { active: false, name: null, steps: [], secretTarget: false, truncated: false },
      jobs: new Map(),
      lastPointer: null,
    }
    this.#sessions.set(id, session)
    // Fan the loop's frames out to per-connection subscribers. Installed here,
    // after the session exists, because `subscribe` needs somewhere to write to.
    frames.subscribe(frame => {
      for (const subscriber of [...session.frameSubscribers]) {
        try {
          subscriber(frame)
        } catch {
          session.frameSubscribers.delete(subscriber)
        }
      }
    })
    this.#activeId = id
    this.#publish({ type: 'phase', session: id, phase: 'ready' })

    // Start streaming BEFORE the first navigation so the panel is live when the
    // page begins to paint — that is the moment worth watching.
    await frames.start(() => this.#activePage(id), options.signal)
    // Video-aware cadence: a cheap 1.5s probe asks the page whether a <video>
    // is actually playing; while it is, the frame loop tightens to boost
    // cadence so a model (or a human in the dashboard) sees motion, not slides.
    frames.setBoostProbe(() => this.#videoPlaying.get(id) === true)
    this.#videoProbes.set(id, setInterval(() => {
      const page = this.#activePage(id)
      if (!page || typeof page.evaluateIsolated !== 'function') {
        this.#videoPlaying.set(id, false)
        return
      }
      void page
        .evaluateIsolated<boolean>(`(() => { const v = document.querySelector('video'); return !!v && !v.paused && !v.ended && v.readyState >= 2; })()`)
        .then(playing => { this.#videoPlaying.set(id, playing === true) })
        .catch(() => { this.#videoPlaying.set(id, false) })
    }, 1500))
    this.#setPhase(id, 'streaming')

    if (options.url) {
      const nav = await this.navigate(id, options.url, options.signal)
      if (!nav.ok) return nav
    }

    this.#startIdleReaper()
    this.record(id, 'agent', { type: 'phase', detail: label ? `browser "${label}" live` : 'browser live' })
    return { ok: true, session: id, label, posture: browser.posture(), phase: 'streaming' }
  }

  /** Labels are unique per live session; a repeat gets ` (2)`, ` (3)`, … */
  #uniqueLabel(requested?: string): string | null {
    const base = requested?.trim().replace(/\s+/g, ' ').slice(0, 40)
    if (!base) return null
    const taken = new Set([...this.#sessions.values()].map(session => session.label).filter(Boolean))
    if (!taken.has(base)) return base
    for (let n = 2; n < 100; n += 1) {
      const candidate = `${base} (${n})`
      if (!taken.has(candidate)) return candidate
    }
    return `${base} (${Date.now().toString(36)})`
  }

  /**
   * Cookie METADATA for a session's profile — values are stripped at the
   * engine boundary and cannot reach a tool result. Providers that cannot
   * enumerate (no context handle) get a policy refusal.
   */
  async listCookies(id: string, domain?: string): Promise<{ ok: true; cookies: CookieMeta[] } | Refusal> {
    const session = this.#sessions.get(id)
    if (!session) return { ok: false, refused: 'no-session', message: `no such session: ${id}` }
    if (!session.browser.cookies) return { ok: false, refused: 'policy', message: `provider ${session.browser.posture().provider} cannot enumerate cookies` }
    let all = await session.browser.cookies()
    if (domain && domain.trim().length > 0) {
      const d = domain.trim()
      all = all.filter(c => c.domain === d || c.domain === `.${d}` || c.domain.endsWith(`.${d}`))
    }
    return { ok: true, cookies: all.slice(0, 300) }
  }

  /**
   * Clear cookies for one domain. The tool layer enforces an explicit domain:
   * a wipe-everything mode would be a profile-wide logout the model could fire
   * mid-task by mistake, and `browser_close` already covers teardown.
   */
  async clearCookies(id: string, domain: string): Promise<{ ok: true; cleared: number } | Refusal> {
    const session = this.#sessions.get(id)
    if (!session) return { ok: false, refused: 'no-session', message: `no such session: ${id}` }
    if (!session.browser.clearCookies) return { ok: false, refused: 'policy', message: `provider ${session.browser.posture().provider} cannot clear cookies` }
    const cleared = await session.browser.clearCookies(domain.trim())
    if (cleared > 0) this.record(id, 'agent', { type: 'note', text: `cleared ${cleared} cookie(s) for ${domain.trim()}` })
    return { ok: true, cleared }
  }

  /** Close a session. Intentional — the idle reaper will not fight it. */
  async stop(id: string, reason = 'requested'): Promise<ActionResult> {
    const session = this.#sessions.get(id)
    if (!session) return { ok: false, refused: 'no-session', message: `no such session: ${id}` }
    // A closing browser takes its background jobs with it — cancel between
    // steps, the same polite way a human cancel lands.
    for (const [key, controller] of [...this.#jobControllers]) {
      if (key.startsWith(`${id}:`)) controller.abort()
    }
    await this.#teardown(session, reason)
    return { ok: true }
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    if (this.#idleTimer) clearInterval(this.#idleTimer)
    this.#idleTimer = undefined
    for (const session of [...this.#sessions.values()]) await this.#teardown(session, 'plugin unloaded')
    this.#sessions.clear()
    this.#activeId = undefined
  }

  // ── navigation & actions ──────────────────────────────────────────────────

  async navigate(id: string, url: string, signal?: AbortSignal): Promise<ActionResult> {
    const gate = this.#gate(id)
    if (!gate.ok) return gate
    const session = gate.session
    const page = session.browser.activePage()
    if (!page) return { ok: false, refused: 'no-session', message: 'no active page' }

    const policy = this.#checkUrlPolicy(url)
    if (!policy.ok) return policy

    this.#setPhase(id, 'navigating', url)
    try {
      await page.goto(url, { timeoutMs: 30_000, waitUntil: 'domcontentloaded' })
    } catch (error) {
      session.error = { message: error instanceof Error ? error.message : String(error) }
      this.#setPhase(id, 'streaming')
      return { ok: false, refused: 'no-session', message: `navigation failed: ${session.error.message}` }
    }
    // Pace. An agent that navigates every 400 ms for 30 pages is a signature;
    // no driver fixes this for us.
    await sleep(navigationDwellMs(PRESETS.default, this.#random), signal).catch(() => undefined)
    session.lastActivityAt = Date.now()
    this.record(id, 'agent', { type: 'navigate', url, action: 'goto' })
    await session.frames.nudge(() => this.#activePage(id))
    this.#setPhase(id, 'streaming')
    return { ok: true }
  }

  /**
   * Apply HUMAN input from the panel.
   *
   * Requires `owner === 'user'`. This is checked here rather than in the route
   * so a future transport (websocket, native bridge) inherits the same rule.
   */
  async applyHumanControl(id: string, message: ControlMessage): Promise<ActionResult & { applied?: string }> {
    const session = this.#sessions.get(id)
    if (!session) return { ok: false, refused: 'no-session', message: `no such session: ${id}` }
    if (session.owner !== 'user') {
      return {
        ok: false,
        refused: 'pointer-owned',
        owner: session.owner,
        message: 'the agent owns the pointer; press "Take over" first',
      }
    }
    const page = session.browser.activePage()
    if (!page) return { ok: false, refused: 'no-session', message: 'no active page' }
    const viewport = page.viewport()
    const px = (fraction: number, total: number): number => Math.round(fraction * total)

    switch (message.kind) {
      case 'pointer-move':
        await page.input.pointerMove(px(message.x, viewport.width), px(message.y, viewport.height))
        break
      case 'pointer-down':
        await page.input.pointerDown(px(message.x, viewport.width), px(message.y, viewport.height), message.button)
        break
      case 'pointer-up':
        await page.input.pointerUp(px(message.x, viewport.width), px(message.y, viewport.height), message.button)
        break
      case 'wheel':
        await page.input.scroll(message.deltaX, message.deltaY)
        this.record(id, 'user', { type: 'scroll', deltaX: message.deltaX, deltaY: message.deltaY })
        break
      case 'swipe': {
        // Normalized path → pixels, replayed as a drag so touch-scrollable
        // regions swipe and everything else gets a human-shaped flick.
        const points = message.points.map(point => ({
          x: px(point.x, viewport.width),
          y: px(point.y, viewport.height),
        }))
        const from = points[0]
        const to = points[points.length - 1]
        const origin = message.points[0]
        const end = message.points[message.points.length - 1]
        if (from && to && origin && end) {
          await page.input.drag(from, to)
          this.record(id, 'user', { type: 'swipe', from: origin, to: end, points: message.points })
        }
        break
      }
      case 'key':
        if (message.text) await page.input.typeText(message.text)
        else await page.input.pressKey(message.key)
        break
      case 'nav':
        await page.navigate(message.action)
        break
      case 'address': {
        const policy = this.#checkUrlPolicy(message.url)
        if (!policy.ok) return policy
        await page.goto(message.url, { waitUntil: 'domcontentloaded' })
        break
      }
      case 'tab': {
        const pages = session.browser.pages()
        if (message.action === 'new') {
          const created = await session.browser.newPage()
          await this.syncDesktopView(id, created)
        } else if (message.action === 'close' && message.index !== undefined) await pages[message.index]?.close()
        else if (message.action === 'select' && message.index !== undefined) {
          const target = pages[message.index]
          if (target) {
            await session.browser.selectPage(target.id)
            await this.syncDesktopView(id, target)
          }
        }
        break
      }
      default:
        return { ok: false, refused: 'policy', message: 'unknown control message' }
    }
    await this.#captureStep(session, message)
    session.lastActivityAt = Date.now()
    await session.frames.nudge(() => this.#activePage(id))
    return { ok: true, applied: message.kind }
  }

  /**
   * Append one just-applied HUMAN gesture to an armed recording.
   *
   * Identity is captured best-effort at click time (one isolated probe) so
   * replay can prefer role/name matching over raw coordinates. Failures here
   * must never break the gesture — the click already happened.
   */
  async #captureStep(session: HostSession, message: ControlMessage): Promise<void> {
    const rec = session.recording
    if (!rec.active) return
    const page = session.browser.activePage()
    if (!page) return
    if (rec.steps.length >= MAX_WORKFLOW_STEPS) {
      rec.active = false
      rec.truncated = true
      return
    }
    switch (message.kind) {
      case 'pointer-down': {
        if (message.button && message.button !== 'left') return
        const viewport = page.viewport()
        let identity: ElementIdentity | undefined
        let isSecret = false
        try {
          const probe = await page.evaluateIsolated<{ identity?: ElementIdentity; isSecret?: boolean } | null>(
            identityCaptureScript(Math.round(message.x * viewport.width), Math.round(message.y * viewport.height)),
          )
          if (probe?.identity) identity = probe.identity
          isSecret = probe?.isSecret === true
        } catch { /* identity is best-effort; the normalized point always records */ }
        rec.steps.push({ kind: 'click', x: message.x, y: message.y, ...(identity ? { identity } : {}), ...(isSecret ? { secretTarget: true } : {}) })
        rec.secretTarget = isSecret
        return
      }
      case 'key':
        rec.steps = appendKeyEvent(rec.steps, message.key, message.text, rec.secretTarget)
        return
      case 'wheel':
        rec.steps.push({ kind: 'scroll', deltaX: message.deltaX, deltaY: message.deltaY })
        rec.secretTarget = false
        return
      case 'address':
        rec.steps.push({ kind: 'goto', url: message.url })
        rec.secretTarget = false
        return
      default:
        return
    }
  }

  // ── interaction trace & action history ────────────────────────────────────

  /**
   * Record one gesture on a session's trace and fan it out to the panel.
   *
   * The viewport is read live so pixel-valued events normalize correctly, and
   * pointer positions update `lastPointer` — that is what seeds the overlay
   * cursor when a panel opens mid-session.
   */
  record(id: string, actor: InteractionActor, event: InteractionEvent): void {
    const session = this.#sessions.get(id)
    if (!session) return
    const page = session.browser.activePage()
    const viewport = page?.viewport()
    if (event.type === 'click' || event.type === 'down' || event.type === 'up') {
      session.lastPointer = { x: event.x, y: event.y }
    } else if (event.type === 'move' && event.points.length > 0) {
      session.lastPointer = event.points[event.points.length - 1] ?? session.lastPointer
    }
    session.interactions.publish(actor, event, viewport)
  }

  /** Append a tool action to the session timeline (bounded, newest last). */
  #videoProbes = new Map<string, ReturnType<typeof setInterval>>()
  #videoPlaying = new Map<string, boolean>()

  recordAction(id: string, entry: ActionEntry): void {
    const session = this.#sessions.get(id)
    if (!session) return
    session.history.push(entry)
    if (session.history.length > MAX_HISTORY_KEPT) session.history.splice(0, session.history.length - MAX_HISTORY_KEPT)
  }

  subscribeInteractions(id: string, listener: (record: InteractionRecord) => void): () => void {
    const session = this.#sessions.get(id)
    if (!session) return () => undefined
    return session.interactions.subscribe(listener)
  }

  interactionsSince(id: string, seq: number): { records: InteractionRecord[]; resync: boolean; latest: number } {
    const session = this.#sessions.get(id)
    if (!session) return { records: [], resync: false, latest: 0 }
    return session.interactions.since(seq)
  }

  // ── multi-session control ─────────────────────────────────────────────────

  /** Point the tool default (and the panel) at another live session. */
  switchActive(id: string): ActionResult & { active?: string } {
    const ref = this.resolveRef(id)
    if (!ref || !this.#sessions.has(ref)) {
      return { ok: false, refused: 'no-session', message: `no such session: ${id}` }
    }
    this.#activeId = ref
    return { ok: true, active: ref }
  }

  /**
   * Toggle desktop-view emulation.
   *
   * Refused while a challenge is pending: re-fingerprinting the page mid-probe
   * is exactly the mutation a widget is scoring for, and the honest move is to
   * let the human finish the handoff first.
   */
  // ── workflow record → replay ──────────────────────────────────────────────

  /** Saved workflows live under the profile root — local disk only. */
  #workflowsDir(): string {
    return join(profileRoot(), 'workflows')
  }

  /**
   * Arm (enabled) or stop-and-save (disabled) a workflow recording.
   *
   * The saved artifact is a plain JSON step list — reusable, inspectable,
   * hand-editable. Secret-shaped fields are REQUIRED variables at replay.
   */
  async setRecording(id: string, enabled: boolean, name?: string): Promise<ActionResult & { name?: string; steps?: number; variables?: string[]; truncated?: boolean }> {
    const session = this.#sessions.get(id)
    if (!session) return { ok: false, refused: 'no-session', message: `no such session: ${id}` }
    if (enabled) {
      if (session.owner !== 'user') {
        return { ok: false, refused: 'pointer-owned', message: 'recording captures HUMAN gestures — take over the pointer in the panel first, then demonstrate' }
      }
      if (session.recording.active) return { ok: false, refused: 'policy', message: 'a recording is already running — stop it first' }
      const page = session.browser.activePage()
      const stamped = `workflow-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`
      session.recording = {
        active: true,
        name: sanitizeWorkflowName(name ?? '') || stamped,
        steps: [{ kind: 'goto', url: page?.url() ?? '' }],
        secretTarget: false,
        truncated: false,
      }
      this.recordAction(id, { ts: Date.now(), tool: 'browser_workflow', summary: `recording started as ${session.recording.name}`, ok: true })
      return { ok: true, name: session.recording.name ?? undefined }
    }
    const rec = session.recording
    if (!rec.active) return { ok: false, refused: 'policy', message: 'no recording is running' }
    const workflow: Workflow = {
      name: rec.name ?? 'workflow',
      createdAt: Date.now(),
      startUrl: rec.steps[0]?.kind === 'goto' ? rec.steps[0].url : '',
      steps: rec.steps,
      variables: listVariableNames(rec.steps),
    }
    session.recording = { active: false, name: null, steps: [], secretTarget: false, truncated: false }
    await mkdir(this.#workflowsDir(), { recursive: true })
    await writeFile(join(this.#workflowsDir(), `${workflow.name}.json`), JSON.stringify(workflow, null, 2), 'utf8')
    this.recordAction(id, { ts: Date.now(), tool: 'browser_workflow', summary: `saved ${workflow.name} — ${workflow.steps.length} steps${workflow.variables.length > 0 ? `, needs {${workflow.variables.join(', ')}}` : ''}`, ok: true })
    return { ok: true, name: workflow.name, steps: workflow.steps.length, variables: workflow.variables, ...(rec.truncated ? { truncated: true } : {}) }
  }

  async listWorkflows(): Promise<Array<{ name: string; steps: number; variables: string[]; createdAt: number; startUrl: string }>> {
    let files: string[]
    try {
      files = await readdir(this.#workflowsDir())
    } catch {
      return []
    }
    const out: Array<{ name: string; steps: number; variables: string[]; createdAt: number; startUrl: string }> = []
    for (const file of files.filter(entry => entry.endsWith('.json'))) {
      try {
        const parsed = JSON.parse(await readFile(join(this.#workflowsDir(), file), 'utf8')) as Workflow
        out.push({
          name: parsed.name ?? file.replace(/\.json$/, ''),
          steps: Array.isArray(parsed.steps) ? parsed.steps.length : 0,
          variables: Array.isArray(parsed.variables) ? parsed.variables : [],
          createdAt: parsed.createdAt ?? 0,
          startUrl: parsed.startUrl ?? '',
        })
      } catch { /* a corrupt file is skipped, not fatal */ }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }

  async deleteWorkflow(name: string): Promise<ActionResult> {
    const safe = sanitizeWorkflowName(name)
    if (!safe) return { ok: false, refused: 'policy', message: 'invalid workflow name' }
    try {
      await unlink(join(this.#workflowsDir(), `${safe}.json`))
      return { ok: true }
    } catch {
      return { ok: false, refused: 'policy', message: `no such workflow: ${safe}` }
    }
  }

  /**
   * Replay a saved workflow with humanized input.
   *
   * Identity-first: every recorded click tries to re-find its element by
   * role/name/placeholder, and only falls back to the recorded normalized
   * coordinates when the page has shifted. Missing variables REFUSE the run —
   * a replay that silently types an empty password is worse than one that stops.
   */
  async runWorkflow(id: string, name: string, vars: Record<string, string> = {}): Promise<ActionResult & { replayed?: number; fallbacks?: number; name?: string }> {
    const session = this.#sessions.get(id)
    if (!session) return { ok: false, refused: 'no-session', message: `no such session: ${id}` }
    if (session.owner === 'user') {
      return { ok: false, refused: 'pointer-owned', message: 'you own the pointer — resume the agent before replaying a workflow' }
    }
    const safe = sanitizeWorkflowName(name)
    if (!safe) return { ok: false, refused: 'policy', message: 'invalid workflow name' }
    let workflow: Workflow
    try {
      workflow = JSON.parse(await readFile(join(this.#workflowsDir(), `${safe}.json`), 'utf8')) as Workflow
    } catch {
      return { ok: false, refused: 'policy', message: `no such workflow: ${safe}` }
    }
    const { steps, missing } = resolveVariables(Array.isArray(workflow.steps) ? workflow.steps : [], vars)
    if (missing.length > 0) {
      return { ok: false, refused: 'policy', message: `workflow ${safe} needs variable(s): ${missing.join(', ')} — pass them in vars` }
    }
    const result = await replayWorkflowSteps(this.#replayPage(session), steps, {
      onStep: progress => {
        this.recordAction(id, {
          ts: Date.now(),
          tool: 'browser_workflow',
          summary: progress.ok
            ? `replay ${progress.index + 1}/${progress.total}: ${progress.step.kind}`
            : `replay failed at step ${progress.index + 1} (${progress.step.kind}): ${(progress.detail ?? '').slice(0, 80)}`,
          ok: progress.ok,
          ...(progress.ok ? {} : { refused: 'policy' }),
        })
      },
    })
    if (result.failedAt !== undefined) {
      const kind = steps[result.failedAt - 1]?.kind ?? '?'
      return { ok: false, refused: 'policy', message: `replay failed at step ${result.failedAt} (${kind}): ${result.error ?? ''}`, replayed: result.replayed, fallbacks: result.fallbacks, name: safe }
    }
    this.recordAction(id, { ts: Date.now(), tool: 'browser_workflow', summary: `replayed ${safe} — ${result.replayed}/${steps.length} steps, ${result.fallbacks} coordinate fallback(s)`, ok: true })
    return { ok: true, replayed: result.replayed, fallbacks: result.fallbacks, name: safe }
  }

  /**
   * Adapt a session's live page(s) to the replay loop's structural surface.
   * Resolved PER CALL inside the adapter, because a `goto` step can change
   * which page is active mid-replay.
   */
  #replayPage(session: HostSession): ReplayPage {
    const live = (): EnginePage => {
      const page = session.browser.activePage()
      if (!page) throw new Error('the page closed mid-replay')
      return page
    }
    return {
      viewport: () => session.browser.activePage()?.viewport() ?? { width: 0, height: 0 },
      goto: async (url, opts) => { await live().goto(url, opts) },
      evaluateIsolated: async script => live().evaluateIsolated(script),
      input: {
        click: async (x, y) => { await live().input.click(x, y) },
        typeText: async text => { await live().input.typeText(text) },
        pressKey: async key => { await live().input.pressKey(key) },
        scroll: async (deltaX, deltaY) => { await live().input.scroll(deltaX, deltaY) },
      },
    }
  }

  // ── background jobs (browser_task) ────────────────────────────────────────

  #jobControllers = new Map<string, AbortController>()

  /**
   * Start a saved workflow as a BACKGROUND job with real lifecycle.
   *
   * Honest scale, stated plainly: without the harness job runtime there is no
   * LLM planner in the loop, so a "task" is a demonstrated workflow replayed
   * while the conversation continues — cancellable, progress-streamed to the
   * panel timeline, and refused while a human owns the pointer.
   */
  async startJob(id: string, workflow: string, vars: Record<string, string> = {}): Promise<ActionResult & { job?: string; steps?: number }> {
    const session = this.#sessions.get(id)
    if (!session) return { ok: false, refused: 'no-session', message: `no such session: ${id}` }
    if (session.owner === 'user') {
      return { ok: false, refused: 'pointer-owned', message: 'you own the pointer — resume the agent before starting a background job' }
    }
    for (const job of session.jobs.values()) {
      if (job.status === 'running') return { ok: false, refused: 'policy', message: `job ${job.id} is already running here — one pointer, one driver at a time` }
    }
    const safe = sanitizeWorkflowName(workflow)
    if (!safe) return { ok: false, refused: 'policy', message: 'invalid workflow name' }
    let parsed: Workflow
    try {
      parsed = JSON.parse(await readFile(join(this.#workflowsDir(), `${safe}.json`), 'utf8')) as Workflow
    } catch {
      return { ok: false, refused: 'policy', message: `no such workflow: ${safe}` }
    }
    const { steps, missing } = resolveVariables(Array.isArray(parsed.steps) ? parsed.steps : [], vars)
    if (missing.length > 0) {
      return { ok: false, refused: 'policy', message: `workflow ${safe} needs variable(s): ${missing.join(', ')} — pass them in vars` }
    }
    const jobId = randomUUID().slice(0, 8)
    const record: JobRecord = { id: jobId, workflow: safe, status: 'running', startedAt: Date.now(), finishedAt: null, stepsTotal: steps.length, stepsDone: 0, fallbacks: 0, error: null }
    session.jobs.set(jobId, record)
    const controller = new AbortController()
    this.#jobControllers.set(`${id}:${jobId}`, controller)
    this.recordAction(id, { ts: Date.now(), tool: 'browser_task', summary: `job ${jobId} started: ${safe} (${steps.length} steps)`, ok: true })
    void (async () => {
      const result = await replayWorkflowSteps(this.#replayPage(session), steps, {
        signal: controller.signal,
        onStep: progress => {
          record.stepsDone = progress.index + 1
          if (!progress.ok) record.error = progress.detail ?? 'step failed'
          this.recordAction(id, {
            ts: Date.now(),
            tool: 'browser_task',
            summary: progress.ok
              ? `job ${jobId} step ${progress.index + 1}/${progress.total}: ${progress.step.kind}`
              : `job ${jobId} failed at step ${progress.index + 1} (${progress.step.kind}): ${(progress.detail ?? '').slice(0, 60)}`,
            ok: progress.ok,
          })
        },
      })
      record.fallbacks = result.fallbacks
      record.finishedAt = Date.now()
      record.status = result.cancelled ? 'cancelled' : result.failedAt === undefined ? 'done' : 'failed'
      if (result.error) record.error = result.error
      this.#jobControllers.delete(`${id}:${jobId}`)
      this.recordAction(id, { ts: Date.now(), tool: 'browser_task', summary: `job ${jobId} ${record.status} — ${result.replayed}/${steps.length} steps, ${result.fallbacks} fallback(s)`, ok: record.status === 'done' })
    })()
    return { ok: true, job: jobId, steps: steps.length }
  }

  async cancelJob(id: string, jobId: string): Promise<ActionResult> {
    const session = this.#sessions.get(id)
    const record = session?.jobs.get(jobId)
    if (!session || !record) return { ok: false, refused: 'policy', message: `no such job: ${jobId}` }
    if (record.status !== 'running') return { ok: false, refused: 'policy', message: `job ${jobId} is ${record.status}, not running` }
    this.#jobControllers.get(`${id}:${jobId}`)?.abort()
    this.recordAction(id, { ts: Date.now(), tool: 'browser_task', summary: `job ${jobId} cancel requested`, ok: true })
    return { ok: true }
  }

  listJobs(id: string): JobRecord[] {
    const session = this.#sessions.get(id)
    if (!session) return []
    return [...session.jobs.values()].sort((a, b) => b.startedAt - a.startedAt)
  }

  /**
   * Arm or disarm the console+network tap for the panel's debug drawer.
   *
   * Opt-in on purpose: the listeners are extra CDP-adjacent traffic and a
   * posture gap, so they exist only while the user asks, and disarming wipes
   * the buffers. Taps attach lazily in #streamStatus so new tabs are covered.
   */
  async setDebugTap(id: string, enabled: boolean): Promise<ActionResult> {
    const session = this.#sessions.get(id)
    if (!session) return { ok: false, refused: 'no-session', message: `no such session: ${id}` }
    session.debug.armed = enabled
    if (!enabled) {
      for (const off of session.debug.taps.values()) {
        try { off() } catch { /* page already closed */ }
      }
      session.debug.taps.clear()
      session.debug.console = []
      session.debug.network = []
    }
    return { ok: true }
  }

  async setDesktopView(id: string, enabled: boolean, opts: { reload?: boolean } = {}): Promise<ActionResult> {
    const session = this.#sessions.get(id)
    if (!session) return { ok: false, refused: 'no-session', message: `no such session: ${id}` }
    if (session.challenge?.state === 'awaiting-user') {
      return { ok: false, refused: 'handoff-pending', message: 'resolve the challenge first — changing the fingerprint mid-probe is how bots get caught' }
    }
    // Chrome-for-Android parity, part 1: "Desktop site" is a per-TAB setting
    // there, and users think of it as "this browser is in desktop mode". We
    // apply to every tab of the session so a tab opened before the toggle is
    // not left behind on the mobile layout.
    const pages = session.browser.pages()
    const emulatable = pages.filter(page => page.emulate)
    if (emulatable.length === 0) {
      return { ok: false, refused: 'policy', message: `engine '${session.browser.provider}' does not support per-page desktop emulation` }
    }
    let failures = 0
    let firstError: unknown
    for (const page of emulatable) {
      try {
        await page.emulate?.({ desktopView: enabled })
      } catch (error) {
        failures += 1
        firstError ??= error
      }
    }
    if (failures === emulatable.length) {
      return { ok: false, refused: 'policy', message: `emulation failed: ${firstError instanceof Error ? firstError.message : String(firstError)}` }
    }
    session.desktopView = enabled
    // Chrome-for-Android parity, part 2: toggling "Desktop site" RELOADS the
    // tab. That is not cosmetic — the UA is a request header, so without a new
    // request the server keeps serving the mobile HTML it already chose.
    const active = session.browser.activePage()
    const url = active?.url() ?? ''
    const reload = opts.reload !== false && !!active && url.length > 0 && !url.startsWith('about:')
    if (reload) await active!.navigate('reload').catch(() => undefined)
    // The viewport just changed under the frame loop — nudge it and tell the
    // overlay the geometry it is animating against is different now.
    this.record(id, 'agent', { type: 'note', text: enabled ? 'desktop view on' : 'desktop view off' })
    await session.frames.nudge(() => this.#activePage(id))
    return { ok: true }
  }

  /**
   * Bring one page up to the session's desktop-view setting.
   *
   * Called for tabs created AFTER the toggle (window.open, "new tab", the tabs
   * tool): without it, a session in desktop mode would silently grow
   * mobile-mode tabs. Cheap and idempotent — applyDesktopView no-ops when the
   * state already matches.
   */
  async syncDesktopView(id: string, page?: EnginePage): Promise<void> {
    const session = this.#sessions.get(id)
    if (!session?.desktopView) return
    const target = page ?? session.browser.activePage()
    if (!target?.emulate) return
    await target.emulate({ desktopView: true }).catch(() => undefined)
  }

  // ── pointer ownership ─────────────────────────────────────────────────────

  takeoverActive(id: string): boolean {
    return this.#sessions.get(id)?.owner === 'user'
  }

  async beginTakeover(id: string, by: 'user' | 'agent-handoff'): Promise<ActionResult & { owner?: PointerOwner }> {
    const session = this.#sessions.get(id)
    if (!session) return { ok: false, refused: 'no-session', message: `no such session: ${id}` }
    if (session.owner === 'user') return { ok: true, owner: 'user' }
    session.owner = 'user'
    session.takeoverSince = Date.now()
    this.#setPhase(id, by === 'agent-handoff' ? 'handoff' : 'takeover')
    this.#publish({ type: 'takeover', session: id, owner: 'user' })
    this.record(id, 'user', { type: 'note', text: by === 'agent-handoff' ? 'handoff — you are driving' : 'takeover — you are driving' })
    return { ok: true, owner: 'user' }
  }

  async endTakeover(id: string): Promise<ActionResult & { owner?: PointerOwner }> {
    const session = this.#sessions.get(id)
    if (!session) return { ok: false, refused: 'no-session', message: `no such session: ${id}` }
    if (session.challenge?.state === 'awaiting-user') {
      // A pending challenge is not cleared by giving the pointer back; the agent
      // would immediately re-hit the same widget.
      return {
        ok: false,
        refused: 'handoff-pending',
        message: `challenge ${session.challenge.id} is still awaiting resolution`,
      }
    }
    session.owner = 'agent'
    session.takeoverSince = null
    this.#setPhase(id, 'streaming')
    this.#publish({ type: 'takeover', session: id, owner: 'agent' })
    this.record(id, 'agent', { type: 'note', text: 'agent resumed' })
    return { ok: true, owner: 'agent' }
  }

  /**
   * The gate every model-facing action passes through.
   *
   * Returns a typed refusal instead of throwing, because "the human is driving
   * right now" is a normal, expected state — not an infrastructure failure. The
   * tool renders it as a domain outcome so the model can decide to wait or ask.
   */
  #gate(id: string): { ok: true; session: HostSession } | Refusal {
    // id may be an id, a sub-agent LABEL, or a unique prefix — sub-agents
    // address their own browser by the name they gave it.
    const session = this.#sessions.get(this.resolveRef(id) ?? '')
    if (!session) return { ok: false, refused: 'no-session', message: 'no browser session; call browser_start first' }
    if (session.owner !== 'agent') {
      return {
        ok: false,
        refused: 'pointer-owned',
        owner: session.owner,
        message: `the ${session.owner} owns the pointer; the agent cannot act until they resume`,
      }
    }
    if (session.challenge?.state === 'awaiting-user') {
      return {
        ok: false,
        refused: 'handoff-pending',
        message: `waiting for a human to resolve ${session.challenge.vendor} (${session.challenge.id})`,
      }
    }
    return { ok: true, session }
  }

  /** Public wrapper for the tools layer. */
  gate(id?: string): { ok: true; session: HostSession } | Refusal {
    return this.#gate(id ?? this.#activeId ?? '')
  }

  // ── challenge handoff ─────────────────────────────────────────────────────

  /**
   * Pause the agent and hand the challenge to the human.
   *
   * Returns a promise that resolves when the human reports an outcome through
   * `/challenge` (or the timeout fires). The calling tool awaits it, which is
   * what makes the agent genuinely PAUSE rather than spin — the same primitive
   * browser-use's CaptchaWatchdog exposes, implemented locally so the human's
   * input goes through the panel instead of a separate window.
   */
  async beginHandoff(
    id: string,
    record: ChallengeRecord,
    signal?: AbortSignal,
  ): Promise<{ ok: true; outcome: 'passed' | 'failed' | 'abandoned' | 'timeout' } | Refusal> {
    const session = this.#sessions.get(id)
    if (!session) return { ok: false, refused: 'no-session', message: `no such session: ${id}` }

    session.challenge = { ...record, state: 'awaiting-user' }
    this.#publish({ type: 'challenge', session: id, record })
    this.record(id, 'agent', { type: 'challenge', vendor: record.vendor, state: 'awaiting-user' })

    // Suppress the persistent frame transport while a challenge is up: this is
    // precisely the moment the site is scoring us.
    if (this.#config.frames.suppressOnChallenge) {
      session.frames.setSuppressed(true, `${record.vendor} challenge present`)
    }
    await this.beginTakeover(id, 'agent-handoff')

    const outcome = await new Promise<'passed' | 'failed' | 'abandoned' | 'timeout'>(resolve => {
      const timer = setTimeout(() => {
        session.handoffResolve = null
        resolve('timeout')
      }, this.#config.challenge.handoffTimeoutMs)

      session.handoffResolve = result => {
        clearTimeout(timer)
        session.handoffResolve = null
        resolve(result)
      }
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          session.handoffResolve?.('abandoned')
        },
        { once: true },
      )
    })

    session.challenge = { ...session.challenge, ...record, outcome, resolvedBy: outcome === 'passed' ? 'user' : 'unresolved', state: 'resolved' }
    session.frames.setSuppressed(false, null)
    await this.endTakeover(id).catch(() => undefined)
    // endTakeover refuses while a challenge is awaiting-user; it is resolved now.
    session.owner = 'agent'
    session.takeoverSince = null
    this.#setPhase(id, 'streaming')
    return { ok: true, outcome }
  }

  async resolveHandoff(id: string, challengeId: string, outcome: 'passed' | 'failed' | 'abandoned'): Promise<ActionResult> {
    const session = this.#sessions.get(id)
    if (!session) return { ok: false, refused: 'no-session', message: `no such session: ${id}` }
    if (session.challenge?.id !== challengeId) {
      return { ok: false, refused: 'no-session', message: `no pending challenge with id ${challengeId}` }
    }
    const resolve = session.handoffResolve
    if (!resolve) return { ok: false, refused: 'no-session', message: 'that challenge is no longer awaiting resolution' }
    resolve(outcome)
    return { ok: true }
  }

  recordChallenge(id: string, record: ChallengeRecord): void {
    const session = this.#sessions.get(id)
    if (!session) return
    this.#publish({ type: 'challenge', session: id, record })
  }

  // ── frames ────────────────────────────────────────────────────────────────

  latestFrame(id: string): BrowserFrame | undefined {
    return this.#sessions.get(id)?.frames.latest
  }

  subscribeFrames(id: string, listener: (frame: BrowserFrame) => void): () => void {
    const session = this.#sessions.get(id)
    if (!session) return () => undefined
    session.frameSubscribers.add(listener)
    return () => session.frameSubscribers.delete(listener)
  }

  async setFrameSource(id: string, source: FrameSource): Promise<ActionResult & { source?: FrameSource }> {
    const session = this.#sessions.get(id)
    if (!session) return { ok: false, refused: 'no-session', message: `no such session: ${id}` }
    if (source === 'mirror') {
      return {
        ok: false,
        refused: 'policy',
        message: 'the `mirror` tier needs a native capture helper that is not bundled in this release; use `screenshot`, `screencast` or `dom`',
      }
    }
    const from = session.frames.stats().effective
    this.#config = { ...this.#config, frames: { ...this.#config.frames, source } }
    // retier keeps every open panel connection alive; rebuilding the loop would
    // blank the viewers mid-switch.
    await session.frames.retier(source, () => this.#activePage(id))
    this.#publish({ type: 'frame-tier', session: id, from, to: source, reason: 'user request' })
    return { ok: true, source }
  }

  // ── captures ──────────────────────────────────────────────────────────────

  /**
   * Persist a capture and mint a capability for it.
   *
   * Captures live under `<tmp>/dsh-browser/captures/<sessionId>/<n>.jpg` so the
   * route's containment check has exactly one root to defend.
   */
  /**
   * Sign any path under the capture root — clip manifests ride the same
   * verified-capture route as frames, with the same TTL semantics.
   */
  async signPath(path: string, options: { ttlMs?: number } = {}): Promise<{ token: string; expiresAt: number }> {
    return this.access.signCaptureToken(path, options)
  }

  async saveCapture(id: string, data: Uint8Array, ext: 'jpg' | 'png' = 'jpg'): Promise<{ path: string; token: string; expiresAt: number }> {
    const session = this.#sessions.get(id)
    if (!session) throw new EngineError(`no such session: ${id}`, 'E_NO_SESSION')
    session.captures += 1
    const path = nextCapturePath(id, session.captures, ext)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, Buffer.from(data), { mode: 0o600 })
    session.lastCapturePath = path
    const grant = await this.access.signCaptureToken(path)
    return { path, ...grant }
  }

  /**
   * Prune old captures. Called on teardown and by the idle reaper; a long
   * session at 5 fps would otherwise fill the disk with JPEGs nobody asked for.
   */
  async pruneCaptures(id: string, keep = MAX_CAPTURES_KEPT): Promise<void> {
    const session = this.#sessions.get(id)
    if (!session) return
    void keep
    // Deliberately conservative: we only ever delete inside our own capture dir,
    // and only files we minted. Implemented in capture-store.ts to keep this
    // file about lifecycle rather than filesystem policy.
    const { prune } = await import('./capture-store.js')
    await prune(id, keep)
  }

  // ── task control ──────────────────────────────────────────────────────────

  async abortTask(id: string): Promise<ActionResult> {
    const session = this.#sessions.get(id)
    if (!session) return { ok: false, refused: 'no-session', message: `no such session: ${id}` }
    session.handoffResolve?.('abandoned')
    this.#setPhase(id, 'paused', 'task aborted')
    return { ok: true }
  }

  // ── status ────────────────────────────────────────────────────────────────

  status(id: string): BrowserStatus {
    const session = this.#sessions.get(this.resolveRef(id) ?? id)
    if (!session) return { phase: 'idle', sessions: this.listSessions(), compat: compatReport(pluginVersion()) }
    const page = session.browser.activePage()
    const stats: FrameStats = session.frames.stats()
    const posture = session.browser.posture()
    if (session.debug.armed) {
      // Lazily attach taps to every live page and prune the dead ones — new
      // tabs arm on the next status poll, which the panel makes continuously.
      const live = new Set<string>()
      for (const p of session.browser.pages()) {
        live.add(p.id)
        if (typeof p.tapDebug !== 'function') continue
        session.debug.supported = true
        if (session.debug.taps.has(p.id)) continue
        const off = p.tapDebug(event => {
          if (event.type === 'console') {
            session.debug.console.push({ ts: Date.now(), level: event.level, text: event.text })
            if (session.debug.console.length > 200) session.debug.console.splice(0, session.debug.console.length - 200)
          } else {
            session.debug.network.push({ ts: Date.now(), method: event.method, url: event.url, status: event.status, resourceType: event.resourceType, failure: event.failure })
            if (session.debug.network.length > 200) session.debug.network.splice(0, session.debug.network.length - 200)
          }
        })
        session.debug.taps.set(p.id, off)
      }
      for (const [pid, off] of [...session.debug.taps]) {
        if (!live.has(pid)) {
          try { off() } catch { /* page already closed */ }
          session.debug.taps.delete(pid)
        }
      }
    }
    return {
      phase: session.phase,
      sessions: this.listSessions(),
      recent: [...session.history],
      lastPointer: session.lastPointer,
      interactionSeq: session.interactions.latest()?.seq ?? 0,
      session: {
        id: session.id,
        label: session.label,
        desktopView: session.desktopView,
        provider: posture.provider,
        channel: session.browser.channel,
        headless: session.browser.headless,
        viewport: page?.viewport() ?? { width: 0, height: 0 },
        tabs: session.browser.pages().map((tab, index) => ({
          index,
          // Titles are async and the status route is polled; ship the URL and let
          // the panel fetch titles via the observe tool if it needs them.
          title: '',
          url: tab.url(),
          active: tab.id === page?.id,
        })),
        activeTab: Math.max(0, session.browser.pages().findIndex(tab => tab.id === page?.id)),
        capabilities: { cookies: typeof session.browser.cookies === 'function' },
      },
      frames: {
        source: stats.effective,
        fps: stats.fps,
        boost: stats.boost,
        lastSequence: stats.lastSequence,
        lastAt: stats.lastAt,
        bytes: stats.bytes,
        lastCapturePath: session.lastCapturePath,
      },
      compat: compatReport(pluginVersion()),
      ...(session.owner === 'user' ? { takeover: { since: session.takeoverSince ?? Date.now(), by: session.challenge ? 'agent-handoff' : 'user' } } : {}),
      ...(session.challenge ? { challenge: session.challenge } : {}),
      stealth: {
        humanize: posture.humanize,
        fingerprintProfile: posture.fingerprintProfile,
        proxy: posture.proxy,
        frameSuppression: { active: stats.suppressed.active, reason: stats.suppressed.reason },
        debugTap: session.debug.armed,
      },
      ...(session.recording.active ? { recording: { active: true, name: session.recording.name, steps: session.recording.steps.length } } : {}),
      ...(session.jobs.size > 0
        ? {
            jobs: [...session.jobs.values()]
              .sort((a, b) => b.startedAt - a.startedAt)
              .slice(0, 8)
              .map(job => ({ id: job.id, name: job.workflow, status: job.status, stepsDone: job.stepsDone, stepsTotal: job.stepsTotal })),
          }
        : {}),
      debug: {
        armed: session.debug.armed,
        supported: session.debug.supported,
        console: session.debug.console.slice(-100),
        network: session.debug.network.slice(-100),
      },
      ...(session.error ? { error: session.error } : {}),
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────

  #activePage(id: string): EnginePage | undefined {
    return this.#sessions.get(id)?.browser.activePage()
  }

  #setPhase(id: string, phase: BootPhase, detail?: string): void {
    const session = this.#sessions.get(id)
    if (!session || session.phase === phase) return
    session.phase = phase
    this.#publish({ type: 'phase', session: id, phase, detail })
  }

  #publish(event: HostEvent): void {
    try {
      this.#onEvent?.(event)
    } catch {
      // An observer that throws must not break the controller.
    }
    for (const listener of [...this.#eventSubscribers]) {
      try {
        listener(event)
      } catch {
        // Same contract as #onEvent: a throwing subscriber is isolated.
      }
    }
  }

  /**
   * Multicast event tap. Returns an unsubscribe function. Used by the routes'
   * frame streams to close themselves when their session is torn down — the
   * constructor `onEvent` callback is single-owner and already taken.
   */
  subscribeEvents(listener: (event: HostEvent) => void): () => void {
    this.#eventSubscribers.add(listener)
    return () => { this.#eventSubscribers.delete(listener) }
  }

  #checkUrlPolicy(url: string): ActionResult {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return { ok: false, refused: 'policy', message: `invalid url: ${url}` }
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, refused: 'policy', message: `refusing ${parsed.protocol} — only http(s)` }
    }
    const host = parsed.hostname.toLowerCase()
    const denied = this.#config.policy.deniedDomains
    if (denied.some(pattern => hostMatches(host, pattern))) {
      return { ok: false, refused: 'policy', message: `${host} is on the deny list` }
    }
    const allowed = this.#config.policy.allowedDomains
    if (allowed.length > 0 && !allowed.some(pattern => hostMatches(host, pattern))) {
      return { ok: false, refused: 'policy', message: `${host} is not on the allow list (${allowed.join(', ')})` }
    }
    // Loopback and link-local are refused by default: an agent that can reach
    // 169.254.169.254 or the DSH webserver's own port is an SSRF vector, and the
    // harness's sandbox explicitly does not govern network visibility.
    if (isPrivateHost(host) && !this.#config.policy.allowedDomains.some(p => hostMatches(host, p))) {
      return { ok: false, refused: 'policy', message: `${host} resolves to a private/link-local range; add it to policy.allowedDomains to permit it` }
    }
    return { ok: true }
  }

  async #resolveProfileDir(name?: string | null, sessionId?: string): Promise<string | null> {
    const configured = this.#config.engine.userDataDir
    if (configured) return configured
    if (name === null) return null
    // rc.22: an anonymous session gets its OWN directory. Sharing one
    // `default` profile made a second concurrent launch die on Chromium's
    // ProcessSingleton lock — main agent plus sub-agent browsers (the whole
    // rc.19 grid) could never coexist on persistent profiles. Named profiles
    // still share by explicit choice; a configured userDataDir still wins.
    const dir = join_(profileRoot(), name ?? `session-${sessionId ?? 'default'}`)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    return dir
  }

  #evictLru(): string | undefined {
    const idle = [...this.#sessions.values()]
      .filter(session => session.owner === 'agent' && !session.challenge)
      .sort((a, b) => a.lastActivityAt - b.lastActivityAt)
    const victim = idle[0]
    if (!victim) return undefined
    void this.#teardown(victim, 'evicted (session limit)')
    return victim.id
  }

  #startIdleReaper(): void {
    if (this.#idleTimer) return
    this.#idleTimer = setInterval(() => {
      const timeout = this.#config.engine.idleTimeoutMs
      if (timeout <= 0) return
      const cutoff = Date.now() - timeout
      for (const session of [...this.#sessions.values()]) {
        // Never reap a session a human is driving or that has a live challenge.
        if (session.owner === 'user' || session.challenge?.state === 'awaiting-user') continue
        if (session.frameSubscribers.size > 0) continue // someone is watching
        if (session.lastActivityAt < cutoff) void this.#teardown(session, 'idle timeout')
      }
    }, 30_000)
    this.#idleTimer.unref?.()
  }

  async #teardown(session: HostSession, reason: string): Promise<void> {
    const probe = this.#videoProbes.get(session.id)
    if (probe) { clearInterval(probe); this.#videoProbes.delete(session.id) }
    this.#videoPlaying.delete(session.id)

    session.handoffResolve?.('abandoned')
    await session.frames.stop().catch(() => undefined)
    session.frameSubscribers.clear()
    await session.browser.close().catch(() => undefined)
    await this.pruneCaptures(session.id, 0).catch(() => undefined)
    this.#sessions.delete(session.id)
    if (this.#activeId === session.id) this.#activeId = this.#sessions.keys().next().value
    this.#publish({ type: 'closed', session: session.id, reason })
  }
}

// ── small helpers ───────────────────────────────────────────────────────────

function join_(...parts: string[]): string {
  return parts.join('/').replace(/\/{2,}/g, '/')
}

export function hostMatches(host: string, pattern: string): boolean {
  const needle = pattern.toLowerCase().replace(/^\./, '')
  return host === needle || host.endsWith(`.${needle}`)
}

/** Loopback, private RFC1918, link-local and cloud metadata ranges. */
export function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || host === '::1') return true
  if (host === '169.254.169.254' || host === 'metadata.google.internal') return true
  const parts = host.split('.')
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part))) return false
  const [a, b] = [Number(parts[0]), Number(parts[1])]
  if (a === 127 || a === 0 || a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 169 && b === 254) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  return false
}

export { captureDir } from './access.js'
export { DEFAULT_CONFIG }
