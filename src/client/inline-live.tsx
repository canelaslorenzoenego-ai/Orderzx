/**
 * The inline dashboard — the browser screen, directly in the chat.
 *
 * The user's reference is the DeepSeek Harness device dashboard: a card that
 * EXTENDS the conversation (chat above and below, never covered), with a
 * toolbar (device label · follow toggle · close), control segments (fit/frame
 * style), an icon row (nav · camera · rotate), the framed live screen, and a
 * "● live" status row. This component is that pattern for browser sessions:
 *
 *  - **The dashboard extends the chat.** It renders in the message flow (hung
 *    off the boot card); nothing overlays or squeezes the conversation.
 *  - **Harness theme.** Light card chrome (white surfaces, hairline borders,
 *    grey toolbars) exactly like the reference dashboard — the chat around it
 *    keeps whatever theme the harness uses; the dashboard is its own surface,
 *    like the device viewer is.
 *  - **The whole chrome fits at once.** Zoom segments: fit (default,
 *    `clamp(240px, 46dvh, 460px)`), S (300px), M (420px).
 *  - **The model has hands.** The agent's pointer renders as a blue hand with
 *    an "agent" tag (interaction-overlay); clicks squash the hand and ripple;
 *    scrolls draw arrows; typing shows a keyboard badge.
 *  - **Real controls.** Back/forward/reload/stop and camera send real control
 *    messages on the session's control token (same path the panel uses);
 *    frame style + zoom are client-side; rotate (desktop view) and takeover
 *    live in the full panel, and say so in their titles.
 *  - **Auto-follow.** While ON (default) the dashboard expands when the model
 *    searches and collapses after INLINE_IDLE_COLLAPSE_MS of nothing; a manual
 *    collapse/close sticks for the browser session (next /start re-arms).
 *
 * All decision logic is pure (`inlineLiveDecision`) so the static smoke suite
 * asserts the whole expand/collapse matrix without a DOM.
 *
 * @module @dsh-community/dsh-browser/client/inline-live
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { BrowserStatus } from '../protocol.js'
import { STREAMING_PHASES } from '../protocol.js'
import { BrowserFrame, FRAME_STYLE_OPTIONS, NavIcon, type FrameStyle } from './browser-frame.js'
import { bootLabel, reduceStatus, resetBoot, type BootState } from './boot-sequence.js'
import { LiveViewport, useStreamSession } from './live-viewport.js'
import { captureUrl, requestCaptureGrant, sendControl, type FetchLike } from './wire.js'

// ── pure decision logic ─────────────────────────────────────────────────────

/** Idle this long with no model activity → collapse (the model stopped searching). */
export const INLINE_IDLE_COLLAPSE_MS = 15_000
/** How often the idle check runs. Coarse on purpose: this is not animation. */
export const INLINE_CHECK_MS = 5_000

/** Dashboard zoom levels — the reference's fit/100%/S/M row, minus the absurd. */
export type DashboardZoom = 'fit' | 'S' | 'M'
export const DASHBOARD_ZOOMS: readonly DashboardZoom[] = ['fit', 'S', 'M']

/** Pure: the frame-box height for a zoom level. Fit = whole chrome, one screen. */
export function dashboardZoomHeight(zoom: DashboardZoom): string {
  if (zoom === 'S') return '300px'
  if (zoom === 'M') return '420px'
  return 'clamp(240px, 46dvh, 460px)'
}

/** The default height — kept exported because smoke asserts the shape. */
export const INLINE_FRAME_HEIGHT = dashboardZoomHeight('fit')

/**
 * Everything that counts as "the model is doing something": gestures, URL
 * changes, timeline growth, tab switches, phase changes. NOT frame sequence —
 * the capture loop free-runs and would mask idleness forever.
 */
export function activitySignature(status: BrowserStatus | undefined): string | null {
  if (!status) return null
  const active = status.session?.tabs?.[status.session?.activeTab ?? 0]
  const tail = status.recent?.[status.recent.length - 1]
  return [
    status.interactionSeq ?? 0,
    active?.url ?? '',
    tail ? `${tail.ts}:${tail.tool}:${tail.summary}` : '',
    status.session?.activeTab ?? -1,
    status.phase ?? 'idle',
  ].join('|')
}

export type InlineMode =
  /** Follow activity: expand while the model searches, collapse when it stops. */
  | 'auto'
  /** The user expanded it manually — stays open, no auto-collapse. */
  | 'open'
  /** The user collapsed it manually — stays closed for this browser session. */
  | 'closed'

export interface InlineLiveDecisionInput {
  mode: InlineMode
  /** Current browser session id; a change re-arms 'auto' (next /start). */
  sessionKey: string | undefined
  lastSessionKey: string | undefined
  phase: string | undefined
  idleMs: number
  activityChanged: boolean
  challengeBlocking: boolean
  ownedByUser: boolean
}

export interface InlineLiveDecision {
  expanded: boolean
  nextMode: InlineMode
  nextSessionKey: string | undefined
}

/**
 * The expand/collapse matrix, pure:
 *
 *  - A NEW browser session clears any manual close (the user closed the LAST
 *    search, not this one) and re-arms auto.
 *  - mode 'open'  → always expanded (user is watching; never yank it away).
 *  - mode 'closed'→ always collapsed (user dismissed it; it stays dismissed).
 *  - mode 'auto':
 *      blocking challenge or takeover    → expanded (the user is needed/driving)
 *      not streaming                     → collapsed
 *      streaming + fresh activity        → expanded
 *      streaming + idle ≥ threshold      → collapsed
 *      otherwise                         → hold
 */
export function inlineLiveDecision(input: InlineLiveDecisionInput): InlineLiveDecision {
  const sessionChanged =
    input.sessionKey !== input.lastSessionKey && input.sessionKey !== undefined
  const mode: InlineMode = sessionChanged ? 'auto' : input.mode
  const key = input.sessionKey ?? input.lastSessionKey

  if (mode === 'open') return { expanded: true, nextMode: 'open', nextSessionKey: key }
  if (mode === 'closed') return { expanded: false, nextMode: 'closed', nextSessionKey: key }

  const streaming = (STREAMING_PHASES as readonly string[]).includes(input.phase ?? 'idle')
  if (input.challengeBlocking || input.ownedByUser) {
    return { expanded: true, nextMode: 'auto', nextSessionKey: key }
  }
  if (!streaming) return { expanded: false, nextMode: 'auto', nextSessionKey: key }
  if (input.activityChanged) return { expanded: true, nextMode: 'auto', nextSessionKey: key }
  if (input.idleMs >= INLINE_IDLE_COLLAPSE_MS) {
    return { expanded: false, nextMode: 'auto', nextSessionKey: key }
  }
  return { expanded: true, nextMode: 'auto', nextSessionKey: key }
}

// ── the dashboard ───────────────────────────────────────────────────────────

export interface InlineLiveFrameProps {
  /** The conversation/session id the card belongs to. */
  sessionId: string
  /** The browser session key for manual-close memory, when known. */
  browserSession?: string
  fetcher?: FetchLike
  /** Opens the full panel (takeover, desktop view, drawers live there). */
  onOpenPanel?(): void
  /** Initial collapsed state override for tests/SSR. */
  defaultExpanded?: boolean
}

export function InlineLiveFrame(props: InlineLiveFrameProps): ReactNode {
  const fetcher = props.fetcher
  const [expanded, setExpanded] = useState<boolean>(props.defaultExpanded ?? false)
  const [mode, setMode] = useState<InlineMode>('auto')
  const [sessionKey, setSessionKey] = useState<string | undefined>(undefined)
  const [boot, setBoot] = useState<BootState>(() => resetBoot())
  const [zoom, setZoom] = useState<DashboardZoom>('fit')
  const [frameStyle, setFrameStyle] = useState<FrameStyle>('chrome')

  // Poll status even while collapsed (stall detection off — no <img> mounted);
  // the activity signature is what re-expands us.
  const session = useStreamSession({
    ...(fetcher ? { fetcher } : {}),
    session: props.sessionId || undefined,
    active: true,
    stallDetection: expanded,
  })
  const status = session.status

  useEffect(() => {
    if (!status) return
    setBoot(previous => reduceStatus(previous, status))
  }, [status])

  const lastActivity = useRef<{ sig: string; at: number } | null>(null)
  const activityChanged = useRef(false)
  useEffect(() => {
    const sig = activitySignature(status)
    if (sig === null) return
    const prev = lastActivity.current
    if (prev === null || prev.sig !== sig) {
      lastActivity.current = { sig, at: Date.now() }
      activityChanged.current = true
    }
  }, [status])

  const browserSession = status?.session?.id ?? props.browserSession

  useEffect(() => {
    const tick = (): void => {
      const changed = activityChanged.current
      activityChanged.current = false
      const idleMs = lastActivity.current ? Date.now() - lastActivity.current.at : Number.POSITIVE_INFINITY
      const decision = inlineLiveDecision({
        mode,
        sessionKey: browserSession,
        lastSessionKey: sessionKey,
        phase: status?.phase,
        idleMs,
        activityChanged: changed,
        challengeBlocking: status?.challenge?.state === 'awaiting-user' && status.challenge.blocking === true,
        ownedByUser: status?.takeover !== undefined,
      })
      setSessionKey(decision.nextSessionKey)
      if (decision.nextMode !== mode) setMode(decision.nextMode)
      setExpanded(previous => (previous === decision.expanded ? previous : decision.expanded))
    }
    tick()
    const timer = setInterval(tick, INLINE_CHECK_MS)
    return () => clearInterval(timer)
  }, [mode, sessionKey, status, browserSession])

  const tabs = useMemo(() => {
    const list = status?.session?.tabs ?? []
    const active = status?.session?.activeTab ?? 0
    return list.map((tab, index) => ({ index, title: tab.title ?? '', url: tab.url ?? '', active: index === active }))
  }, [status?.session?.tabs, status?.session?.activeTab])

  const [addressDraft, setAddressDraft] = useState('')
  const fps = status?.frames?.fps ?? 0
  const streaming = (STREAMING_PHASES as readonly string[]).includes(status?.phase ?? 'idle')
  const activeUrl = tabs[status?.session?.activeTab ?? 0]?.url ?? ''
  const controlToken = session.controlToken
  const canControl = controlToken !== undefined
  const canCapture = canControl && (status?.frames?.lastCapturePath ?? null) !== null

  const nav = (action: 'back' | 'forward' | 'reload' | 'stop'): void => {
    if (!controlToken) return
    void sendControl(fetcher ?? (fetch as unknown as FetchLike), controlToken, { kind: 'nav', action }).catch(() => undefined)
  }

  const capture = (): void => {
    const path = status?.frames?.lastCapturePath
    if (!path || !controlToken) return
    void (async () => {
      const grant = await requestCaptureGrant(fetcher ?? (fetch as unknown as FetchLike), path)
      if (grant) window.open(captureUrl(grant.token), '_blank', 'noopener')
    })()
  }

  // Manual toggle: the user's word is final for this browser session.
  const toggle = (): void => {
    setMode(expanded ? 'closed' : 'open')
    setExpanded(value => !value)
  }

  const autoFollow = mode === 'auto'
  const toggleAutoFollow = (): void => {
    // Turning follow off PINS the current state; turning it on hands the
    // expand/collapse decision back to the model's activity.
    setMode(previous => (previous === 'auto' ? (expanded ? 'open' : 'closed') : 'auto'))
  }

  return (
    <div style={dashCardStyles} data-dsh-inline-live={expanded ? 'expanded' : 'collapsed'}>
      {/* ── header row: label · session · auto-follow · close ── */}
      <div style={dashHeaderStyles}>
        <button
          type="button"
          style={dashTitleButtonStyles}
          onClick={toggle}
          aria-expanded={expanded}
          aria-label={expanded ? 'collapse the live browser view' : 'expand the live browser view'}
          title={expanded ? 'collapse the dashboard' : 'expand the dashboard'}
        >
          <span style={chevronStyles(expanded)} aria-hidden="true">▾</span>
          <span style={dashDotStyles(streaming)} aria-hidden="true" />
          <span style={dashTitleStyles}>Live browser</span>
        </button>
        <button
          type="button"
          style={followChipStyles(autoFollow)}
          onClick={toggleAutoFollow}
          aria-pressed={autoFollow}
          title={autoFollow
            ? 'auto-follow ON: expands while the model searches, collapses when it stops'
            : 'auto-follow OFF: the dashboard stays exactly as you left it'}
        >
          <span style={followDotStyles(autoFollow)} aria-hidden="true" />
          auto-follow
        </button>
        {props.onOpenPanel ? (
          <button type="button" style={iconBtnStyles} onClick={props.onOpenPanel} title="open the full panel — takeover, desktop view, timeline, console">
            ⤢
          </button>
        ) : null}
        <button
          type="button"
          style={iconBtnStyles}
          onClick={toggle}
          aria-label={expanded ? 'collapse the live browser view' : 'expand the live browser view'}
          title={expanded ? 'collapse — keep the chat full-width' : 'expand — watch the browser live, right here'}
        >
          {expanded ? '×' : '▸'}
        </button>
      </div>

      {expanded ? (
        <>
          {/* ── control row: zoom + frame style segments ── */}
          <div style={dashControlsStyles}>
            <Segmented
              label="zoom"
              value={zoom}
              options={DASHBOARD_ZOOMS as readonly string[]}
              onPick={value => setZoom(value as DashboardZoom)}
            />
            <Segmented
              label="frame"
              value={frameStyle}
              options={FRAME_STYLE_OPTIONS as readonly string[]}
              onPick={value => setFrameStyle(value as FrameStyle)}
            />
          </div>

          {/* ── icon row: real nav controls · camera · rotate ── */}
          <div style={dashNavStyles}>
            {(['back', 'forward', 'reload', 'stop'] as const).map(action => (
              <button
                key={action}
                type="button"
                style={navIconBtnStyles(!canControl)}
                disabled={!canControl}
                onClick={() => nav(action)}
                title={`${action} — sent to the live browser`}
                aria-label={action}
              >
                <NavIcon id={action} size={15} />
              </button>
            ))}
            <span style={navSpacerStyles} />
            <button
              type="button"
              style={navIconBtnStyles(!canCapture)}
              disabled={!canCapture}
              onClick={capture}
              title="camera — open the latest capture in a new tab"
              aria-label="capture"
            >
              <NavIcon id="capture" size={15} />
            </button>
            <button
              type="button"
              style={navIconBtnStyles(false)}
              onClick={() => props.onOpenPanel?.()}
              title="rotate / desktop view — a drive-class control; it lives in the panel"
              aria-label="desktop view"
            >
              ⇄
            </button>
          </div>

          {/* ── the framed live screen, whole chrome at once ── */}
          <div style={{ height: dashboardZoomHeight(zoom), display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <BrowserFrame
              style={frameStyle}
              url={activeUrl}
              title={tabs[status?.session?.activeTab ?? 0]?.title ?? ''}
              tabs={tabs}
              activeTab={status?.session?.activeTab ?? 0}
              phase={status?.phase ?? boot.phase}
              frameSource={status?.frames?.source ?? 'screenshot'}
              fps={fps}
              driving={false}
              challenge={
                status?.challenge && status.challenge.state !== 'resolved'
                  ? { vendor: status.challenge.vendor, blocking: status.challenge.blocking }
                  : null
              }
              suppression={{ active: false, reason: null }}
              error={session.error}
              addressDraft={addressDraft}
              onAddressDraftChange={setAddressDraft}
              onNav={nav}
              onAddress={() => props.onOpenPanel?.()}
              onTab={() => undefined}
              onToggleTakeover={() => props.onOpenPanel?.()}
              onCapture={capture}
            >
              <LiveViewport
                streamUrl={session.streamUrl}
                pollUrl={session.pollUrl}
                phase={session.phase}
                frameSource={status?.frames?.source ?? 'screenshot'}
                driving={false}
                scope={session.scope}
                highlight={null}
                challengeBox={null}
                overlay={session.overlay}
                gesture={session.gesture}
                onControl={() => undefined}
                onFrameLoad={session.onLoad}
                error={session.error}
                placeholder={<div style={placeholderStyles}>{bootLabel(boot)}…</div>}
              />
            </BrowserFrame>
          </div>

          {/* ── status row: the reference's "● live" ── */}
          <div style={dashStatusStyles}>
            <span style={statusDotStyles(streaming)} aria-hidden="true" />
            <span style={statusLabelStyles}>{streaming ? 'live' : bootLabel(boot)}</span>
            {streaming ? <span style={statusMetaStyles}>{fps} fps · {status?.frames?.source ?? 'screenshot'}</span> : null}
            <span style={statusMetaStyles}>{status?.takeover ? 'you are driving' : 'agent driving'}</span>
            {status?.recording?.active ? <span style={recChipStyles}>● REC {status.recording.steps}</span> : null}
          </div>
        </>
      ) : (
        <div style={dashCollapsedStyles}>
          {streaming ? `live · ${activeUrl ? shortHost(activeUrl) : 'browser'} · tap to expand` : 'browser idle — tap to expand'}
        </div>
      )}
    </div>
  )
}

// ── segmented control (the reference's 适应宽度 / 无框·边框·手机框 row) ──────

function Segmented(props: { label: string; value: string; options: readonly string[]; onPick(value: string): void }): ReactNode {
  return (
    <span style={segmentedWrapStyles} role="group" aria-label={props.label}>
      <span style={segmentedLabelStyles}>{props.label}</span>
      {props.options.map(option => (
        <button
          key={option}
          type="button"
          style={segmentOptionStyles(option === props.value)}
          aria-pressed={option === props.value}
          onClick={() => props.onPick(option)}
        >
          {option}
        </button>
      ))}
    </span>
  )
}

function shortHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url.slice(0, 32)
  }
}

// ── styles: harness-light dashboard card ────────────────────────────────────

const dashCardStyles: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  margin: '8px 0',
  minWidth: 0,
  borderRadius: 12,
  overflow: 'hidden',
  background: 'var(--dsw-bg-secondary, #ffffff)',
  border: '1px solid var(--dsw-border-color, rgba(15,23,42,0.10))',
  boxShadow: '0 6px 24px rgba(15,23,42,0.08)',
  color: 'var(--dsw-text-primary, #1f2329)',
  font: 'inherit',
}

const dashHeaderStyles: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 10px',
  background: 'var(--dsw-bg-secondary, #ffffff)',
  borderBottom: '1px solid var(--dsw-border-color, rgba(15,23,42,0.08))',
  flex: '0 0 auto',
}

const dashTitleButtonStyles: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  flex: '1 1 auto',
  minWidth: 0,
  padding: 0,
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  textAlign: 'left',
}

function chevronStyles(expanded: boolean): CSSProperties {
  return {
    display: 'inline-block',
    transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)',
    transition: 'transform 160ms ease',
    flex: '0 0 auto',
    opacity: 0.55,
    color: 'var(--dsw-text-secondary, #4b5563)',
  }
}

function dashDotStyles(streaming: boolean): CSSProperties {
  return {
    width: 8,
    height: 8,
    borderRadius: '50%',
    flex: '0 0 auto',
    background: streaming ? '#22a06b' : 'var(--dsw-text-tertiary, #6b7280)',
  }
}

const dashTitleStyles: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  minWidth: 0,
}

function followChipStyles(on: boolean): CSSProperties {
  return {
    flex: '0 0 auto',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: '3px 9px',
    borderRadius: 999,
    font: 'inherit',
    fontSize: 11,
    cursor: 'pointer',
    color: on ? '#177245' : 'var(--dsw-text-tertiary, #6b7280)',
    background: on ? 'rgba(34,160,107,0.10)' : 'var(--dsw-bg-tertiary, #f2f3f5)',
    border: `1px solid ${on ? 'rgba(34,160,107,0.35)' : 'var(--dsw-border-color, rgba(15,23,42,0.10))'}`,
  }
}

function followDotStyles(on: boolean): CSSProperties {
  return { width: 6, height: 6, borderRadius: '50%', background: on ? '#22a06b' : 'var(--dsw-text-tertiary, #9aa99f)' }
}

const iconBtnStyles: CSSProperties = {
  flex: '0 0 auto',
  width: 26,
  height: 26,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 7,
  border: '1px solid transparent',
  background: 'transparent',
  color: 'var(--dsw-text-secondary, #4b5563)',
  font: 'inherit',
  fontSize: 14,
  cursor: 'pointer',
}

const dashControlsStyles: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  flexWrap: 'wrap',
  padding: '6px 10px',
  background: 'var(--dsw-bg-tertiary, #f5f6f8)',
  borderBottom: '1px solid var(--dsw-border-color, rgba(15,23,42,0.06))',
  flex: '0 0 auto',
}

const segmentedWrapStyles: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 2,
  padding: 2,
  borderRadius: 8,
  background: 'var(--dsw-bg-secondary, #ffffff)',
  border: '1px solid var(--dsw-border-color, rgba(15,23,42,0.10))',
}

const segmentedLabelStyles: CSSProperties = {
  fontSize: 10.5,
  color: 'var(--dsw-text-tertiary, #6b7280)',
  padding: '0 6px 0 7px',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
}

function segmentOptionStyles(active: boolean): CSSProperties {
  return {
    padding: '3px 9px',
    borderRadius: 6,
    border: 'none',
    font: 'inherit',
    fontSize: 11.5,
    cursor: 'pointer',
    color: active ? 'var(--dsw-text-primary, #1f2329)' : 'var(--dsw-text-tertiary, #6b7280)',
    background: active ? 'var(--dsw-bg-tertiary, #e9ecef)' : 'transparent',
    fontWeight: active ? 600 : 400,
  }
}

const dashNavStyles: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  padding: '5px 8px',
  background: 'var(--dsw-bg-secondary, #ffffff)',
  borderBottom: '1px solid var(--dsw-border-color, rgba(15,23,42,0.06))',
  flex: '0 0 auto',
}

function navIconBtnStyles(disabled: boolean): CSSProperties {
  return {
    width: 28,
    height: 28,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    border: '1px solid transparent',
    background: 'transparent',
    color: 'var(--dsw-text-secondary, #4b5563)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.35 : 1,
  }
}

const navSpacerStyles: CSSProperties = { flex: '1 1 auto' }

const placeholderStyles: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'rgba(255,255,255,0.55)',
  fontSize: 12,
}

const dashStatusStyles: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 12px',
  background: 'var(--dsw-bg-secondary, #ffffff)',
  borderTop: '1px solid var(--dsw-border-color, rgba(15,23,42,0.08))',
  fontSize: 11,
  flex: '0 0 auto',
}

function statusDotStyles(streaming: boolean): CSSProperties {
  return { width: 7, height: 7, borderRadius: '50%', background: streaming ? '#22a06b' : 'var(--dsw-text-tertiary, #6b7280)' }
}

const statusLabelStyles: CSSProperties = {
  color: 'var(--dsw-text-secondary, #4b5563)',
  fontWeight: 600,
}

const statusMetaStyles: CSSProperties = {
  color: 'var(--dsw-text-tertiary, #6b7280)',
  fontVariantNumeric: 'tabular-nums',
}

const recChipStyles: CSSProperties = {
  color: '#d0342c',
  fontWeight: 700,
  fontVariantNumeric: 'tabular-nums',
}

const dashCollapsedStyles: CSSProperties = {
  padding: '7px 12px',
  fontSize: 11.5,
  color: 'var(--dsw-text-tertiary, #6b7280)',
  background: 'var(--dsw-bg-tertiary, #f5f6f8)',
}
