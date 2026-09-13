/**
 * Shared wire protocol between the host plugin and its browser client.
 *
 * This module is imported by BOTH sides (`tsconfig.json` and
 * `tsconfig.client.json` both include it), so it must stay free of `node:*`
 * imports and of any host-only types. Anything the client renders, the host
 * signs, or a route accepts lives here — one definition, no drift.
 *
 * @module @dsh-community/dsh-browser/protocol
 */

// ── identity ────────────────────────────────────────────────────────────────

/** Stable plugin name (the loader entry id in cordis.patch.yml). */
export const PLUGIN_NAME = 'dsh-browser'

/** Kept in lockstep with package.json by the routes smoke suite. */
export const PLUGIN_VERSION = '0.2.0-rc.24'

/** Every HTTP route lives under this prefix on the DSH webserver. */
export const PLUGIN_ROUTE_PREFIX = '/_dsh/dsh-browser'

// ── routes ──────────────────────────────────────────────────────────────────

/**
 * `multipart/x-mixed-replace` frame stream. Prefix route (the client appends
 * `?token=…&profile=…`).
 */
export const STREAM_ROUTE_PREFIX = `${PLUGIN_ROUTE_PREFIX}/stream`
/** One PNG capture. Prefix route (`?token=…&seq=…`). */
export const CAPTURE_ROUTE_PREFIX = `${PLUGIN_ROUTE_PREFIX}/capture`
/** Mint a short-lived stream/capture capability. Exact. */
export const GRANT_ROUTE_PATH = `${PLUGIN_ROUTE_PREFIX}/grant`
/** Live status + boot phase, polled by the capsule. Exact. */
export const STATUS_ROUTE_PATH = `${PLUGIN_ROUTE_PREFIX}/status`
/** Human → browser input (click, drag, key, scroll). Exact. */
export const CONTROL_ROUTE_PATH = `${PLUGIN_ROUTE_PREFIX}/control`
/** Human → agent-loop control (takeover, resume, abort). Exact. */
export const SESSION_ROUTE_PATH = `${PLUGIN_ROUTE_PREFIX}/session`
/** Challenge state + handoff resolution. Exact. */
export const CHALLENGE_ROUTE_PATH = `${PLUGIN_ROUTE_PREFIX}/challenge`
/**
 * Gesture trace as Server-Sent Events. Prefix route (`?token=…&since=…`).
 *
 * The frames show the PAGE; this channel shows the AGENT — every humanized
 * move, click, drag, swipe, scroll and keystroke (length only, never text) is
 * pushed here so the panel can animate the pointer over the stream instead of
 * leaving the user to infer what happened between two frames.
 */
export const INTERACTIONS_ROUTE_PREFIX = `${PLUGIN_ROUTE_PREFIX}/interactions`

/**
 * GET — the STANDALONE panel: a self-contained HTML page that mounts the full
 * dashboard against these same routes, for any browser on the loopback fence
 * (a second desktop profile, or an Android phone via `adb reverse`). Served
 * from `lib/standalone.html`; 501 with build instructions when absent.
 */
export const PANEL_ROUTE_PATH = `${PLUGIN_ROUTE_PREFIX}/panel`

export type { InteractionActor, InteractionEvent, InteractionRecord } from './interactions.js'
import type { InteractionRecord } from './interactions.js'

// ── tool names ──────────────────────────────────────────────────────────────

export const TOOL_NAMES = {
  start: 'browser_start',
  stop: 'browser_stop',
  status: 'browser_status',
  observe: 'browser_observe',
  see: 'browser_see',
  click: 'browser_click',
  type: 'browser_type',
  press: 'browser_press',
  scroll: 'browser_scroll',
  navigate: 'browser_navigate',
  tabs: 'browser_tabs',
  fillForm: 'browser_fill_form',
  extract: 'browser_extract',
  act: 'browser_act',
  wait: 'browser_wait',
  evaluate: 'browser_evaluate',
  challenge: 'browser_challenge',
  handoff: 'browser_handoff',
  takeover: 'browser_takeover',
  task: 'browser_task',
  desktopView: 'browser_desktop_view',
  cookies: 'browser_cookies',
  files: 'browser_files',
  workflow: 'browser_workflow',
  clip: 'browser_clip',
  transcript: 'browser_transcript',
  reel: 'browser_reel',
} as const

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES]

/**
 * Tools whose cards emit visual `presentationMeta` and therefore get a
 * registered `tool.call.toolview` slot. Everything else keeps the default
 * generic card — do not register a slot for a tool that emits no meta, or the
 * conversation renders an empty box.
 */
export const CARD_TOOLS = {
  start: TOOL_NAMES.start,
  observe: TOOL_NAMES.observe,
  click: TOOL_NAMES.click,
  challenge: TOOL_NAMES.challenge,
  handoff: TOOL_NAMES.handoff,
} as const

// ── lifecycle phases ────────────────────────────────────────────────────────

/**
 * Boot phase, reported by `/status` and rendered by the dock capsule.
 *
 * The capsule animates through these in order; `streaming` is the only phase
 * where the panel shows a live frame. `handoff` and `takeover` are the two
 * human-in-the-loop pauses — they are distinct because `handoff` is agent-
 * initiated (a challenge blocked it) and `takeover` is user-initiated.
 */
export const BOOT_PHASES = [
  'idle',
  'launching',
  'warming-profile',
  'applying-stealth',
  'ready',
  'navigating',
  'streaming',
  'paused',
  'handoff',
  'takeover',
  'closing',
  'error',
] as const

export type BootPhase = (typeof BOOT_PHASES)[number]

/** Phases the capsule treats as "alive but not streaming". */
export const LIVE_PHASES: readonly BootPhase[] = ['ready', 'navigating', 'streaming', 'paused', 'handoff', 'takeover']

/** Phases where the panel should be showing frames. */
export const STREAMING_PHASES: readonly BootPhase[] = ['streaming', 'handoff', 'takeover']

// ── frame transport ─────────────────────────────────────────────────────────

/**
 * The tiered frame transport. This is the core stealth/observability trade-off
 * — see docs/ARCHITECTURE.md §4.
 *
 * - `screenshot`  on-demand `Page.captureScreenshot`, short-lived sessions.
 *                 Lowest detection surface. 2–6 fps. DEFAULT.
 * - `screencast`  persistent `Page.startScreencast`. 10–25 fps, but a loud
 *                 Layer-1 tell. Opt-in; auto-suppressed on challenge pages.
 * - `dom`         no capture at all — a synthetic viewport rendered from the
 *                 a11y tree plus the element the agent is acting on. Zero
 *                 added tell, works for text-only models. Fallback tier.
 * - `mirror`      OS/compositor capture of the real window. Zero CDP for
 *                 pixels, native fps. Requires a native helper; NOT YET
 *                 IMPLEMENTED — reserved so the config surface never breaks.
 */
export const FRAME_SOURCES = ['screenshot', 'screencast', 'dom', 'mirror'] as const
export type FrameSource = (typeof FRAME_SOURCES)[number]

/** Boundary token for the `multipart/x-mixed-replace` body. */
export const STREAM_BOUNDARY = 'dsh-browser-frame'

/** One decoded frame delivered to the stream route. */
export interface BrowserFrame {
  /** PNG or JPEG bytes, per `mime`. */
  data: Uint8Array
  mime: 'image/png' | 'image/jpeg'
  width: number
  height: number
  /** Monotonic since the frame loop started. */
  sequence: number
  /** Epoch ms. */
  at: number
  /** Which transport produced it — surfaced in the panel's frame badge. */
  source: FrameSource
}

// ── engine ──────────────────────────────────────────────────────────────────

export const ENGINE_PROVIDERS = ['patchright', 'cloakbrowser', 'playwright-core', 'cdp'] as const
export type EngineProvider = (typeof ENGINE_PROVIDERS)[number]

export const BROWSER_CHANNELS = ['chrome', 'chromium', 'msedge'] as const
export type BrowserChannel = (typeof BROWSER_CHANNELS)[number]

// ── challenge pipeline ──────────────────────────────────────────────────────

/**
 * Challenge vendors the detector classifies. `unknown` is a first-class value:
 * an unrecognised widget must still pause the agent rather than let the model
 * guess at it from a screenshot.
 */
export const CHALLENGE_VENDORS = [
  'cloudflare-turnstile',
  'cloudflare-managed',
  'recaptcha-v2',
  'recaptcha-v3',
  'recaptcha-enterprise',
  'hcaptcha',
  'datadome',
  'perimeterx',
  'kasada',
  'akamai',
  'imperva',
  'amazon-waf',
  'funcaptcha',
  'geetest',
  'altcha',
  'friendly-captcha',
  'unknown',
] as const

export type ChallengeVendor = (typeof CHALLENGE_VENDORS)[number]

/**
 * The four tiers, in escalation order. Tier 0 is the engine itself.
 *
 * `handoff` is the DEFAULT terminal tier, not a fallback: a live, interactive
 * human solve in the panel beats any token-injection scheme on strict
 * configurations, because the token is minted in the very session that
 * consumes it.
 */
export const CHALLENGE_TIERS = ['prevent', 'classify', 'handoff', 'adapter'] as const
export type ChallengeTier = (typeof CHALLENGE_TIERS)[number]

/** Outcome of one challenge encounter. Persisted to the session log. */
export interface ChallengeRecord {
  id: string
  vendor: ChallengeVendor
  /** Did the widget block navigation, or just sit on the page? */
  blocking: boolean
  url: string
  at: number
  /** Which tier resolved it. */
  resolvedBy: ChallengeTier | 'unresolved' | 'user'
  /** Only set when tier 3 ran. Audited. */
  adapter?: {
    name: string
    /** ms from request to token. */
    latencyMs: number
    /** true when the token was injected into the SAME session that requested it. */
    inSession: boolean
  }
  /**
   * `timeout` is host-generated (the handoff window expired); a user can only
   * report passed/failed/abandoned through /challenge. `pending` is the
   * in-flight state.
   */
  outcome: 'passed' | 'failed' | 'abandoned' | 'timeout' | 'pending'
}

// ── control protocol ────────────────────────────────────────────────────────

/**
 * Human input from the panel, POSTed to `/control`.
 *
 * Coordinates are NORMALIZED 0..1 against the frame, never pixels — the panel
 * can be any width and the browser viewport can change underneath it. The host
 * multiplies by the live viewport size at dispatch time.
 */
export type ControlMessage =
  | { kind: 'pointer-down'; x: number; y: number; button?: 'left' | 'right' | 'middle' }
  | { kind: 'pointer-move'; x: number; y: number }
  | { kind: 'pointer-up'; x: number; y: number; button?: 'left' | 'right' | 'middle' }
  | { kind: 'wheel'; deltaX: number; deltaY: number }
  /**
   * A touch-shaped flick: normalized path, fastest segment decides direction.
   * The host replays it as a drag (or a wheel scroll when the page has no
   * touch handler), so swiping the stream on a phone scrolls the real page.
   */
  | { kind: 'swipe'; points: Array<{ x: number; y: number }> }
  | { kind: 'key'; key: string; code?: string; text?: string }
  | { kind: 'nav'; action: 'back' | 'forward' | 'reload' | 'stop' }
  | { kind: 'address'; url: string }
  | { kind: 'tab'; action: 'select' | 'close' | 'new'; index?: number }

/**
 * Agent-loop state, POSTed to `/session`.
 *
 * `takeover` pauses the agent and hands input to the human; `resume` hands it
 * back. `abort` stops the in-flight `browser_task` job. While in `takeover`
 * every model-facing tool returns a typed refusal rather than queueing behind
 * the human — the alternative is two input sources fighting over one pointer.
 */
export type SessionMessage =
  | { kind: 'takeover' }
  | { kind: 'resume' }
  | { kind: 'abort' }
  | { kind: 'frame-source'; source: FrameSource }
  | { kind: 'handoff-resolved'; challengeId: string; outcome: 'passed' | 'failed' | 'abandoned' }
  /** Point the panel (and the tool default) at another sub-agent browser. */
  | { kind: 'switch-session'; id: string }
  /**
   * Close one session's browser from the panel (the session tab's ×). Drive
   * scope: it tears down a browser the agent may be mid-task in, and kills its
   * stream — the same authority as starting one.
   */
  | { kind: 'stop-browser'; id: string }
  /**
   * Ask the site for its desktop layout: a desktop UA + a wide emulated
   * viewport. This is what "view on my phone, drive a desktop page" means —
   * the phone panel is a window onto a desktop-class browser, and mobile sites
   * routinely hide the controls the agent needs behind app-store interstitials.
   */
  | { kind: 'set-desktop-view'; enabled: boolean; reload?: boolean }
  | { kind: 'set-debug-tap'; enabled: boolean }
  | { kind: 'set-recording'; enabled: boolean; name?: string }
  /**
   * Start a browser from the panel's home tab, no model turn required.
   * Drive scope only: this launches a real process on the user's machine and
   * the user is the principal asking for it.
   */
  | { kind: 'start-browser'; url?: string; label?: string }

/** `/status` response body. Polled by the capsule; pushed over the stream route's headers. */
/** One row per browser in the tab strip. Cheap enough to ship on every poll. */
export interface SessionSummary {
  id: string
  /** Sub-agent name (`browser_start({label})`) or null for the default. */
  label: string | null
  phase: BootPhase
  owner: 'agent' | 'user'
  url: string
  challengeVendor: string | null
  desktopView: boolean
}

/**
 * Cookie METADATA as exposed to the model: name, domain, flags, expiry — never
 * the value. Session values are credentials; a tool that exfiltrates them into
 * a conversation would turn every transcript into a credential dump.
 */
export interface CookieMeta {
  name: string
  domain: string
  path: string
  /** Unix seconds; -1 for session cookies. */
  expires: number
  httpOnly: boolean
  secure: boolean
}

/** One tool action, for the timeline drawer. Never contains typed text. */
/** A recorded clip delivered to the session: the timeline drawer replays it. */
export interface ClipRef {
  id: string
  /** Signed manifest URL (frames carry their own signed URLs inside). */
  manifest: string
  seconds: number
  fps: number
  frames: number
}

export interface ActionEntry {
  ts: number
  tool: string
  /** Human-readable one-liner: `click e12 · "Sign in" @ 0.42,0.81`. */
  summary: string
  ok: boolean
  refused?: string
  /** Set on `browser_clip` entries so the drawer can replay the clip inline. */
  clip?: ClipRef
}

export interface BrowserStatus {
  phase: BootPhase
  /** The compatibility contract block — absent means protocol 1. */
  compat?: { protocol: number; plugin: string; guarantees: string[] }
  /** Every live browser — the panel renders one custom tab per entry. */
  sessions?: SessionSummary[]
  /** Last N actions on THIS session, newest last. The timeline drawer. */
  recent?: ActionEntry[]
  /** Where the agent's pointer last rested, normalized — seeds the overlay cursor. */
  lastPointer?: { x: number; y: number } | null
  /** Latest gesture sequence — the interaction SSE resumes from here. */
  interactionSeq?: number
  /** Present once a browser exists. */
  session?: {
    id: string
    label?: string | null
    desktopView?: boolean
    provider: EngineProvider
    channel: BrowserChannel
    headless: boolean
    /** Live viewport in CSS pixels — the client needs it to un-normalize pointers. */
    viewport: { width: number; height: number }
    tabs: Array<{ index: number; title: string; url: string; active: boolean }>
    activeTab: number
    /**
     * What this provider can actually do, so the model (and the panel) can
     * check before calling instead of eating a refusal. A posture that stays
     * silent about its gaps is a posture that lies by omission.
     */
    capabilities: { cookies: boolean }
  }
  frames?: {
    source: FrameSource
    fps: number
    lastSequence: number
    lastAt: number
    /** Bytes of the latest frame held in memory. */
    bytes: number
    /**
     * Path of the most recent capture the tools wrote, so the panel can mint a
     * capability for it. Null until the first capture lands.
     */
    lastCapturePath: string | null
    /** True while a playing <video> holds the frame loop at boost cadence. */
    boost?: boolean
  }
  /** Non-null while a human owns the pointer. */
  takeover?: { since: number; by: 'user' | 'agent-handoff' }
  challenge?: ChallengeRecord & { state: 'awaiting-user' | 'solving' | 'resolved' }
  /** Stealth posture actually in effect — surfaced so the user can see what they got. */
  stealth?: {
    humanize: boolean
    fingerprintProfile: string | null
    proxy: string | null
    /** Suppressed frame transport, and why. */
    frameSuppression: { active: boolean; reason: string | null }
    /** Console+network tap armed — extra listeners on the page; a posture gap the user opted into. */
    debugTap: boolean
  }
  /** Background workflow jobs on this session, newest first. */
  jobs?: Array<{ id: string; name: string; status: 'running' | 'done' | 'failed' | 'cancelled'; stepsDone: number; stepsTotal: number }>
  /** Non-null while a workflow recording is armed — the panel shows a REC chip. */
  recording?: { active: boolean; name: string | null; steps: number }
  /** Opt-in console+network feed for the panel's debug drawer. Ring-capped by the host. */
  debug?: {
    armed: boolean
    /** False until an engine that supports taps is attached. */
    supported: boolean
    console: Array<{ ts: number; level: string; text: string }>
    network: Array<{ ts: number; method: string; url: string; status?: number; resourceType?: string; failure?: string }>
  }
  error?: { message: string; code?: string }
}

// ── video delivery ──────────────────────────────────────────────────────────

/**
 * The delivery contract for "find me this video and send it": when a tool
 * lands on a video page of a platform the user named (YouTube / TikTok /
 * Instagram), the result carries this hint so the model clips and delivers the
 * video into the chat instead of describing it. Additive and deterministic —
 * the skill playbook is the prose, this is the point-of-use reminder.
 */
export const VIDEO_DELIVERY_HINT =
  'You are on a video page. If the user asked for THIS video, deliver the video itself: call browser_clip '
  + '(it records the playing video), then paste the returned chatLine into your reply VERBATIM — the clip is '
  + 'delivered to the session and the chat with it. Never describe the video instead of delivering it.'

/** Platform matchers: host (after stripping www./m.) + path shape of a VIDEO page. */
const VIDEO_PLATFORM_MATCHERS: ReadonlyArray<{ platform: string; host: RegExp; path: RegExp }> = [
  // Search/results/feed pages must NOT match — only actual video pages.
  { platform: 'YouTube', host: /(^|\.)youtube\.com$|(^|\.)youtube-nocookie\.com$/i, path: /^\/(watch$|shorts(\/|$)|live\/|embed\/)/i },
  { platform: 'YouTube', host: /^youtu\.be$/i, path: /^\/[^/]+/i },
  { platform: 'TikTok', host: /(^|\.)tiktok\.com$/i, path: /\/video\//i },
  { platform: 'Instagram', host: /(^|\.)instagram\.com$/i, path: /^\/(reel|reels|p|tv)\//i },
]

/**
 * Pure: `videoDeliveryHint(url)` → the platform-flavoured hint when the URL is
 * a video page on a supported platform, else undefined. Exported for the smoke
 * suites; the matrix (watch/shorts/youtu.be/tiktok-video/reel vs search pages
 * vs unrelated hosts) is asserted there.
 */
export function videoDeliveryHint(url: string | undefined): string | undefined {
  if (!url) return undefined
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined
  const host = parsed.hostname.replace(/^www\./i, '').replace(/^m\./i, '')
  for (const matcher of VIDEO_PLATFORM_MATCHERS) {
    if (matcher.host.test(host) && matcher.path.test(parsed.pathname)) {
      return `${VIDEO_DELIVERY_HINT} (platform: ${matcher.platform})`
    }
  }
  return undefined
}

// ── capability tokens ───────────────────────────────────────────────────────

/** Hard capability lifetime. Tokens expire within 10 minutes. */
export const TOKEN_TTL_MS = 10 * 60 * 1000

export interface StreamTokenPayload {
  v: 1
  kind: 'browser-stream'
  session: string
  exp: number
}

export interface CaptureTokenPayload {
  v: 1
  kind: 'browser-capture'
  path: string
  exp: number
}

export interface ControlTokenPayload {
  v: 1
  kind: 'browser-control'
  session: string
  /** `view` may stream and capture; `drive` may also POST /control and /session. */
  scope: 'view' | 'drive'
  exp: number
}

// ── presentationMeta ────────────────────────────────────────────────────────

/**
 * Durable card data projected onto `tool/result`.
 *
 * Must be reconstructible from JSON alone, because nested PTC (Code-mode)
 * calls carry NO `presentationMeta` — the harness projects it only for
 * top-level calls. `client/meta-hydrate.ts` rebuilds this exact shape from the
 * settled result's canonical value so PTC sessions render identical cards.
 */
export interface BrowserMeta {
  tool: ToolName
  phase: BootPhase
  sessionId?: string
  /** Sub-agent label of the browser this call acted on. */
  label?: string
  url?: string
  title?: string
  /** Capture path, granted lazily by the client via `/grant`. */
  capturePath?: string
  width?: number
  height?: number
  /** Element the action targeted, for the panel's action overlay. */
  target?: { ref: string; role: string; name: string; box?: { x: number; y: number; w: number; h: number } }
  challenge?: Pick<ChallengeRecord, 'id' | 'vendor' | 'blocking' | 'resolvedBy' | 'outcome'>
  /** Human-readable one-liner for the compact inline card. */
  summary: string
}

// ── config ──────────────────────────────────────────────────────────────────

/**
 * The full config surface, mirrored by the Cordis `Config` schema in
 * `src/config.ts`. Documented here so the client can render the same defaults.
 */
export const DEFAULT_CONFIG = {
  engine: {
    provider: 'patchright' as EngineProvider,
    channel: 'chrome' as BrowserChannel,
    headless: false,
    humanize: true,
    /** Absolute path; never accepted from the model. */
    userDataDir: null as string | null,
    proxy: null as string | null,
    /** Auto-derive timezone/locale from the proxy exit IP. */
    geoip: false,
    viewport: { width: 1366, height: 768 },
    launchTimeoutMs: 60_000,
    idleTimeoutMs: 600_000,
    maxSessions: 4,
  },
  frames: {
    /** Default tier: lowest detection surface. */
    source: 'screenshot' as FrameSource,
    maxFps: 5,
    jpegQuality: 72,
    /** Suppress the persistent transport whenever a challenge widget is present. */
    suppressOnChallenge: true,
    captureTimeoutMs: 8_000,
  },
  challenge: {
    /** Tier 3 is OFF by default and stays off until the user opts in per domain. */
    autoSolver: 'off' as 'off' | 'adapter',
    adapter: null as null | 'capsolver-extension' | 'twocaptcha' | 'capsolver-api',
    /** Tier 3 only ever runs for a domain on this list. */
    allowedDomains: [] as string[],
    /** Pause and hand to the human instead of letting the model guess. */
    handoffByDefault: true,
    handoffTimeoutMs: 300_000,
  },
  policy: {
    /** Mandatory one-shot approval before these verbs, regardless of caller. */
    approvalForSensitiveActions: true,
    /** `browser_evaluate` runs arbitrary page JS: config gate, not an approval. */
    allowEvaluate: false,
    allowedDomains: [] as string[],
    deniedDomains: [] as string[],
    maxTaskSteps: 40,
    taskTimeoutMs: 900_000,
  },
} as const

export type BrowserConfig = typeof DEFAULT_CONFIG
