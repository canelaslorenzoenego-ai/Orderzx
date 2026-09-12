/**
 * The engine seam.
 *
 * A `BrowserEngine` is the smallest surface the rest of the plugin needs from
 * "a browser". Everything above this line — tools, frames, challenge
 * detection, the panel — is engine-agnostic. Everything below it is a provider.
 *
 * Why a seam instead of importing playwright-core directly:
 *
 *  1. The stealth landscape moves faster than any one driver. Patchright is
 *     the default today; CloakBrowser wins some targets; raw-CDP wins others.
 *     A config switch beats a fork.
 *  2. It is the same shape `dsh-browser-playwright` established as `ctx.browser`,
 *     so other plugins (web-search-pro, browser-vision) can inject OUR engine
 *     instead of launching a second Chrome.
 *  3. It keeps the CDP-leak question inside one file per provider, where the
 *     trade-off can be documented honestly instead of smeared across the codebase.
 *
 * Providers are resolved LAZILY at construction. A missing optional package
 * (`patchright`, `cloakbrowser`) therefore produces a clear tool error at
 * `browser_start`, never a plugin boot failure — the same degradation style
 * dsh-android uses on a host without adb.
 *
 * @module @dsh-community/dsh-browser/engine
 */

import type { BrowserChannel, EngineProvider } from '../protocol.js'

// ── surface ─────────────────────────────────────────────────────────────────

/** Normalized pointer/keyboard input. Coordinates are CSS pixels in the viewport. */
export interface EngineInput {
  pointerMove(x: number, y: number): Promise<void>
  pointerDown(x: number, y: number, button?: 'left' | 'right' | 'middle'): Promise<void>
  pointerUp(x: number, y: number, button?: 'left' | 'right' | 'middle'): Promise<void>
  /** A full human-shaped click: move along a curve, settle, down, up. */
  click(x: number, y: number, opts?: ClickOptions): Promise<void>
  typeText(text: string, opts?: TypeOptions): Promise<void>
  pressKey(key: string): Promise<void>
  scroll(deltaX: number, deltaY: number): Promise<void>
  /** Drag from A to B with a human-shaped path. */
  drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void>
}

export interface ClickOptions {
  button?: 'left' | 'right' | 'middle'
  clickCount?: number
  /** Skip humanization for this call (e.g. a synthetic re-click after a settle). */
  instant?: boolean
}

export interface TypeOptions {
  /** Per-key delay range in ms. Defaults come from the humanize preset. */
  minDelayMs?: number
  maxDelayMs?: number
  /** Bulk insert instead of per-key events. Detectably non-human — use for paste. */
  insert?: boolean
}

/** One page/tab. */
export interface EnginePage {
  readonly id: string
  url(): string
  title(): Promise<string>
  viewport(): { width: number; height: number }
  goto(url: string, opts?: { timeoutMs?: number; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' }): Promise<void>
  navigate(action: 'back' | 'forward' | 'reload' | 'stop'): Promise<void>
  close(): Promise<void>

  /**
   * Accessibility-tree snapshot with stable element refs.
   *
   * Refs are the contract with the model: `browser_click({ ref: 'e12' })`
   * instead of a CSS selector it has to guess. Refs are assigned per snapshot
   * and invalidated on navigation — a stale ref must fail loudly, not silently
   * click the wrong thing.
   */
  snapshot(opts?: { maxNodes?: number; maxNameLength?: number }): Promise<PageSnapshot>

  /** Resolve a snapshot ref to a viewport-space box. */
  boxOf(ref: string): Promise<{ x: number; y: number; width: number; height: number } | undefined>

  /** Attach local files to a file input. Paths are fenced by the tool layer BEFORE this is called. */
  setFiles(ref: string, paths: string[]): Promise<void>
  /** Read back a field's value — the form-verify half of fill_form. Undefined for non-input roles. */
  inputValue(ref: string): Promise<string | undefined>
  /** Click a ref and save the download it triggers. Returns size + suggested filename. */
  downloadByClick(ref: string, destPath: string, timeoutMs: number): Promise<{ bytes: number; suggested: string }>

  /** Raw PNG/JPEG of the viewport. The `screenshot` frame tier is built on this. */
  capture(opts?: { format?: 'png' | 'jpeg'; quality?: number; fullPage?: boolean }): Promise<Uint8Array>

  input: EngineInput

  /**
   * Evaluate in an ISOLATED world only.
   *
   * Isolated-world execution is what avoids the `Runtime.enable` /
   * execution-context tell that Patchright exists to suppress. Providers that
   * cannot guarantee isolation must throw rather than quietly run in the main
   * world — a wrong-but-working answer here silently destroys the stealth
   * posture the user configured.
   */
  evaluateIsolated<T>(fn: string, arg?: unknown): Promise<T>

  /**
   * Optional desktop-view emulation (UA override + wide viewport).
   *
   * Absent on providers that cannot do it per-page; the host reports that
   * honestly rather than pretending the toggle worked.
   */
  emulate?(opts: { desktopView: boolean }): Promise<void>

  /** Subscribe to a persistent screencast. Returns a disposer. */
  startScreencast(opts: { maxFps: number; quality: number; onFrame: (frame: { data: Uint8Array; mime: 'image/jpeg' | 'image/png'; width: number; height: number }) => void }): Promise<() => Promise<void>>
}

export interface SnapshotNode {
  ref: string
  role: string
  name: string
  value?: string
  disabled?: boolean
  checked?: boolean
  box?: { x: number; y: number; width: number; height: number }
  children?: SnapshotNode[]
}

export interface PageSnapshot {
  url: string
  title: string
  /** Pruned tree, already inside the node/text budget. */
  nodes: SnapshotNode[]
  nodeCount: number
  /** True when the budget truncated the tree — the model must be told. */
  truncated: boolean
}

/** What the plugin needs from a launched browser. */
export interface EngineBrowser {
  readonly provider: EngineProvider
  readonly channel: BrowserChannel
  readonly headless: boolean
  pages(): EnginePage[]
  activePage(): EnginePage | undefined
  newPage(): Promise<EnginePage>
  selectPage(id: string): Promise<void>
  /**
   * Cookie METADATA for the session's context (values never leave the engine).
   * Absent on providers that cannot enumerate them; the host reports that.
   */
  cookies?(): Promise<Array<{ name: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean }>>
  /** Clear cookies, optionally restricted to one domain (suffix match). Returns how many were removed. */
  clearCookies?(domain?: string): Promise<number>
  /** Stealth posture actually achieved — surfaced in `browser_status` and the panel. */
  posture(): EnginePosture
  close(): Promise<void>
}

/**
 * Honest reporting of what the engine actually did.
 *
 * This exists because every stealth vendor publishes its own numbers and they
 * disagree. We report what WE configured, not what anyone claims it achieves.
 */
export interface EnginePosture {
  provider: EngineProvider
  /** Driver version + underlying browser version, if discoverable. */
  versions: { driver?: string; browser?: string }
  humanize: boolean
  /** Fingerprint profile id, when the provider supports named profiles. */
  fingerprintProfile: string | null
  proxy: string | null
  timezone: string | null
  locale: string | null
  /**
   * Stealth features the provider claims to have applied. Strings, not booleans,
   * so a provider can say `'source-patch'` vs `'runtime-shim'` — the difference
   * matters and a checkbox hides it.
   */
  applied: string[]
  /**
   * Known gaps. Populated by the provider, e.g. Patchright must admit that a
   * persistent screencast reintroduces the tell it removes.
   */
  gaps: string[]
}

export interface LaunchOptions {
  channel: BrowserChannel
  headless: boolean
  humanize: boolean
  /** Absolute path or null for a fresh temp profile. */
  userDataDir: string | null
  proxy: string | null
  geoip: boolean
  timezone?: string | null
  locale?: string | null
  viewport: { width: number; height: number }
  extraArgs?: string[]
  timeoutMs: number
  signal?: AbortSignal
}

/** A provider is a factory plus its own availability probe. */
export interface EngineProviderAdapter {
  readonly name: EngineProvider
  /**
   * Can this provider run on this host? Returns a reason string when not, so
   * `browser_start` can say "patchright is not installed; run `npm i patchright`
   * in the profile directory, or set engine.provider: playwright-core".
   */
  probe(): Promise<{ available: boolean; reason?: string; detail?: string }>
  launch(opts: LaunchOptions): Promise<EngineBrowser>
}

// ── registry ────────────────────────────────────────────────────────────────

const adapters = new Map<EngineProvider, () => Promise<EngineProviderAdapter>>()

/**
 * Register a provider factory. Factories are async and lazy so the dynamic
 * import of an optional dependency happens at first use, not at plugin mount.
 */
export function registerEngineProvider(provider: EngineProvider, factory: () => Promise<EngineProviderAdapter>): void {
  adapters.set(provider, factory)
}

export async function resolveEngineProvider(provider: EngineProvider): Promise<EngineProviderAdapter> {
  const factory = adapters.get(provider)
  if (!factory) {
    throw new EngineError(
      `unknown engine provider '${provider}' (known: ${[...adapters.keys()].join(', ') || 'none registered'})`,
      'E_UNKNOWN_PROVIDER',
    )
  }
  return factory()
}

export class EngineError extends Error {
  constructor(message: string, readonly code: string, cause?: unknown) {
    super(message)
    this.name = 'EngineError'
    // Assigned manually rather than as a parameter property: `cause` already
    // exists on Error in ES2022 and a parameter property would need `override`
    // while changing the field's optionality semantics.
    if (cause !== undefined) this.cause = cause
  }
}

/**
 * Probe a provider without launching. Used by `browser_status` before any
 * browser exists so the model can report "engine unavailable" instead of
 * failing at `browser_start`.
 */
export async function probeEngine(provider: EngineProvider): Promise<{ available: boolean; reason?: string }> {
  try {
    const adapter = await resolveEngineProvider(provider)
    return adapter.probe()
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
