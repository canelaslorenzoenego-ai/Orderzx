/**
 * The gesture overlay: the agent's hands, drawn over the frames.
 *
 * A `multipart/x-mixed-replace` stream shows the page. It cannot show WHY the
 * page changed — a click lands between frames, a scroll of 40 pixels looks like
 * a repaint, and a humanized Bézier move is invisible entirely. So the host
 * publishes every gesture on the `/interactions` channel and this layer
 * animates it in the same normalized space as the frames: the pointer travels,
 * the click pulses, the scroll arrow carries its delta, and the typed-text
 * indicator counts characters without ever showing them.
 *
 * Two hard rules, both of which have bitten lesser versions of this:
 *
 *  1. `pointer-events: none` on the whole layer. An overlay that swallows a
 *     click makes the panel feel broken in a way nobody can diagnose.
 *  2. Nothing here may depend on frame/sequence alignment. Frames and gestures
 *     arrive on different transports at different rates; the overlay is
 *     deliberately approximate and short-lived rather than trying to be exact
 *     and lagging.
 *
 * @module @dsh-community/dsh-browser/client/interaction-overlay
 */

import type { CSSProperties, ReactNode } from 'react'
import type { InteractionRecord } from '../protocol.js'

/** How long each visual stays on screen, in ms. Short: this is a trace, not a log. */
export const OVERLAY_TTL = {
  click: 900,
  focus: 2200,
  scroll: 1100,
  type: 1800,
  key: 1000,
  swipe: 900,
  note: 2600,
  navigate: 1600,
  challenge: 0,
} as const

export interface ClickPulse {
  id: number
  x: number
  y: number
  button: 'left' | 'right' | 'middle'
  label?: string
  at: number
}

export interface FocusRing {
  id: number
  ref: string
  label?: string
  box?: { x: number; y: number; width: number; height: number }
  at: number
}

export interface GestureTrail {
  id: number
  kind: 'drag' | 'swipe'
  points: Array<{ x: number; y: number }>
  at: number
}

export interface ToastMessage {
  id: number
  text: string
  tone: 'info' | 'challenge' | 'navigate'
  at: number
}

export interface OverlayState {
  /** Where the pointer currently is, normalized — and WHOSE it is. Null before the first gesture. */
  cursor: { x: number; y: number; actor: 'agent' | 'user' } | null
  /** True between a `down` and its `up` — the cursor renders pressed. */
  pressed: boolean
  clicks: ClickPulse[]
  focuses: FocusRing[]
  trails: GestureTrail[]
  toasts: ToastMessage[]
  /** Direction + magnitude of the most recent scroll, for the arrow indicator. */
  scroll: { deltaX: number; deltaY: number; at: number } | null
  /** Typing indicator. Carries a character COUNT, never text. */
  typing: { characters: number; secret: boolean; label?: string; at: number } | null
  key: { key: string; at: number } | null
  challenge: { vendor: string; state: 'awaiting-user' | 'solving' | 'resolved' } | null
  /** Last applied sequence — the parent uses it to resume the SSE subscription. */
  lastSeq: number
  nextId: number
}

export function resetOverlay(): OverlayState {
  return {
    cursor: null,
    pressed: false,
    clicks: [],
    focuses: [],
    trails: [],
    toasts: [],
    scroll: null,
    typing: null,
    key: null,
    challenge: null,
    lastSeq: 0,
    nextId: 1,
  }
}

/**
 * Apply one gesture record.
 *
 * Pure and monotonic in `lastSeq`: a duplicate or out-of-order delivery (the
 * SSE backfill can overlap the live subscription for a frame or two) is a
 * no-op rather than a second pulse in the same place.
 */
export function applyInteraction(state: OverlayState, record: InteractionRecord): OverlayState {
  if (typeof record?.seq !== 'number' || record.seq <= state.lastSeq) return state
  const id = state.nextId
  const base = { ...state, lastSeq: record.seq, nextId: state.nextId + 1 }
  const event = record.event
  if (!event || typeof event !== 'object') return base

  switch (event.type) {
    case 'move': {
      const points = event.points ?? []
      const last = points[points.length - 1]
      if (!last) return base
      // A move also draws its path briefly — that is the only way the humanized
      // curve is visible at all.
      return { ...base, cursor: { x: last.x, y: last.y, actor: actorOf(record) }, trails: [...base.trails, { id, kind: 'drag', points, at: Date.now() }] }
    }
    case 'down':
      return { ...base, cursor: { x: event.x, y: event.y, actor: actorOf(record) }, pressed: true }
    case 'up':
      return { ...base, cursor: { x: event.x, y: event.y, actor: actorOf(record) }, pressed: false }
    case 'click':
      return {
        ...base,
        cursor: { x: event.x, y: event.y, actor: actorOf(record) },
        pressed: false,
        clicks: [...base.clicks, { id, x: event.x, y: event.y, button: event.button, ...(event.label ? { label: event.label } : {}), at: Date.now() }],
      }
    case 'drag':
    case 'swipe': {
      const points = event.points && event.points.length >= 2 ? event.points : [event.from, event.to]
      return { ...base, cursor: { x: event.to.x, y: event.to.y, actor: actorOf(record) }, trails: [...base.trails, { id, kind: event.type, points, at: Date.now() }] }
    }
    case 'scroll':
      return { ...base, scroll: { deltaX: event.deltaX, deltaY: event.deltaY, at: Date.now() } }
    case 'type':
      return { ...base, typing: { characters: event.characters, secret: event.secret, ...(event.label ? { label: event.label } : {}), at: Date.now() } }
    case 'key':
      return { ...base, key: { key: event.key, at: Date.now() } }
    case 'focus':
      return {
        ...base,
        focuses: [...base.focuses, { id, ref: event.ref, ...(event.label ? { label: event.label } : {}), ...(event.box ? { box: event.box } : {}), at: Date.now() }],
      }
    case 'navigate':
      return { ...base, toasts: [...base.toasts, { id, text: shortUrl(event.url), tone: 'navigate', at: Date.now() }] }
    case 'challenge':
      return { ...base, challenge: event.state === 'resolved' ? null : { vendor: event.vendor, state: event.state } }
    case 'phase':
    case 'note':
      return { ...base, toasts: [...base.toasts, { id, text: event.type === 'note' ? event.text : (event.detail ?? 'phase change'), tone: 'info', at: Date.now() }] }
    default:
      return base
  }
}

/**
 * Drop expired visuals.
 *
 * Called on an interval by the parent, not from `applyInteraction` — a quiet
 * page must still fade its last click out instead of leaving it pinned until
 * the next gesture happens to arrive.
 */
export function pruneOverlay(state: OverlayState, now = Date.now()): OverlayState {
  const clicks = state.clicks.filter(item => now - item.at < OVERLAY_TTL.click)
  const focuses = state.focuses.filter(item => now - item.at < OVERLAY_TTL.focus)
  const trails = state.trails.filter(item => now - item.at < OVERLAY_TTL.swipe)
  const toasts = state.toasts.filter(item => now - item.at < OVERLAY_TTL.note)
  const scroll = state.scroll && now - state.scroll.at < OVERLAY_TTL.scroll ? state.scroll : null
  const typing = state.typing && now - state.typing.at < OVERLAY_TTL.type ? state.typing : null
  const key = state.key && now - state.key.at < OVERLAY_TTL.key ? state.key : null
  if (
    clicks.length === state.clicks.length
    && focuses.length === state.focuses.length
    && trails.length === state.trails.length
    && toasts.length === state.toasts.length
    && scroll === state.scroll
    && typing === state.typing
    && key === state.key
  ) {
    return state
  }
  return { ...state, clicks, focuses, trails, toasts, scroll, typing, key }
}

/** Whose hand: the record says. Anything unlabeled stays the agent's. */
function actorOf(record: InteractionRecord): 'agent' | 'user' {
  return record.actor === 'user' ? 'user' : 'agent'
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (!parsed.host) return url.slice(0, 60)
    return `${parsed.host}${parsed.pathname}`.slice(0, 60)
  } catch {
    return url.slice(0, 60)
  }
}

// ── rendering ───────────────────────────────────────────────────────────────

export interface InteractionOverlayProps {
  state: OverlayState
  /** Hide the pointer visuals while the human is driving — that is their own cursor. */
  hideAgentPointer?: boolean
}

/**
 * The whole layer is `pointer-events: none`. Every child inherits it.
 */
export function InteractionOverlay(props: InteractionOverlayProps): ReactNode {
  const { state } = props
  const showPointer = !props.hideAgentPointer
  return (
    <div style={layerStyles} aria-hidden="true">
      <InteractionStyles />
      {state.focuses.map(focus => (
        <FocusBox key={focus.id} focus={focus} />
      ))}
      {state.trails.map(trail => (
        <Trail key={trail.id} trail={trail} />
      ))}
      {state.clicks.map(click => (
        <ClickRipple key={click.id} click={click} />
      ))}
      {showPointer && state.cursor ? <ActorCursor point={state.cursor} pressed={state.pressed} /> : null}
      {state.scroll ? <ScrollArrow scroll={state.scroll} /> : null}
      {state.typing ? <TypingBadge typing={state.typing} /> : null}
      {state.key ? <KeyBadge keyName={state.key.key} /> : null}
      <div style={toastColumnStyles}>
        {state.toasts.slice(-3).map(toast => (
          <div key={toast.id} style={toastStyles(toast.tone)}>{toast.text}</div>
        ))}
      </div>
      {state.challenge ? (
        <div style={challengeBannerStyles}>
          {state.challenge.vendor} challenge — {state.challenge.state === 'awaiting-user' ? 'yours to solve' : 'solving…'}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Two hands on one mouse. The agent gets a BLUE HAND (not an arrow — the user
 * asked for "the model's hands in the chrome"): the same pointing-hand glyph
 * the human gets, in the agent's colour, with an "agent" tag and a press
 * squash on every click. A human who took over is the amber hand with a "you"
 * tag. An observer watching the stream can always tell WHOSE hand is on the
 * mouse, which is the whole point of a stream you can grab.
 */
function ActorCursor({ point, pressed }: { point: { x: number; y: number; actor: 'agent' | 'user' }; pressed: boolean }): ReactNode {
  if (point.actor === 'user') {
    return (
      <div style={cursorWrapStyles(point)} data-actor="user">
        <svg width="26" height="26" viewBox="0 0 24 24" style={pressed ? cursorPressedStyles : cursorStyles}>
          <path
            d={HAND_PATH}
            fill="rgba(210,153,34,0.95)"
            stroke="rgba(255,255,255,0.92)"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
        </svg>
        <span style={youTagStyles}>you</span>
      </div>
    )
  }
  return (
    <div style={cursorWrapStyles(point)} data-actor="agent">
      <svg width="26" height="26" viewBox="0 0 24 24" style={pressed ? cursorPressedStyles : cursorStyles}>
        <path
          d={HAND_PATH}
          fill="rgba(56,139,253,0.95)"
          stroke="rgba(255,255,255,0.92)"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
        {/* wristband: whose hand, readable at a glance on a moving stream */}
        <circle cx="11" cy="20.4" r="1.6" fill="rgba(255,255,255,0.95)" />
      </svg>
      <span style={agentTagStyles}>agent</span>
    </div>
  )
}

/** One pointing-hand silhouette shared by both actors (24×24 viewBox). */
const HAND_PATH =
  'M8 13V5.5a1.5 1.5 0 0 1 3 0V11l4.8 1.2c1.6.4 2.6 1.9 2.3 3.5l-.6 3a3.5 3.5 0 0 1-3.4 2.8H10a4 4 0 0 1-3.2-1.6L4 16.2a1.6 1.6 0 0 1 2.5-2L8 16z'

const youTagStyles: CSSProperties = {
  position: 'absolute',
  left: 18,
  top: 14,
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: '#d29922',
  background: 'rgba(20,14,2,0.82)',
  border: '1px solid rgba(210,153,34,0.5)',
  borderRadius: 4,
  padding: '1px 4px',
  whiteSpace: 'nowrap',
}

/** The agent's tag: same chip as "you", in the agent's blue. */
const agentTagStyles: CSSProperties = {
  position: 'absolute',
  left: 20,
  top: 16,
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: '#58a6ff',
  background: 'rgba(2,10,24,0.82)',
  border: '1px solid rgba(88,166,255,0.5)',
  borderRadius: 4,
  padding: '1px 4px',
  whiteSpace: 'nowrap',
}

function ClickRipple({ click }: { click: ClickPulse }): ReactNode {
  const tone = click.button === 'left' ? '56,139,253' : click.button === 'right' ? '210,153,34' : '163,113,247'
  return (
    <div style={rippleWrapStyles(click.x, click.y)}>
      <span className="dsh-browser-ripple" style={{ ...rippleStyles, borderColor: `rgba(${tone},0.95)`, boxShadow: `0 0 12px rgba(${tone},0.55)` }} />
      {click.label ? <span style={rippleLabelStyles}>{click.label.slice(0, 44)}</span> : null}
    </div>
  )
}

function FocusBox({ focus }: { focus: FocusRing }): ReactNode {
  if (!focus.box) {
    // No geometry: still worth saying which ref the agent settled on.
    return <div style={focusChipStyles}>{focus.ref}{focus.label ? ` · ${focus.label.slice(0, 40)}` : ''}</div>
  }
  const { x, y, width, height } = focus.box
  return (
    <div className="dsh-browser-focus" style={focusBoxStyles(x, y, width, height)}>
      <span style={focusTagStyles}>{focus.ref}{focus.label ? ` · ${focus.label.slice(0, 34)}` : ''}</span>
    </div>
  )
}

function Trail({ trail }: { trail: GestureTrail }): ReactNode {
  const points = trail.points.filter(Boolean)
  if (points.length < 2) return null
  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${(point.x * 100).toFixed(2)} ${(point.y * 100).toFixed(2)}`).join(' ')
  const isSwipe = trail.kind === 'swipe'
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={trailSvgStyles}>
      <path
        className="dsh-browser-trail"
        d={path}
        fill="none"
        stroke={isSwipe ? 'rgba(63,185,80,0.95)' : 'rgba(56,139,253,0.75)'}
        strokeWidth={isSwipe ? 1.1 : 0.55}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

function ScrollArrow({ scroll }: { scroll: { deltaX: number; deltaY: number } }): ReactNode {
  const vertical = Math.abs(scroll.deltaY) >= Math.abs(scroll.deltaX)
  const amount = vertical ? Math.abs(scroll.deltaY) : Math.abs(scroll.deltaX)
  // Arrow points the way the CONTENT moves, which is how a reader perceives it.
  const rotate = vertical ? (scroll.deltaY > 0 ? 180 : 0) : scroll.deltaX > 0 ? 270 : 90
  return (
    <div style={scrollWrapStyles}>
      <svg width="26" height="26" viewBox="0 0 24 24" style={{ transform: `rotate(${rotate}deg)` }}>
        <path d="M12 4 L12 19 M6 13 L12 19 L18 13" fill="none" stroke="rgba(255,255,255,0.92)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span style={scrollAmountStyles}>{Math.round(amount)}px</span>
    </div>
  )
}

function TypingBadge({ typing }: { typing: { characters: number; secret: boolean; label?: string } }): ReactNode {
  return (
    <div style={typingBadgeStyles}>
      <span style={typingDotsStyles} className="dsh-browser-typing" aria-hidden="true">•••</span>
      {typing.secret ? 'typing a secret' : `typing ${typing.characters} character${typing.characters === 1 ? '' : 's'}`}
      {typing.label ? ` → ${typing.label.slice(0, 28)}` : ''}
    </div>
  )
}

function KeyBadge({ keyName }: { keyName: string }): ReactNode {
  return <div style={keyBadgeStyles}>{keyName.length > 14 ? `${keyName.slice(0, 13)}…` : keyName}</div>
}

/** Keyframes, injected once. Inline styles cannot express them. */
function InteractionStyles(): ReactNode {
  return (
    <style>{`
@keyframes dsh-browser-ripple {
  0% { transform: translate(-50%,-50%) scale(0.35); opacity: 0.95; }
  70% { opacity: 0.55; }
  100% { transform: translate(-50%,-50%) scale(2.4); opacity: 0; }
}
@keyframes dsh-browser-focus {
  0% { opacity: 0; }
  18% { opacity: 1; }
  78% { opacity: 1; }
  100% { opacity: 0; }
}
@keyframes dsh-browser-trail {
  0% { opacity: 0; stroke-dashoffset: 60; }
  25% { opacity: 1; }
  100% { opacity: 0; stroke-dashoffset: 0; }
}
@keyframes dsh-browser-typing {
  0%,100% { opacity: 0.35; }
  50% { opacity: 1; }
}
.dsh-browser-ripple { animation: dsh-browser-ripple 900ms cubic-bezier(0.2,0.7,0.3,1) forwards; }
.dsh-browser-focus { animation: dsh-browser-focus 2200ms ease-out forwards; }
.dsh-browser-trail { animation: dsh-browser-trail 900ms ease-out forwards; stroke-dasharray: 60; }
.dsh-browser-typing { animation: dsh-browser-typing 900ms ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .dsh-browser-ripple, .dsh-browser-focus, .dsh-browser-trail, .dsh-browser-typing { animation: none !important; }
  .dsh-browser-ripple { opacity: 0.9; }
  .dsh-browser-focus { opacity: 0.8; }
  .dsh-browser-trail { opacity: 0.7; }
}
`}</style>
  )
}

// ── styles ──────────────────────────────────────────────────────────────────

const layerStyles: CSSProperties = {
  position: 'absolute',
  inset: 0,
  pointerEvents: 'none',
  overflow: 'hidden',
  zIndex: 3,
}

const pct = (value: number): string => `${(value * 100).toFixed(3)}%`

function cursorWrapStyles(point: { x: number; y: number }): CSSProperties {
  return {
    position: 'absolute',
    left: pct(point.x),
    top: pct(point.y),
    // The transition IS the animation: a move event repositions this element
    // and the browser interpolates, so the pointer appears to travel.
    transition: 'left 220ms cubic-bezier(0.3,0.7,0.3,1), top 220ms cubic-bezier(0.3,0.7,0.3,1)',
    transform: 'translate(-3px,-2px)',
    filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.6))',
    willChange: 'left, top',
  }
}

const cursorStyles: CSSProperties = { display: 'block' }
const cursorPressedStyles: CSSProperties = { display: 'block', transform: 'scale(0.82)' }

function rippleWrapStyles(x: number, y: number): CSSProperties {
  return { position: 'absolute', left: pct(x), top: pct(y), width: 0, height: 0 }
}

const rippleStyles: CSSProperties = {
  position: 'absolute',
  left: 0,
  top: 0,
  width: 34,
  height: 34,
  borderRadius: '50%',
  border: '2px solid',
  display: 'block',
}

const rippleLabelStyles: CSSProperties = {
  position: 'absolute',
  left: 20,
  top: -22,
  whiteSpace: 'nowrap',
  fontSize: 10.5,
  padding: '2px 6px',
  borderRadius: 5,
  color: 'rgba(255,255,255,0.95)',
  background: 'rgba(10,12,18,0.82)',
  border: '1px solid rgba(56,139,253,0.4)',
}

function focusBoxStyles(x: number, y: number, width: number, height: number): CSSProperties {
  return {
    position: 'absolute',
    left: pct(x),
    top: pct(y),
    width: pct(width),
    height: pct(height),
    border: '2px solid rgba(163,113,247,0.95)',
    borderRadius: 6,
    background: 'rgba(163,113,247,0.14)',
    boxShadow: '0 0 14px rgba(163,113,247,0.4)',
    boxSizing: 'border-box',
  }
}

const focusTagStyles: CSSProperties = {
  position: 'absolute',
  top: -19,
  left: -2,
  whiteSpace: 'nowrap',
  fontSize: 10.5,
  padding: '2px 6px',
  borderRadius: 5,
  color: 'rgba(255,255,255,0.96)',
  background: 'rgba(163,113,247,0.9)',
}

const focusChipStyles: CSSProperties = {
  position: 'absolute',
  left: 10,
  bottom: 10,
  fontSize: 11,
  padding: '3px 8px',
  borderRadius: 6,
  color: 'rgba(255,255,255,0.95)',
  background: 'rgba(163,113,247,0.85)',
}

const trailSvgStyles: CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
}

const scrollWrapStyles: CSSProperties = {
  position: 'absolute',
  right: 14,
  top: '50%',
  transform: 'translateY(-50%)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 2,
  padding: '6px 8px',
  borderRadius: 10,
  background: 'rgba(10,12,18,0.72)',
  border: '1px solid rgba(128,128,128,0.28)',
}

const scrollAmountStyles: CSSProperties = {
  fontSize: 10,
  color: 'rgba(255,255,255,0.85)',
  fontVariantNumeric: 'tabular-nums',
}

const typingBadgeStyles: CSSProperties = {
  position: 'absolute',
  left: '50%',
  bottom: 14,
  transform: 'translateX(-50%)',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  whiteSpace: 'nowrap',
  fontSize: 11.5,
  padding: '5px 10px',
  borderRadius: 999,
  color: 'rgba(255,255,255,0.95)',
  background: 'rgba(10,12,18,0.8)',
  border: '1px solid rgba(63,185,80,0.45)',
}

const typingDotsStyles: CSSProperties = { letterSpacing: 2, color: 'rgba(63,185,80,0.95)' }

const keyBadgeStyles: CSSProperties = {
  position: 'absolute',
  right: 14,
  bottom: 14,
  fontSize: 11,
  padding: '4px 9px',
  borderRadius: 7,
  color: 'rgba(255,255,255,0.95)',
  background: 'rgba(10,12,18,0.8)',
  border: '1px solid rgba(128,128,128,0.3)',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
}

const toastColumnStyles: CSSProperties = {
  position: 'absolute',
  left: '50%',
  top: 10,
  transform: 'translateX(-50%)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 4,
  maxWidth: '86%',
}

function toastStyles(tone: ToastMessage['tone']): CSSProperties {
  const border = tone === 'challenge' ? 'rgba(210,153,34,0.55)' : tone === 'navigate' ? 'rgba(56,139,253,0.45)' : 'rgba(128,128,128,0.3)'
  return {
    fontSize: 11,
    padding: '3px 9px',
    borderRadius: 999,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: '100%',
    color: 'rgba(255,255,255,0.94)',
    background: 'rgba(10,12,18,0.8)',
    border: `1px solid ${border}`,
  }
}

const challengeBannerStyles: CSSProperties = {
  position: 'absolute',
  left: '50%',
  top: '38%',
  transform: 'translateX(-50%)',
  fontSize: 12,
  fontWeight: 600,
  padding: '6px 12px',
  borderRadius: 9,
  whiteSpace: 'nowrap',
  color: 'rgba(255,255,255,0.97)',
  background: 'rgba(120,80,10,0.9)',
  border: '1px solid rgba(210,153,34,0.8)',
}
