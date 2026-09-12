/**
 * Desktop-view emulation for Chromium-backed pages.
 *
 * "Desktop view" is the panel toggle that asks a site for its desktop layout:
 * a desktop UA string plus a wide emulated viewport. It exists because the
 * panel is designed to be driven from a phone, and mobile web is hostile to
 * automation — app-store interstitials, hamburger-buried controls, touch-only
 * widgets the a11y tree renders differently. The phone becomes a window onto a
 * desktop-class browser.
 *
 * This mirrors Chrome-for-Android's "Request desktop site" as closely as a
 * per-page CDP override allows. That feature does three things, and doing only
 * the first is what most tooling gets wrong:
 *
 *   1. swap the UA string                       (request header + navigator)
 *   2. swap the UA CLIENT HINTS                 (sec-ch-ua*, UA-CH JS API)
 *   3. drop touch emulation + widen the viewport (layout + capability probes)
 *
 * A site that checks `sec-ch-ua-mobile` (many do, it is a one-line header
 * check) sees `?1` against a Windows UA in step-1-only implementations — an
 * instant mismatch. We send full `userAgentMetadata` so headers, JS API and
 * UA string agree, and we turn touch emulation off when the engine declares
 * the page touch-capable (`EmulateState.touchCapable`).
 *
 * HONESTY NOTE, surfaced in the panel toggle's tooltip and here: overriding the
 * UA on a real device fingerprint is a *mismatch* a determined detector can
 * see (UA says Windows, WebGL/canvas say otherwise). It is a user-initiated
 * convenience trade, never applied silently, and never during an active
 * challenge handoff — spoofing mid-challenge would look exactly like the bot
 * behavior the widget is probing for.
 *
 * @module @dsh-community/dsh-browser/engine/emulate
 */

/** Per-page emulation bookkeeping, owned by the EnginePage wrapper. */
export interface EmulateState {
  cdp?: { send(method: string, params?: Record<string, unknown>): Promise<unknown>; detach(): Promise<void> }
  originalUa?: string
  originalViewport?: { width: number; height: number }
  desktopActive?: boolean
  /**
   * True when the underlying context has touch emulation (a real phone via
   * CDP-connect, or a mobile-emulated launch). Only then does the desktop
   * toggle touch `Emulation.setTouchEmulationEnabled` — flipping touch ON for
   * a desktop-native page on "clear" would invent a capability the page never
   * had. Undefined = unknown; see {@link EmulateState.probeTouch}.
   */
  touchCapable?: boolean
  /**
   * Allow a one-shot `navigator.maxTouchPoints` probe (via the CDP session we
   * already hold) to resolve an unknown `touchCapable`. ONLY the cdp-connect
   * engine sets this: it attaches to the user's own real browser, where a
   * Runtime.evaluate is unremarkable. The stealth engines must NOT probe —
   * touching the Runtime domain is exactly the tell Patchright exists to
   * suppress, and their desktop launches have no touch emulation anyway.
   */
  probeTouch?: boolean
  /** maxTouchPoints to restore when clearing, if we disabled touch. */
  maxTouchPoints?: number
  /** We actually sent the touch-disable — only we may re-enable. */
  touchDisabled?: boolean
}

/** Chrome-on-Windows UA: the layout the "desktop site" checkbox targets. */
export const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export const DESKTOP_VIEWPORT = { width: 1366, height: 768 } as const

/**
 * UA client hints matching {@link DESKTOP_USER_AGENT} exactly.
 *
 * These feed BOTH the `sec-ch-ua*` request headers and
 * `navigator.userAgentData`. Values mirror Chrome 131 stable on Windows 11
 * (platformVersion "15.0.0" is the Win11 range; "Windows NT 10.0" in the UA
 * covers Win10 and Win11, so nothing contradicts). Getting the greasy brand
 * roughly right matters less than `mobile: false` — that is the field sites
 * actually check — but a well-formed full list keeps `getHighEntropyValues`
 * probes from seeing an oddly empty answer.
 */
export const DESKTOP_UA_METADATA = {
  brands: [
    { brand: 'Google Chrome', version: '131' },
    { brand: 'Chromium', version: '131' },
    { brand: 'Not?A_Brand', version: '24' },
  ],
  fullVersionList: [
    { brand: 'Google Chrome', version: '131.0.0.0' },
    { brand: 'Chromium', version: '131.0.0.0' },
    { brand: 'Not?A_Brand', version: '24.0.0.0' },
  ],
  fullVersion: '131.0.0.0',
  platform: 'Windows',
  platformVersion: '15.0.0',
  architecture: 'x86',
  bitness: '64',
  model: '',
  mobile: false,
  wow64: false,
} as const

/**
 * Apply or clear desktop emulation on one Playwright-shaped raw page.
 *
 * UA goes through CDP `Emulation.setUserAgentOverride` (the only per-page UA
 * lever after launch), WITH `userAgentMetadata` so client hints follow the UA
 * string; the viewport uses the driver's native setter so frame captures,
 * snapshot boxes and pointer math all stay consistent automatically. The
 * original UA is read from `Browser.getVersion` — the browser-level truth —
 * rather than evaluating `navigator.userAgent` in the page, which would touch
 * the main world.
 */
export async function applyDesktopView(
  raw: {
    context(): { newCDPSession(page: unknown): Promise<EmulateState['cdp']> }
    setViewportSize(size: { width: number; height: number }): Promise<void>
    viewportSize(): { width: number; height: number } | null
  },
  state: EmulateState,
  enabled: boolean,
): Promise<void> {
  if (enabled === state.desktopActive) return

  if (enabled) {
    if (!state.originalViewport) {
      state.originalViewport = raw.viewportSize() ?? { ...DESKTOP_VIEWPORT }
    }
    const cdp = state.cdp ?? (state.cdp = await raw.context().newCDPSession(raw))
    if (!cdp) throw new Error('no CDP session available for emulation')
    if (state.originalUa === undefined) {
      const version = (await cdp.send('Browser.getVersion').catch(() => undefined)) as
        | { userAgent?: string }
        | undefined
      state.originalUa = version?.userAgent ?? ''
    }
    // Step 1+2: UA string AND client hints, in one override — never one without
    // the other, that split is the mismatch sites detect.
    await cdp.send('Emulation.setUserAgentOverride', {
      userAgent: DESKTOP_USER_AGENT,
      acceptLanguage: 'en-US,en;q=0.9',
      platform: 'Windows',
      userAgentMetadata: DESKTOP_UA_METADATA,
    })
    // Step 3a: touch off, but only where touch was actually on. Resolve an
    // unknown capability first — and only when the engine opted into probing.
    if (state.touchCapable === undefined && state.probeTouch) {
      const probe = (await cdp
        .send('Runtime.evaluate', { expression: 'navigator.maxTouchPoints', returnByValue: true })
        .catch(() => undefined)) as { result?: { value?: unknown } } | undefined
      const points = probe?.result?.value
      state.touchCapable = typeof points === 'number' && points > 0
      if (typeof points === 'number' && points > 0) state.maxTouchPoints = points
    }
    if (state.touchCapable && !state.touchDisabled) {
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => undefined)
      state.touchDisabled = true
    }
    // Step 3b: desktop-class layout viewport.
    await raw.setViewportSize({ ...DESKTOP_VIEWPORT })
    state.desktopActive = true
    return
  }

  // Clear: restore the real UA (dropping the metadata override with it), touch
  // if we disabled it, and the pre-toggle viewport.
  if (state.cdp && state.originalUa) {
    await state.cdp
      .send('Emulation.setUserAgentOverride', { userAgent: state.originalUa })
      .catch(() => undefined)
  }
  if (state.cdp && state.touchDisabled) {
    await state.cdp
      .send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: state.maxTouchPoints ?? 5 })
      .catch(() => undefined)
    state.touchDisabled = false
  }
  if (state.originalViewport) await raw.setViewportSize(state.originalViewport).catch(() => undefined)
  state.desktopActive = false
}
