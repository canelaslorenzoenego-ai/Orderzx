/**
 * The inline live frame — the browser screen, directly in the chat.
 *
 * The user's words: "I don't want the sidebar, do it directly in chat
 * dashboard, that will extend, make the chrome screen a little so I can see
 * all chrome at once."
 *
 * So this component is the PRIMARY watch surface:
 *
 *  - It renders inside the conversation (hung off the boot card), so the chat
 *    dashboard EXTENDS downward with the live screen instead of a panel
 *    covering or sitting beside it. The conversation stays readable above it.
 *  - It is compact: the whole chrome window — traffic lights, URL bar, live
 *    viewport, status rail — fits on one phone screen at once
 *    (`clamp(240px, 46dvh, 460px)`). No scrolling to see "all chrome".
 *  - It auto-expands when the model starts searching (activity on the session)
 *    and auto-collapses when the model stops (idle for INLINE_IDLE_COLLAPSE_MS
 *    with no challenge and no takeover). The user's manual open/close always
 *    wins and a manual close sticks for the rest of that browser session —
 *    the next `/start` re-arms it.
 *  - View-only by design. Takeover, capture, and desktop-view stay in the full
 *    panel (one "expand" button opens it); an inline surface that accepted
 *    drive commands from a scrollable chat card would steal taps from the
 *    conversation.
 *
 * All decision logic is a pure exported function (`inlineLiveDecision`) so the
 * static smoke suite can assert the whole expand/collapse matrix without a DOM.
 *
 * @module @dsh-community/dsh-browser/client/inline-live
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { BrowserStatus } from '../protocol.js'
import { STREAMING_PHASES } from '../protocol.js'
import { BrowserFrame } from './browser-frame.js'
import { bootLabel, reduceStatus, resetBoot, type BootState } from './boot-sequence.js'
import { LiveViewport, useStreamSession } from './live-viewport.js'
import type { FetchLike } from './wire.js'

// ── pure decision logic ─────────────────────────────────────────────────────

/** Idle this long with no model activity → collapse (the model stopped searching). */
export const INLINE_IDLE_COLLAPSE_MS = 15_000
/** How often the idle check runs. Coarse on purpose: this is not animation. */
export const INLINE_CHECK_MS = 5_000
/** The frame box: whole chrome visible at once, phone included. */
export const INLINE_FRAME_HEIGHT = 'clamp(240px, 46dvh, 460px)'

/**
 * Everything that counts as "the model is doing something": gestures, URL
 * changes, new frames, timeline growth, tab switches. When this signature is
 * unchanged, the session is idle.
 */
export function activitySignature(status: BrowserStatus | undefined): string | null {
  if (!status) return null
  const active = status.session?.tabs?.[status.session?.activeTab ?? 0]
  // NOT frames.lastSequence: the capture loop runs continuously, so frame
  // sequence advances even on a perfectly idle page and would mask idleness
  // forever. Real "the model is doing something" signals: gesture sequence,
  // navigation, timeline tail, tab switch, phase change.
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
 *      streaming + fresh activity        → expanded
 *      streaming + idle ≥ threshold, no blocking challenge, agent owns pointer→ collapsed
 *      not streaming                     → collapsed
 *      blocking challenge or takeover    → expanded (the user is needed / driving)
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
  // Streaming, recently active, under the idle threshold: hold current state.
  return { expanded: input.idleMs < INLINE_IDLE_COLLAPSE_MS, nextMode: 'auto', nextSessionKey: key }
}

// ── the component ───────────────────────────────────────────────────────────

export interface InlineLiveFrameProps {
  /** The conversation/session id the card belongs to. */
  sessionId: string
  /**
   * The browser session key used for manual-close memory, when known
   * (meta.browserSession). Falls back to `sessionId`.
   */
  browserSession?: string
  fetcher?: FetchLike
  /** Opens the full panel (takeover, capture, desktop view live there). */
  onOpenPanel?(): void
  /** Initial collapsed state override for tests/SSR. */
  defaultExpanded?: boolean
}

/**
 * The live chrome window, inline in the chat.
 *
 * Keeps its own view-scoped stream session: the panel may or may not exist,
 * and the inline frame must never fight it for drive scope.
 */
export function InlineLiveFrame(props: InlineLiveFrameProps): ReactNode {
  const fetcher = props.fetcher
  const [expanded, setExpanded] = useState<boolean>(props.defaultExpanded ?? false)
  const [mode, setMode] = useState<InlineMode>('auto')
  const [sessionKey, setSessionKey] = useState<string | undefined>(undefined)
  const [boot, setBoot] = useState<BootState>(() => resetBoot())

  // Poll status even while collapsed (stall detection off — there is no <img>
  // mounted to keep alive); the activity signature is what re-expands us.
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

  // Activity bookkeeping (refs: no re-render per poll).
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

  // The decision interval: auto-expand on fresh activity, auto-collapse on idle.
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

  const toggle = (): void => {
    // Manual toggle: the user's word is final for this browser session.
    setMode(previous => {
      const next: InlineMode = expanded ? 'closed' : 'open'
      void previous
      return next
    })
    setExpanded(value => !value)
  }

  return (
    <div style={inlineCardStyles} data-dsh-inline-live={expanded ? 'expanded' : 'collapsed'}>
      <div style={inlineHeaderStyles}>
        <button
          type="button"
          style={inlineToggleStyles}
          onClick={toggle}
          aria-expanded={expanded}
          aria-label={expanded ? 'collapse the live browser view' : 'expand the live browser view'}
          title={expanded ? 'collapse — keep the chat full-width' : 'expand — watch the browser live, right here'}
        >
          <span style={chevronStyles(expanded)} aria-hidden="true">▾</span>
          <span style={inlineDotStyles(streaming)} aria-hidden="true" />
          <span style={inlineTitleStyles}>
            {streaming ? 'live browser' : bootLabel(boot)}
            {activeUrl ? ` · ${shortHost(activeUrl)}` : ''}
          </span>
          {streaming && fps > 0 ? <span style={inlineFpsStyles}>{fps} fps</span> : null}
        </button>
        {props.onOpenPanel ? (
          <button type="button" style={inlinePanelButtonStyles} onClick={props.onOpenPanel} title="open the full panel — takeover, capture, desktop view">
            ⤢ panel
          </button>
        ) : null}
      </div>

      {expanded ? (
        <div style={inlineFrameBoxStyles}>
          <BrowserFrame
            style="chrome"
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
            onNav={() => undefined}
            onAddress={() => undefined}
            onTab={() => undefined}
            onToggleTakeover={() => props.onOpenPanel?.()}
            onCapture={() => props.onOpenPanel?.()}
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
              placeholder={<InlinePlaceholder label={bootLabel(boot)} />}
            />
          </BrowserFrame>
        </div>
      ) : null}
    </div>
  )
}

function InlinePlaceholder({ label }: { label: string }): ReactNode {
  return <div style={inlinePlaceholderStyles}>{label}…</div>
}

function shortHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url.slice(0, 32)
  }
}

// ── styles ──────────────────────────────────────────────────────────────────

const inlineCardStyles: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  margin: '6px 0',
  minWidth: 0,
}

const inlineHeaderStyles: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
}

const inlineToggleStyles: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  flex: '1 1 auto',
  minWidth: 0,
  padding: '6px 10px',
  borderRadius: 999,
  border: '1px solid rgba(88,166,255,0.32)',
  background: 'rgba(88,166,255,0.10)',
  color: 'var(--dsw-text-primary, rgba(255,255,255,0.92))',
  font: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
  textAlign: 'left',
}

function chevronStyles(expanded: boolean): CSSProperties {
  return {
    display: 'inline-block',
    transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)',
    transition: 'transform 160ms ease',
    flex: '0 0 auto',
    opacity: 0.8,
  }
}

function inlineDotStyles(streaming: boolean): CSSProperties {
  return {
    width: 7,
    height: 7,
    borderRadius: '50%',
    flex: '0 0 auto',
    background: streaming ? '#3fb950' : '#58a6ff',
  }
}

const inlineTitleStyles: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  minWidth: 0,
}

const inlineFpsStyles: CSSProperties = {
  flex: '0 0 auto',
  fontSize: 10.5,
  opacity: 0.7,
  fontVariantNumeric: 'tabular-nums',
}

const inlinePanelButtonStyles: CSSProperties = {
  flex: '0 0 auto',
  padding: '6px 10px',
  borderRadius: 999,
  border: '1px solid rgba(128,128,128,0.3)',
  background: 'transparent',
  color: 'var(--dsw-text-secondary, rgba(255,255,255,0.72))',
  font: 'inherit',
  fontSize: 11.5,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const inlineFrameBoxStyles: CSSProperties = {
  // The whole chrome window at once — titlebar, URL bar, pixels, rail — with
  // room to spare above it in the conversation. dvh so a collapsing mobile URL
  // bar cannot crop the footer.
  height: INLINE_FRAME_HEIGHT,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
}

const inlinePlaceholderStyles: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--dsw-text-tertiary, #8a8a94)',
  fontSize: 12,
}
