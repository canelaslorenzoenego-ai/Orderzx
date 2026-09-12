/**
 * The chatbar capsule: a small monitor animation above the message input.
 *
 * Registered in the `conversation.input.dock` slot — the same seat
 * dsh-android's stream pill and dsh-openpencil's selection chip use.
 *
 * Behaviour, and the reasoning behind each rule:
 *
 *  - **Renders only while a browser session exists.** A gray idle pill on every
 *    conversation is noise; the capsule appears when there is something to look
 *    at and disappears when there is not.
 *  - **The glyph is a CRT monitor with a sweeping scanline**, animated through
 *    the boot stages: `spinning-up → warming → hardening → connecting`, then a
 *    steady green once frames arrive. That is the "starting" animation the user
 *    asked for, and it is driven by real host phases rather than a fake timer —
 *    so it cannot finish before the browser actually exists.
 *  - **Clicking it opens the panel** (stage 2: the dashboard extends).
 *  - **Session-scoped.** The dock seat is handed the current `sessionId`; the
 *    capsule polls only for that session, so switching conversations stops the
 *    poll instead of leaking a timer per session.
 *  - **Attention states beat everything.** A pending challenge or a takeover
 *    renders amber and says so in words. The user needs to know the agent is
 *    waiting on THEM without reading the conversation.
 *
 * All animation is CSS keyframes injected once into `document.head` (inline
 * style objects cannot carry @keyframes) plus an SVG glyph. No images, no fonts,
 * no network.
 *
 * @module @dsh-community/dsh-browser/client/status-capsule
 */

import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { BrowserStatus } from '../protocol.js'
import { bootLabel, capsuleTone, reduceStatus, resetBoot, type BootState, shouldAutoOpen } from './boot-sequence.js'
import { requestGrant, requestStatus, type FetchLike } from './wire.js'

/** Capsule polling cadence. Slower than the panel's, because it only reads phase. */
export const CAPSULE_POLL_MS = 2500

export const CAPSULE_KEYFRAMES = `
@keyframes dsh-browser-scan {
  0%   { transform: translateY(-10%); opacity: 0; }
  12%  { opacity: 1; }
  88%  { opacity: 1; }
  100% { transform: translateY(110%); opacity: 0; }
}
@keyframes dsh-browser-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%      { opacity: 0.42; transform: scale(0.82); }
}
@keyframes dsh-browser-spin {
  to { transform: rotate(360deg); }
}
@keyframes dsh-browser-attention {
  0%, 100% { box-shadow: 0 0 0 0 rgba(210,153,34,0.44); }
  50%      { box-shadow: 0 0 0 5px rgba(210,153,34,0); }
}
@keyframes dsh-browser-pop {
  0%   { transform: scale(0.7) translateY(7px); opacity: 0; }
  58%  { transform: scale(1.07) translateY(-1px); opacity: 1; }
  100% { transform: scale(1) translateY(0); opacity: 1; }
}
@keyframes dsh-browser-blink {
  0%, 49%  { opacity: 1; }
  50%,100% { opacity: 0; }
}
@keyframes dsh-browser-pips {
  0%, 20%  { opacity: 0.15; }
  30%, 55% { opacity: 1; }
  70%,100% { opacity: 0.15; }
}
@keyframes dsh-browser-draw {
  0%   { stroke-dashoffset: 14; opacity: 0.2; }
  45%  { stroke-dashoffset: 0;  opacity: 1; }
  80%  { stroke-dashoffset: 0;  opacity: 1; }
  100% { stroke-dashoffset: 0;  opacity: 0.2; }
}
@keyframes dsh-browser-bars {
  0%, 100% { transform: scaleY(0.35); }
  50%      { transform: scaleY(1); }
}
@keyframes dsh-browser-spin {
  to { transform: rotate(360deg); }
}
@keyframes dsh-browser-ekg {
  0%   { stroke-dashoffset: 32; }
  100% { stroke-dashoffset: 0; }
}
`

let styleInstalled = false

/** Inject the keyframes once per document. */
export function installCapsuleKeyframes(doc: Document): void {
  if (styleInstalled) return
  if (!doc.head) return
  const style = doc.createElement('style')
  style.dataset.dshBrowserCapsuleKeyframes = 'true'
  style.textContent = CAPSULE_KEYFRAMES
  doc.head.append(style)
  styleInstalled = true
}

// ── the glyph ───────────────────────────────────────────────────────────────

/**
 * A 20×16 CRT monitor: shell, screen, scanline, stand.
 *
 * The scanline's animation duration is keyed to the boot step so the animation
 * visibly accelerates as the browser comes up — cheap, and it reads as progress
 * without any text having to change.
 */
export interface SessionStateFlags {
  recording?: boolean
  jobs?: boolean
  takeover?: boolean
}

export function MonitorGlyph({ step, tone, state }: { step: BootState['step']; tone: 'busy' | 'live' | 'attention' | 'error'; state?: SessionStateFlags }): ReactNode {
  const glyphLabel = tone === 'live' ? 'browser live — frames arriving'
    : tone === 'attention' ? `browser needs you — ${step}`
    : tone === 'error' ? 'browser error'
    : `browser ${step}`
  const duration = step === 'spinning-up' ? '1.5s' : step === 'warming' ? '1.1s' : step === 'hardening' ? '0.8s' : '0.55s'
  const screen = tone === 'live' ? '#3fb950' : tone === 'attention' ? '#d29922' : tone === 'error' ? '#f85149' : '#58a6ff'
  // The screen is not a coloured rectangle: each boot step paints its own
  // little ceremony inside the tube — cursor, loading pips, shield draw-on,
  // signal bars — and a live monitor runs an EKG trace instead of a scanline.
  // Same 20×17 footprint as v1 so every layout that fits the old glyph fits
  // this one.
  return (
    <svg width="20" height="17" viewBox="0 0 20 17" fill="none" role="img" aria-label={glyphLabel} style={{ flex: '0 0 auto', display: 'block' }}>
      <title>{glyphLabel}</title>
      {/* shell */}
      <rect x="0.6" y="0.6" width="18.8" height="12.6" rx="2.2" stroke="currentColor" strokeWidth="1.1" opacity="0.72" />
      {/* screen */}
      <rect x="2.2" y="2.2" width="15.6" height="9.4" rx="1.2" fill={screen} opacity={tone === 'busy' ? 0.16 : 0.26} />
      <g clipPath="url(#dsh-browser-screen-clip)">
        {tone === 'busy' && step === 'spinning-up' ? (
          <>
            <rect x="2.2" y="2.2" width="15.6" height="2.1" fill={screen} opacity="0.85" style={{ animation: `dsh-browser-scan ${duration} linear infinite` }} />
            <rect x="4.4" y="8.2" width="2.2" height="2.6" fill={screen} style={{ animation: 'dsh-browser-blink 0.9s steps(1) infinite' }} />
          </>
        ) : null}
        {tone === 'busy' && step === 'warming' ? (
          <g fill={screen}>
            <rect x="4.4" y="6.2" width="2.6" height="2.6" rx="0.6" style={{ animation: 'dsh-browser-pips 1.1s linear infinite' }} />
            <rect x="8.2" y="6.2" width="2.6" height="2.6" rx="0.6" style={{ animation: 'dsh-browser-pips 1.1s linear infinite 0.18s' }} />
            <rect x="12" y="6.2" width="2.6" height="2.6" rx="0.6" style={{ animation: 'dsh-browser-pips 1.1s linear infinite 0.36s' }} />
          </g>
        ) : null}
        {tone === 'busy' && step === 'hardening' ? (
          <path
            d="M10 3.6 13.4 5v2.6c0 2.2-1.5 3.6-3.4 4.4-1.9-.8-3.4-2.2-3.4-4.4V5z"
            stroke={screen}
            strokeWidth="1.1"
            strokeLinejoin="round"
            strokeDasharray="14"
            style={{ animation: 'dsh-browser-draw 1.2s ease-out infinite' }}
          />
        ) : null}
        {tone === 'busy' && step === 'connecting' ? (
          <g fill={screen} style={{ transformBox: 'fill-box' } as never}>
            <rect x="5.2" y="7.6" width="1.8" height="3.2" rx="0.5" style={{ transformOrigin: '6.1px 10.8px', animation: 'dsh-browser-bars 0.9s ease-in-out infinite' }} />
            <rect x="8.4" y="6.2" width="1.8" height="4.6" rx="0.5" style={{ transformOrigin: '9.3px 10.8px', animation: 'dsh-browser-bars 0.9s ease-in-out infinite 0.15s' }} />
            <rect x="11.6" y="4.6" width="1.8" height="6.2" rx="0.5" style={{ transformOrigin: '12.5px 10.8px', animation: 'dsh-browser-bars 0.9s ease-in-out infinite 0.3s' }} />
          </g>
        ) : null}
        {tone === 'live' ? (
          <polyline
            points="2.6,7 6,7 7.4,4.2 9,9.6 10.4,7 17.4,7"
            stroke={screen}
            strokeWidth="1.1"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="32"
            style={{ animation: 'dsh-browser-ekg 1.6s linear infinite' }}
          />
        ) : null}
        {tone === 'attention' ? (
          <g stroke={screen} strokeWidth="1.4" strokeLinecap="round" style={{ animation: 'dsh-browser-blink 1s steps(1) infinite' }}>
            <path d="M10 4.2v4.2" />
            <path d="M10 10.6v0.2" />
          </g>
        ) : null}
        {/* session-state corner ceremonies: REC dot, job gear, takeover hand —
            small enough to share the tube with the boot ceremonies */}
        {state?.recording ? (
          <circle cx="16.2" cy="3.8" r="1.1" fill="#f85149" style={{ animation: 'dsh-browser-blink 1s steps(1) infinite' }} />
        ) : null}
        {state?.jobs ? (
          <g stroke="#67e8f9" strokeWidth="0.9" style={{ transformOrigin: '16.2px 9.6px', animation: 'dsh-browser-spin 1.8s linear infinite' }}>
            <circle cx="16.2" cy="9.6" r="1.2" fill="none" />
            <path d="M16.2 7.6v-0.9M16.2 12.5v-0.9M18.2 9.6h0.9M13.3 9.6h0.9" strokeLinecap="round" />
          </g>
        ) : null}
        {state?.takeover ? (
          <rect x="3.4" y="3" width="2.4" height="2.4" rx="0.6" fill="#d29922" style={{ animation: 'dsh-browser-blink 1.2s steps(1) infinite' }} />
        ) : null}
        {tone === 'error' ? (
          <g stroke={screen} strokeWidth="1.4" strokeLinecap="round">
            <path d="M7.6 4.6l4.8 4.8M12.4 4.6l-4.8 4.8" />
          </g>
        ) : null}
      </g>
      {/* power LED: blinks while booting, solid once frames arrive */}
      <circle
        cx="17.4"
        cy="11.6"
        r="0.9"
        fill={screen}
        style={tone === 'busy' ? { animation: 'dsh-browser-blink 1s steps(1) infinite' } : undefined}
      />
      {/* stand */}
      <path d="M7.4 13.4v1.9M12.6 13.4v1.9M5.6 15.9h8.8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" opacity="0.72" />
      <defs>
        <clipPath id="dsh-browser-screen-clip">
          <rect x="2.2" y="2.2" width="15.6" height="9.4" rx="1.2" />
        </clipPath>
      </defs>
    </svg>
  )
}

// ── styles ──────────────────────────────────────────────────────────────────

export function capsuleStyles(tone: 'busy' | 'live' | 'attention' | 'error'): CSSProperties {
  const palette = {
    busy: { fg: '#9ecbff', bg: 'rgba(88,166,255,0.12)', border: 'rgba(88,166,255,0.32)' },
    live: { fg: '#3fb950', bg: 'rgba(63,185,80,0.12)', border: 'rgba(63,185,80,0.3)' },
    attention: { fg: '#d29922', bg: 'rgba(210,153,34,0.14)', border: 'rgba(210,153,34,0.36)' },
    error: { fg: '#f85149', bg: 'rgba(248,81,73,0.14)', border: 'rgba(248,81,73,0.36)' },
  }[tone]
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    height: 28,
    padding: '0 11px 0 9px',
    borderRadius: 999,
    fontSize: 11.5,
    lineHeight: 1,
    cursor: 'pointer',
    userSelect: 'none',
    whiteSpace: 'nowrap',
    color: palette.fg,
    background: palette.bg,
    border: `1px solid ${palette.border}`,
    // The capsule mounts only when there is something to say, so the pop-in
    // IS the "a monitor just appeared on the chatbar" moment. `attention`
    // replaces it rather than stacking: two animations on one transform fight.
    animation: tone === 'attention'
      ? 'dsh-browser-pop 320ms cubic-bezier(0.2,0.9,0.3,1.3), dsh-browser-attention 1.8s ease-out 320ms infinite'
      : 'dsh-browser-pop 320ms cubic-bezier(0.2,0.9,0.3,1.3)',
    transformOrigin: 'bottom center',
  }
}

/** Badge shown when more than one browser (sub-agent session) is live. */
const sessionCountStyles: CSSProperties = {
  fontSize: 9.5,
  fontWeight: 700,
  lineHeight: 1,
  padding: '2px 5px',
  borderRadius: 999,
  background: 'rgba(163,113,247,0.22)',
  border: '1px solid rgba(163,113,247,0.5)',
  color: 'rgba(255,255,255,0.88)',
  fontVariantNumeric: 'tabular-nums',
}


function dotStyles(tone: 'busy' | 'live' | 'attention' | 'error'): CSSProperties {
  const color = tone === 'live' ? '#3fb950' : tone === 'attention' ? '#d29922' : tone === 'error' ? '#f85149' : '#58a6ff'
  return {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: color,
    flex: '0 0 auto',
    animation: tone === 'live' ? undefined : 'dsh-browser-pulse 1.4s ease-in-out infinite',
  }
}

// ── the component ───────────────────────────────────────────────────────────

export interface StatusCapsuleProps {
  sessionId: string
  fetcher?: FetchLike
  /** Open the panel. Wired to the panel store by the client entry. */
  onOpen(): void
  /** True while the panel is open — the capsule hides, so they never both show. */
  panelOpen: boolean
  /**
   * Fires ONCE when the capsule first becomes visible (the monitor popped up),
   * and again on any pre-live → live phase edge. The entry wires this to
   * `openIfIdle` so the sequence the user sees is: capsule pops on the chatbar
   * → dashboard extends → boot phases play inside the panel → stream goes
   * live. Without it the panel would only open when the BootCard SETTLES —
   * after launch finished, skipping the whole animation.
   */
  onAutoOpen?(): void
}

/**
 * The auto-open decision, as a pure function (the component effect is a thin
 * wrapper so the whole matrix is smoke-testable).
 *
 * Fires when the capsule FIRST becomes visible (the pop — the dashboard then
 * extends behind it), or on a pre-live → live phase edge when the capsule was
 * already visible (a warm start that skipped the early phases between polls).
 * Never fires while the panel is open, and the first-visibility fire happens
 * exactly once per mount.
 */
export function autoOpenDecision(input: {
  panelOpen: boolean
  visible: boolean
  alreadyOpened: boolean
  prevPhase: BootState['phase'] | null
  phase: BootState['phase']
  hasHandler: boolean
}): { fire: boolean; markOpened: boolean } {
  if (input.panelOpen) {
    // The user got there first: disarm so closing the panel later does not
    // auto-reopen it from a stale phase edge.
    return { fire: false, markOpened: true }
  }
  if (!input.hasHandler) return { fire: false, markOpened: false }
  if (input.visible && !input.alreadyOpened) return { fire: true, markOpened: true }
  if (
    input.prevPhase !== null
    && input.prevPhase !== input.phase
    && shouldAutoOpen(input.prevPhase, input.phase)
  ) {
    return { fire: true, markOpened: input.alreadyOpened }
  }
  return { fire: false, markOpened: input.alreadyOpened }
}

/**
 * Poll `/status` for this session and render the capsule.
 *
 * Returns `null` when there is no session, when the phase is idle/closing, or
 * when the panel is already open. Rendering nothing is the correct idle state.
 */
export function StatusCapsule(props: StatusCapsuleProps): ReactNode {
  const fetcher = props.fetcher ?? (fetch as unknown as FetchLike)
  const [boot, setBoot] = useState<BootState & { status?: BrowserStatus }>(() => resetBoot())
  const [token, setToken] = useState<string | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // One view-scoped token is enough: the capsule only reads status.
  useEffect(() => {
    if (props.panelOpen) return
    let cancelled = false
    void (async () => {
      try {
        const grant = await requestGrant(fetcher, { session: props.sessionId || undefined, scope: 'view' })
        if (cancelled || grant.kind !== 'session' || !grant.stream) return
        setToken(grant.stream.token)
      } catch {
        if (!cancelled) setToken(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [fetcher, props.panelOpen, props.sessionId])

  useEffect(() => {
    if (props.panelOpen || !token) {
      setBoot(resetBoot())
      return
    }
    let cancelled = false
    const tick = async (): Promise<void> => {
      const status: BrowserStatus | undefined = await requestStatus(fetcher, token)
      if (cancelled || !mounted.current) return
      if (!status) return
      setBoot(previous => ({ ...reduceStatus(previous, status), status }))
    }
    void tick()
    const timer = setInterval(() => void tick(), CAPSULE_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [fetcher, token, props.panelOpen])

  // First-visibility + phase-edge auto-open. Refs (not state) because neither
  // trigger may re-render: the pop animation must not be interrupted.
  const autoOpened = useRef(false)
  const prevPhase = useRef<BootState['phase'] | null>(null)
  useEffect(() => {
    const decision = autoOpenDecision({
      panelOpen: props.panelOpen,
      visible: capsuleTone(boot) !== null,
      alreadyOpened: autoOpened.current,
      prevPhase: prevPhase.current,
      phase: boot.phase,
      hasHandler: props.onAutoOpen !== undefined,
    })
    prevPhase.current = boot.phase
    if (decision.markOpened) autoOpened.current = true
    if (decision.fire) props.onAutoOpen?.()
  }, [boot, props.panelOpen, props.onAutoOpen])

  if (props.panelOpen) return null
  const tone = capsuleTone(boot)
  if (tone === null) return null
  // Only worth showing once frames are actually arriving; a "0 fps" badge during
  // boot would read as a broken stream.
  const liveFps = boot.status?.frames?.fps ?? 0
  const fps = boot.stage === 'live' && liveFps > 0 ? `${liveFps} fps` : null
  const sessionCount = boot.status?.sessions?.length ?? 0

  return (
    <button
      type="button"
      style={capsuleStyles(tone)}
      onClick={props.onOpen}
      title="open the live browser panel"
      aria-label={`browser: ${bootLabel(boot)}. Open panel.`}
    >
      <MonitorGlyph step={boot.step} tone={tone} state={{ recording: boot.status?.recording?.active === true, jobs: (boot.status?.jobs ?? []).some(job => job.status === 'running'), takeover: boot.status?.takeover !== undefined }} />
      <span style={dotStyles(tone)} />
      <span>{bootLabel(boot)}</span>
      {sessionCount > 1 ? <span style={sessionCountStyles}>{sessionCount}</span> : null}
      {fps ? <span style={fpsStyles}>{fps}</span> : null}
    </button>
  )
}

/**
 * A poller with an injectable clock, for the static smoke suite.
 *
 * Proves the property that matters: with no session and the panel closed, the
 * fetcher is never called. A capsule that polls on every conversation is a
 * background request loop the user did not ask for.
 */
export function createCapsulePoller(options: {
  fetcher: FetchLike
  token: () => string | null
  panelOpen: () => boolean
  intervalMs?: number
  now?: () => number
  onStatus(status: BrowserStatus): void
}): { start(): void; stop(): void; ticks(): number } {
  let timer: ReturnType<typeof setInterval> | undefined
  let ticks = 0
  let inFlight = false
  const interval = options.intervalMs ?? CAPSULE_POLL_MS

  const tick = async (): Promise<void> => {
    if (options.panelOpen()) return
    const current = options.token()
    if (!current) return
    if (inFlight) return // never stack polls on a slow host
    inFlight = true
    ticks += 1
    try {
      const status = await requestStatus(options.fetcher, current)
      if (status) options.onStatus(status)
    } finally {
      inFlight = false
    }
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(() => void tick(), interval)
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = undefined
    },
    ticks: () => ticks,
  }
}

const fpsStyles: CSSProperties = {
  fontVariantNumeric: 'tabular-nums',
  opacity: 0.72,
  marginLeft: 1,
}
