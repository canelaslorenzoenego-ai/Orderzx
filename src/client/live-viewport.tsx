/**
 * The live view: stream transport, and the pointer.
 *
 * `useStreamSession` owns grant → stream → refresh → error, and
 * `LiveViewport` renders the frames and translates pointer events into
 * normalized control messages.
 *
 * The transport is an `<img>` pointed at a `multipart/x-mixed-replace` route.
 * That choice carries a constraint worth stating, because it shapes everything
 * below: **the img's `load` event is the only liveness signal this transport
 * has.** There is no frame callback, no bitrate, no "still connected" event. So
 * liveness is inferred from load frequency — if no `load` fires within a
 * multiple of the expected frame interval, we assume the stream died and
 * re-grant. Getting this wrong in the optimistic direction leaves the panel
 * showing a stale frame forever with a green "live" badge, which is the worst
 * possible failure mode for a tool whose whole purpose is showing the truth.
 *
 * Pointer handling:
 *   - Coordinates are normalized 0..1 against the rendered frame, never pixels.
 *     The panel is resizable and the browser viewport can change underneath it,
 *     so pixels would drift.
 *   - Input is forwarded ONLY while the user owns the pointer (`driving`).
 *     Otherwise a click on the panel would fight the agent's Bézier path for the
 *     same mouse — two input sources on one browser produces gestures neither
 *     intended.
 *   - Pointer capture keeps a drag that leaves the frame still delivering moves
 *     to the same element, so dragging a scrollbar or selecting text works.
 *
 * @module @dsh-community/dsh-browser/client/live-viewport
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react'
import type { BrowserStatus, ControlMessage, FrameSource } from '../protocol.js'
import {
  requestGrant,
  requestStatus,
  sendControl,
  sendSession,
  shouldRefresh,
  streamUrl,
  frameNowUrl,
  captureUrl,
  requestCaptureGrant,
  subscribeInteractions,
  type FetchLike,
} from './wire.js'
import { applyInteraction, pruneOverlay, resetOverlay, type OverlayState } from './interaction-overlay.js'
import { captionOfEvent } from '../interactions.js'
import { InteractionOverlay } from './interaction-overlay.js'

// ── stream session ──────────────────────────────────────────────────────────

export const STREAM_PHASES = ['idle', 'granting', 'live', 'stalled', 'error'] as const
export type StreamPhase = (typeof STREAM_PHASES)[number]

/** How often to poll `/status` while the panel is open. */
export const STATUS_POLL_MS = 1500
/**
 * No `load` event within this multiple of the expected frame interval means the
 * stream is considered stalled. Generous, because the `screenshot` tier runs at
 * 2–6 fps and a GC pause must not look like a disconnect.
 */
export const STALL_MULTIPLIER = 6
export const STALL_MIN_MS = 4000

export interface StreamSession {
  phase: StreamPhase
  /** Signed URL for the `<img src>`, or undefined until granted. */
  streamUrl: string | undefined
  /**
   * Frame transport actually in use. Android Chrome and Safari never render
   * `multipart/x-mixed-replace` in an `<img>` — the screen stays black while
   * everything else looks healthy. When the multipart `<img>` produces no load
   * event within STALL_MIN_MS of going live, the hook falls back to `poll`:
   * `pollUrl` then serves ONE latest frame per GET and bumps on a timer.
   */
  streamMode: 'multipart' | 'poll'
  /** Single-frame fallback URL (poll mode only); changes on every tick. */
  pollUrl: string | undefined
  /** `drive` when the host honoured a takeover, else `view`. */
  scope: 'view' | 'drive'
  sessionId: string | undefined
  status: BrowserStatus | undefined
  error: string | null
  /** Monotonic; changes on every re-grant so the `<img>` remounts cleanly. */
  grantGeneration: number
  /** Wire to the `<img>` onLoad. Liveness is inferred from this, nothing else. */
  onLoad(): void
  /**
   * The `browser-control` capability. Deliberately separate from the stream token
   * embedded in `streamUrl`: the host validates the payload `kind`, so posting a
   * stream token to /control is a 403 rather than a silent downgrade.
   */
  controlToken: string | undefined
  /** Call after a takeover/resume so the scope is re-minted. */
  refresh(): void
  /** Ask for `drive` scope. Only honoured by the host during a takeover. */
  requestDrive(): Promise<boolean>
  /**
   * The agent's gesture overlay state, fed from the `/interactions` channel.
   * Reset on re-grant: a new stream means a possibly different session, and an
   * old cursor position over a new page is a lie.
   */
  overlay: OverlayState
  /** The newest gesture, captioned — the live 'what is it doing' chip. */
  gesture: { seq: number; actor: string; text: string } | null
}

export interface StreamSessionOptions {
  fetcher?: FetchLike
  /** Explicit session id; when omitted the host uses its active session. */
  session?: string
  /** Expected frame interval, for stall detection. Derived from fps when absent. */
  frameIntervalMs?: number
  /** False stops polling and releases the stream (panel closed). */
  active?: boolean
  /**
   * False disables stall-driven re-grants. The home tab keeps the hook alive
   * for status polling without mounting the `<img>` — with stall detection on,
   * the absent img would read as a dead stream and churn grants forever.
   */
  stallDetection?: boolean
}

/**
 * Grant → stream → poll → refresh.
 *
 * Re-grants on two triggers only: an explicit `refresh()`, and a token that is
 * about to expire. A stalled stream bumps `grantGeneration`, which changes the
 * `<img>` src and forces the browser to reopen the multipart response — the
 * transport has no in-band reconnect.
 */
export function useStreamSession(options: StreamSessionOptions = {}): StreamSession {
  const fetcher = options.fetcher ?? (fetch as unknown as FetchLike)
  const active = options.active !== false
  const [phase, setPhase] = useState<StreamPhase>('idle')
  const [token, setToken] = useState<{ stream?: string; control: string; scope: 'view' | 'drive'; expiresAt: number } | null>(null)
  const [sessionId, setSessionId] = useState<string | undefined>(options.session)
  const [status, setStatus] = useState<BrowserStatus | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)
  const [heartbeat, setHeartbeat] = useState(0)
  const [gesture, setGesture] = useState<{ seq: number; actor: string; text: string } | null>(null)
  const [overlay, setOverlay] = useState<OverlayState>(() => resetOverlay())
  const lastLoadAt = useRef<number>(0)
  // Multipart liveness probe: did the <img> EVER fire load for this grant?
  const loadedOnce = useRef(false)
  const [streamMode, setStreamMode] = useState<'multipart' | 'poll'>('multipart')
  const [pollNonce, setPollNonce] = useState(0)
  /** Epoch ms until which the poll ticker runs at the burst floor. */
  const [burstUntil, setBurstUntil] = useState(0)

  const grant = useCallback(
    async (scope: 'view' | 'drive') => {
      if (!active) return null
      setPhase('granting')
      try {
        const result = await requestGrant(fetcher, { ...(options.session ? { session: options.session } : {}), scope })
        if (result.kind === 'bootstrap' && result.control) {
          // No browser exists yet. Keep the bootstrap control token: status
          // polling works with it (the panel shows running-session tabs and the
          // home tab can POST start-browser), but there is nothing to stream.
          setSessionId(undefined)
          setToken({ control: result.control.token, scope: 'view', expiresAt: result.control.expiresAt })
          setError(null)
          setPhase('idle')
          return null
        }
        if (result.kind !== 'session' || !result.stream || !result.control) {
          setPhase('error')
          setError('the host returned a capture grant where a session grant was expected')
          return null
        }
        setSessionId(result.session)
        setToken({
          stream: result.stream.token,
          control: result.control.token,
          // Read what we GOT, not what we asked for: the host downgrades to
          // `view` unless a takeover is active.
          scope: result.scope ?? 'view',
          expiresAt: Math.min(result.stream.expiresAt, result.control.expiresAt),
        })
        setError(null)
        setPhase('live')
        // New stream → new gesture timeline. Re-seed from the host's snapshot so
        // a panel opened mid-session still shows where the pointer is resting.
        setOverlay(current => ({ ...resetOverlay(), cursor: current.cursor }))
        lastLoadAt.current = Date.now()
        loadedOnce.current = false
        setHeartbeat(Date.now())
        return result.scope ?? 'view'
      } catch (err) {
        setPhase('error')
        setError(err instanceof Error ? err.message : String(err))
        return null
      }
    },
    [active, fetcher, options.session],
  )

  // Initial grant, and re-grant when the caller asks.
  useEffect(() => {
    if (!active) {
      setPhase('idle')
      setToken(null)
      return
    }
    void grant('view')
    // `generation` is the explicit re-grant trigger.
  }, [active, generation, grant])

  // Status polling. Pauses when inactive; never throws into the render path.
  useEffect(() => {
    if (!active || !token) return
    let cancelled = false
    const tick = async (): Promise<void> => {
      const next = await requestStatus(fetcher, token.stream ?? token.control)
      if (cancelled) return
      if (next) {
        setStatus(next)
        // Seed the overlay cursor from the host's snapshot ONCE per stream, so
        // opening the panel mid-session shows the pointer where it actually is.
        if (next.lastPointer) {
          const point = next.lastPointer
          setOverlay(current => (current.lastSeq === 0 && !current.cursor ? { ...current, cursor: { ...point, actor: 'agent' as const } } : current))
        }
        // A 403/404 on status means the token died or the session closed.
      } else if (phase === 'live') {
        setPhase('stalled')
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), STATUS_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [active, token, fetcher, phase])

  // Token refresh + stall detection.
  useEffect(() => {
    if (!active || !token) return
    const fps = status?.frames?.fps ?? 0
    const expected = options.frameIntervalMs ?? (fps > 0 ? 1000 / fps : 400)
    const stallAfter = Math.max(STALL_MIN_MS, expected * STALL_MULTIPLIER)
    const timer = setInterval(() => {
      if (shouldRefresh(token.expiresAt)) {
        void grant(token.scope)
        return
      }
      if (options.stallDetection !== false && streamMode === 'multipart' && token.stream && phase === 'live' && lastLoadAt.current > 0 && Date.now() - lastLoadAt.current > stallAfter) {
        // The transport gives us no disconnect event; infer it from silence.
        // Poll mode is exempt: its loads come from the ticker below, and a
        // re-grant loop would just re-probe multipart forever on a browser
        // that cannot render it.
        setPhase('stalled')
        setGeneration(value => value + 1)
      }
    }, Math.min(2000, Math.max(500, stallAfter / 3)))
    return () => clearInterval(timer)
    // `heartbeat` is updated by onLoad; including it here is what makes a live
    // stream keep cancelling its own stall timer instead of firing once and
    // reconnecting forever.
  }, [active, token, status, phase, grant, options.frameIntervalMs, heartbeat, options.stallDetection, streamMode])

  // ── multipart probe → single-frame fallback ───────────────────────────────
  // If the multipart <img> never fires load within STALL_MIN_MS of going live,
  // this browser cannot render multipart/x-mixed-replace (Android Chrome,
  // Safari). Switch to polling the single-frame route instead of showing a
  // black screen that "looks connected".
  useEffect(() => {
    if (phase !== 'live' || streamMode !== 'multipart' || !token?.stream) return
    if (loadedOnce.current) return
    const probe = setTimeout(() => {
      if (!loadedOnce.current) setStreamMode('poll')
    }, STALL_MIN_MS)
    return () => clearTimeout(probe)
  }, [phase, streamMode, token, heartbeat])

  // The poll ticker: one latest frame per GET, at the stream's own cadence —
  // EXCEPT while the agent is acting: a gesture (or a fresh tool capture)
  // opens a 4 s burst window at the 200 ms floor, and every gesture repaints
  // immediately, so each click the model makes lands on screen as it happens
  // instead of one idle-tier tick later (the "I can't see it searching" bug).
  useEffect(() => {
    if (streamMode !== 'poll' || !active || !token?.stream) return
    const bursting = Date.now() < burstUntil
    const fps = status?.frames?.fps ?? 2
    const every = bursting ? 200 : Math.min(2000, Math.max(250, fps > 0 ? 1000 / fps : 500))
    setPollNonce(value => value + 1) // paint one immediately
    const timer = setInterval(() => setPollNonce(value => value + 1), every)
    return () => clearInterval(timer)
  }, [streamMode, active, token, status?.frames?.fps, burstUntil])

  // Gesture channel. Same lifetime as the stream token; backfills whatever the
  // ring still holds so a panel opened mid-gesture does not miss the click that
  // is already on screen.
  useEffect(() => {
    if (!active || !token?.stream) return
    let prunedAt = Date.now()
    const subscription = subscribeInteractions({
      token: token.stream,
      since: 0,
      onEvent: record => {
        setOverlay(current => applyInteraction(current, record))
        setGesture({ seq: record.seq, actor: record.actor, text: captionOfEvent(record.event) })
        // The agent just ACTED: repaint now and hold the burst window open so
        // the on-demand tier streams at the floor cadence while it works.
        setBurstUntil(Date.now() + 4000)
        setPollNonce(value => value + 1)
      },
      onResync: () => setOverlay(current => ({ ...resetOverlay(), cursor: current.cursor })),
    })
    const timer = setInterval(() => {
      prunedAt = Date.now()
      setOverlay(current => pruneOverlay(current, prunedAt))
    }, 350)
    return () => {
      subscription.stop()
      clearInterval(timer)
    }
  }, [active, token])

  const requestDrive = useCallback(async () => {
    const scope = await grant('drive')
    return scope === 'drive'
  }, [grant])

  /** Report a frame arriving. This is the ONLY liveness signal the transport has. */
  const onLoad = useCallback(() => {
    lastLoadAt.current = Date.now()
    loadedOnce.current = true
    setPhase(current => (current === 'stalled' ? 'live' : current))
    setHeartbeat(lastLoadAt.current)
  }, [])

  return {
    phase,
    streamUrl: token?.stream && phase !== 'idle' ? streamUrl(token.stream) : undefined,
    streamMode,
    pollUrl: streamMode === 'poll' && token?.stream && phase !== 'idle' ? frameNowUrl(token.stream, pollNonce) : undefined,
    scope: token?.scope ?? 'view',
    sessionId,
    status,
    error,
    grantGeneration: generation,
    onLoad,
    controlToken: token?.control,
    refresh: () => setGeneration(value => value + 1),
    requestDrive,
    gesture,
    overlay,
  }
}

// ── pointer translation ─────────────────────────────────────────────────────

/**
 * Normalize a pointer event to 0..1 against the element's content box.
 *
 * Uses `getBoundingClientRect` rather than `offsetX/offsetY`: offsetX is
 * relative to the *target* node, which changes when the event lands on a child
 * overlay (the action highlight, the challenge ring), and would silently shift
 * every click by the overlay's offset.
 */
export function normalizePointer(event: { clientX: number; clientY: number }, element: HTMLElement): { x: number; y: number } | undefined {
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return undefined
  const x = (event.clientX - rect.left) / rect.width
  const y = (event.clientY - rect.top) / rect.height
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined
  return { x: clamp01(x), y: clamp01(y) }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

const BUTTON_MAP: Record<number, 'left' | 'middle' | 'right'> = { 0: 'left', 1: 'middle', 2: 'right' }

export interface LiveViewportProps {
  streamUrl: string | undefined
  /**
   * Single-frame fallback URL from `useStreamSession().pollUrl`. When present
   * it REPLACES streamUrl as the <img> src — this browser cannot render the
   * multipart transport (Android Chrome, Safari).
   */
  pollUrl?: string | undefined
  phase: StreamPhase
  frameSource: FrameSource
  /** True while the user owns the pointer. Input is only forwarded when true. */
  driving: boolean
  scope: 'view' | 'drive'
  /** The element the agent last acted on, drawn as a ring. Normalized 0..1. */
  highlight?: { x: number; y: number; w: number; h: number; label?: string } | null
  /** Where a challenge widget sits, drawn as a pulsing ring. Normalized. */
  challengeBox?: { x: number; y: number; w: number; h: number } | null
  /** Agent gesture state from `useStreamSession().overlay`. */
  overlay?: OverlayState
  gesture?: { seq: number; actor: string; text: string } | null
  onControl(message: ControlMessage): void
  onFrameLoad(): void
  onFirstFrame?(): void
  error: string | null
  placeholder: ReactNode
}

/**
 * The pixels, plus the pointer.
 *
 * Renders a single `<img>` for the multipart stream and an overlay layer for
 * highlights. The overlay is `pointer-events: none` so it can never swallow a
 * click — a highlight box that eats input would make the panel feel broken in a
 * way that is very hard to diagnose.
 */
export function LiveViewport(props: LiveViewportProps): ReactNode {
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const dragging = useRef(false)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  /**
   * Touch gets gesture semantics instead of event replay: taps become clicks
   * and flicks become swipes, collected locally and dispatched on lift.
   * Forwarding raw touch pointer events would produce a mouse-down, a scroll
   * AND a click for one flick.
   */
  const touchPath = useRef<{ points: Array<{ x: number; y: number }>; startedAt: number } | null>(null)

  const canDrive = props.driving && props.scope === 'drive'

  const emit = useCallback(
    (message: ControlMessage) => {
      if (!canDrive) return
      props.onControl(message)
    },
    [canDrive, props],
  )

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!canDrive) return
      const surface = surfaceRef.current
      if (!surface) return
      const point = normalizePointer(event, surface)
      if (!point) return
      // Capture so a drag leaving the frame still delivers moves here.
      surface.setPointerCapture?.(event.pointerId)
      if (event.pointerType === 'touch') {
        touchPath.current = { points: [point], startedAt: Date.now() }
        return
      }
      dragging.current = true
      setCursor(point)
      emit({ kind: 'pointer-down', x: point.x, y: point.y, button: BUTTON_MAP[event.button] ?? 'left' })
    },
    [canDrive, emit],
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!canDrive) return
      const surface = surfaceRef.current
      if (!surface) return
      const point = normalizePointer(event, surface)
      if (!point) return
      setCursor(point)
      if (event.pointerType === 'touch') {
        const path = touchPath.current
        if (path) {
          const last = path.points[path.points.length - 1]
          // Sample sparsely: the host caps the path anyway, and 1% of the frame
          // is below what a flick needs to be recognizable.
          if (!last || Math.hypot(point.x - last.x, point.y - last.y) > 0.01) path.points.push(point)
        }
        return
      }
      // Only forward moves during a drag. Streaming every hover move would
      // flood the control route for input the browser does not need.
      if (dragging.current) emit({ kind: 'pointer-move', x: point.x, y: point.y })
    },
    [canDrive, emit],
  )

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!canDrive) return
      const surface = surfaceRef.current
      if (!surface) return
      const point = normalizePointer(event, surface)
      dragging.current = false
      surface.releasePointerCapture?.(event.pointerId)

      if (event.pointerType === 'touch') {
        const path = touchPath.current
        touchPath.current = null
        if (!path || path.points.length === 0) return
        const start = path.points[0]!
        const end = path.points[path.points.length - 1]!
        const distance = Math.hypot(end.x - start.x, end.y - start.y)
        const duration = Date.now() - path.startedAt
        if (path.points.length >= 2 && distance > 0.06 && duration < 900) {
          // A flick: one swipe message, not a down-move-up storm.
          emit({ kind: 'swipe', points: path.points.slice(0, 96) })
        } else {
          // A tap: a clean click at the lift point.
          emit({ kind: 'pointer-down', x: end.x, y: end.y, button: 'left' })
          emit({ kind: 'pointer-up', x: end.x, y: end.y, button: 'left' })
        }
        return
      }

      if (!point) return
      setCursor(null)
      emit({ kind: 'pointer-up', x: point.x, y: point.y, button: BUTTON_MAP[event.button] ?? 'left' })
    },
    [canDrive, emit],
  )

  const onWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      if (!canDrive) return
      emit({ kind: 'wheel', deltaX: event.deltaX, deltaY: event.deltaY })
    },
    [canDrive, emit],
  )

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!canDrive) return
      // Let the browser handle modifier combos it owns; forward the rest.
      emit({ kind: 'key', key: event.key, code: event.code, ...(event.key.length === 1 ? { text: event.key } : {}) })
    },
    [canDrive, emit],
  )

  const showStream = props.phase === 'live' || props.phase === 'stalled'

  return (
    <div
      ref={surfaceRef}
      style={viewportStyles(canDrive)}
      tabIndex={canDrive ? 0 : -1}
      role="application"
      aria-label={canDrive ? 'live browser — you are driving' : 'live browser — the agent is driving'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
      onKeyDown={onKeyDown}
      onContextMenu={event => {
        // Right-click is forwarded as a button, so suppress the local menu only
        // while driving; otherwise the user keeps their normal browser menu.
        if (canDrive) event.preventDefault()
      }}
    >
      {showStream && (props.pollUrl ?? props.streamUrl) ? (
        <img
          // In poll mode every nonce bump changes the key → the <img> remounts
          // and fetches the latest single frame. In multipart mode the key is
          // stable so the stream stays open.
          key={`${props.pollUrl ?? props.streamUrl}:${props.phase === 'stalled' ? 'stalled' : 'ok'}`}
          src={(props.pollUrl ?? props.streamUrl)!}
          alt="live browser view"
          draggable={false}
          style={imageStyles}
          onLoad={() => {
            props.onFrameLoad()
            props.onFirstFrame?.()
          }}
          onError={() => props.onFrameLoad()}
        />
      ) : (
        props.placeholder
      )}

      {/* Overlay: never interactive, or it would eat clicks meant for the page. */}
      <div style={overlayStyles}>
        {props.overlay ? <InteractionOverlay state={props.overlay} hideAgentPointer={canDrive} /> : null}
        {props.gesture ? (
          <span key={props.gesture.seq} style={gestureChipStyles} data-gesture-chip={props.gesture.actor}>
            {props.gesture.actor === 'user' ? 'you · ' : ''}{props.gesture.text}
          </span>
        ) : null}
        {props.highlight ? <HighlightBox box={props.highlight} tone="action" /> : null}
        {props.challengeBox ? <HighlightBox box={props.challengeBox} tone="challenge" /> : null}
        {cursor && canDrive ? <span style={cursorDotStyles(cursor)} /> : null}
        {props.phase === 'stalled' ? <div style={stalledStyles}>stream stalled — reconnecting…</div> : null}
        {props.phase === 'error' && props.error ? <div style={errorStyles}>{props.error}</div> : null}
        {!canDrive ? (
          <div style={readBadgeStyles} title="the agent owns the pointer; take over to drive">
            {props.scope === 'drive' ? 'agent driving' : 'view only'}
          </div>
        ) : null}
        {props.frameSource === 'dom' ? <div style={syntheticBadgeStyles}>synthetic frame — no capture</div> : null}
      </div>
    </div>
  )
}

// ── styles ──────────────────────────────────────────────────────────────────

function viewportStyles(canDrive: boolean): CSSProperties {
  return {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    background: '#0b0b0f',
    cursor: canDrive ? 'default' : 'not-allowed',
    outline: 'none',
    touchAction: 'none',
  }
}

const imageStyles: CSSProperties = {
  // `contain`, not `cover`: cropping a browser viewport would hide the very
  // content the user is trying to inspect, and would desync normalized clicks.
  maxWidth: '100%',
  maxHeight: '100%',
  objectFit: 'contain',
  display: 'block',
  userSelect: 'none',
  pointerEvents: 'none',
}

const gestureChipStyles: CSSProperties = {
  position: 'absolute', left: 10, bottom: 10, zIndex: 5,
  padding: '3px 9px', borderRadius: 999,
  background: 'rgba(1,4,9,0.82)', border: '1px solid rgba(88,166,255,0.4)',
  color: '#a5d6ff', fontSize: 11, lineHeight: '16px',
  backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
  animation: 'dsh-browser-chip 2.6s ease forwards',
  pointerEvents: 'none', whiteSpace: 'nowrap', maxWidth: '70%', overflow: 'hidden', textOverflow: 'ellipsis',
}

const overlayStyles: CSSProperties = {
  position: 'absolute',
  inset: 0,
  pointerEvents: 'none',
}

function cursorDotStyles(point: { x: number; y: number }): CSSProperties {
  return {
    position: 'absolute',
    left: `${point.x * 100}%`,
    top: `${point.y * 100}%`,
    width: 14,
    height: 14,
    marginLeft: -7,
    marginTop: -7,
    borderRadius: '50%',
    border: '2px solid rgba(88,166,255,0.95)',
    background: 'rgba(88,166,255,0.22)',
    boxShadow: '0 0 0 3px rgba(88,166,255,0.14)',
  }
}

function HighlightBox({ box, tone }: { box: { x: number; y: number; w: number; h: number; label?: string }; tone: 'action' | 'challenge' }): ReactNode {
  const color = tone === 'challenge' ? 'rgba(210,153,34,0.95)' : 'rgba(88,166,255,0.9)'
  return (
    <div
      style={{
        position: 'absolute',
        left: `${box.x * 100}%`,
        top: `${box.y * 100}%`,
        width: `${box.w * 100}%`,
        height: `${box.h * 100}%`,
        border: `2px solid ${color}`,
        borderRadius: 4,
        background: tone === 'challenge' ? 'rgba(210,153,34,0.10)' : 'rgba(88,166,255,0.08)',
        boxShadow: `0 0 0 3px ${tone === 'challenge' ? 'rgba(210,153,34,0.16)' : 'rgba(88,166,255,0.12)'}`,
      }}
    >
      {box.label ? (
        <span
          style={{
            position: 'absolute',
            top: -18,
            left: -2,
            padding: '1px 5px',
            fontSize: 10,
            lineHeight: 1.5,
            borderRadius: 4,
            whiteSpace: 'nowrap',
            color: '#0b0b0f',
            background: color,
          }}
        >
          {box.label}
        </span>
      ) : null}
    </div>
  )
}

const stalledStyles: CSSProperties = {
  position: 'absolute',
  left: '50%',
  top: 12,
  transform: 'translateX(-50%)',
  padding: '3px 10px',
  borderRadius: 999,
  fontSize: 11,
  background: 'rgba(210,153,34,0.9)',
  color: '#1c1c22',
}

const errorStyles: CSSProperties = {
  position: 'absolute',
  left: 12,
  right: 12,
  bottom: 12,
  padding: '6px 10px',
  borderRadius: 8,
  fontSize: 11,
  lineHeight: 1.45,
  background: 'rgba(248,81,73,0.16)',
  border: '1px solid rgba(248,81,73,0.4)',
  color: '#f85149',
}

const readBadgeStyles: CSSProperties = {
  position: 'absolute',
  right: 8,
  top: 8,
  padding: '2px 8px',
  borderRadius: 999,
  fontSize: 10,
  background: 'rgba(0,0,0,0.55)',
  color: '#d0d0d8',
  border: '1px solid rgba(255,255,255,0.14)',
}

const syntheticBadgeStyles: CSSProperties = {
  position: 'absolute',
  left: 8,
  top: 8,
  padding: '2px 8px',
  borderRadius: 999,
  fontSize: 10,
  background: 'rgba(88,166,255,0.18)',
  color: '#9ecbff',
  border: '1px solid rgba(88,166,255,0.34)',
}

// Re-exported so the panel can mint capture URLs without importing wire.js twice.
export { captureUrl, requestCaptureGrant, sendControl, sendSession }
