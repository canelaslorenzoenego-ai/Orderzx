/**
 * The panel host: the surface that makes the dashboard extend.
 *
 * DSH 0.1.5 has no per-tool details seat to register into, so — exactly like
 * dsh-android and dsh-openpencil — the plugin mounts its own imperative React
 * root on `document.body` and docks it as a fixed right-hand column. The dock
 * lease (panel-dock.ts) pushes the AppFrame's `margin-right` over by the panel
 * width, so the conversation gets narrower and nothing is covered.
 *
 * Store, not props. The capsule and the tool cards both need to open this panel,
 * and neither is a React ancestor of it, so the open state lives in a module
 * store subscribed to with `useSyncExternalStore`. That is also what lets
 * `openIfIdle` be honest: a settling `browser_start` must not replace a panel
 * the user already opened on purpose.
 *
 * Width behaviour, copied from dsh-android because it was already right:
 *   - the left-edge handle drags wider/narrower, double-click resets;
 *   - a landscape frame auto-widens to a comfortable width and restores the
 *     user's portrait width afterwards;
 *   - a manual drag made DURING the landscape stint is never fought.
 * A desktop browser viewport is landscape essentially always, so this matters
 * more here than it did for a phone.
 *
 * @module @dsh-community/dsh-browser/client/panel-host
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { DebugDrawer, SessionTabStrip, TimelineDrawer } from './session-tabs.js'
import { HomeTab } from './home-tab.js'
import type { CSSProperties, ReactNode, PointerEvent as ReactPointerEvent } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { BrowserStatus, ControlMessage, FrameSource } from '../protocol.js'
import { compatMode } from '../compat.js'
import { FRAME_SOURCES } from '../protocol.js'
import {
  claimPanelDock,
  clampPanelWidth,
  desiredPanelWidth,
  dockedSurfaceStyles,
  overlaySurfaceStyles,
  PANEL_DEFAULT_WIDTH,
  PANEL_LEFT_CLEARANCE,
  type PanelDockLease,
} from './panel-dock.js'
import { BrowserFrame, FRAME_STYLE_CHROME, FRAME_STYLE_OPTIONS, type FrameStyle } from './browser-frame.js'
import { LiveViewport, useStreamSession, type StreamSession } from './live-viewport.js'
import { installCapsuleKeyframes } from './status-capsule.js'
import { bootLabel, reducePhase, reduceStatus, resetBoot, shouldAutoOpen, type BootState } from './boot-sequence.js'
import { captureUrl, requestCaptureGrant, sendChallengeOutcome, sendControl, sendSession, type FetchLike } from './wire.js'

// ── store ───────────────────────────────────────────────────────────────────

/** Below this viewport width the panel becomes a full-width sheet. */
export const PANEL_NARROW_PX = 760

export interface PanelRequest {
  /** DSH session (conversation) id, for scoping. */
  sessionId: string
  /** Browser session id from the host. Empty means "the host's active one". */
  browserSession?: string
  /** Why the panel is opening — shown in the header, useful when debugging. */
  origin: 'boot' | 'card' | 'capsule' | 'challenge' | 'manual'
}

type Listener = () => void

export interface PanelStore {
  getSnapshot(): PanelRequest | undefined
  subscribe(listener: Listener): () => void
  open(request: PanelRequest): boolean
  /** Open only if nothing is open, so a settle never replaces a deliberate open. */
  openIfIdle(request: PanelRequest): boolean
  close(): void
  /** True while the panel is open (read by the capsule, which hides itself). */
  isOpen(): boolean
}

export function createPanelStore(): PanelStore {
  let current: PanelRequest | undefined
  const listeners = new Set<Listener>()
  const emit = (): void => {
    for (const listener of [...listeners]) listener()
  }
  return {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    open(request) {
      const same = current?.sessionId === request.sessionId && current?.browserSession === request.browserSession
      if (same && current?.origin === request.origin) return false
      current = request
      emit()
      return true
    },
    openIfIdle(request) {
      if (current !== undefined) return false
      current = request
      emit()
      return true
    },
    close() {
      if (current === undefined) return
      current = undefined
      emit()
    },
    isOpen: () => current !== undefined,
  }
}

/** Process-wide store, shared by the capsule and every registered card. */
export const browserPanelStore = createPanelStore()

/** Hook form, for components that render against the store. */
export function usePanelRequest(): PanelRequest | undefined {
  return useSyncExternalStore(
    useCallback(listener => browserPanelStore.subscribe(listener), []),
    browserPanelStore.getSnapshot,
    browserPanelStore.getSnapshot,
  )
}

// ── host ────────────────────────────────────────────────────────────────────

export interface PanelHost {
  open(request: PanelRequest): boolean
  openIfIdle(request: PanelRequest): boolean
  close(): void
  dispose(): void
}

export interface PanelHostOptions {
  document?: Document
  fetcher?: FetchLike
  /** Host theme/locale bridges, so the panel matches DSH instead of floating. */
  subscribeTheme?: (listener: () => void) => () => void
  getColorScheme?: () => 'light' | 'dark' | undefined
  subscribeLocale?: (listener: () => void) => () => void
  getLocale?: () => string | undefined
  store?: PanelStore
}

let nextHostId = 0

/**
 * Mount the panel host on `document.body`.
 *
 * Returns an imperative handle. The caller (the client entry) owns its lifetime
 * through `ctx.effect`, so unloading the plugin unmounts the root, removes the
 * container and releases the dock lease — leaving the AppFrame's margin exactly
 * as it was found.
 */
export function mountBrowserPanelHost(options: PanelHostOptions = {}): PanelHost {
  const ownerDocument = options.document ?? (typeof document === 'undefined' ? undefined : document)
  if (!ownerDocument) {
    // Headless/SSR: nothing to mount. Return an inert handle rather than
    // throwing, so the client entry does not need a typeof guard at every call.
    return { open: () => false, openIfIdle: () => false, close() {}, dispose() {} }
  }

  const store = options.store ?? browserPanelStore
  const hostId = `dsh-browser-panel-${(nextHostId += 1)}`
  const container = ownerDocument.createElement('div')
  container.dataset.browserPanelHost = hostId
  ownerDocument.body.append(container)

  // The capsule's keyframes are shared with the panel's own spinners; install
  // once per document rather than once per mount.
  installCapsuleKeyframes(ownerDocument)

  let root: Root | undefined = createRoot(container)
  let destroyed = false

  const destroy = (): void => {
    if (destroyed) return
    destroyed = true
    // Drop the request so a remount after a plugin reload starts closed.
    store.close()
    root?.unmount()
    root = undefined
    container.remove()
  }

  root.render(
    <PanelHostView
      store={store}
      fetcher={options.fetcher}
      subscribeTheme={options.subscribeTheme}
      getColorScheme={options.getColorScheme}
      subscribeLocale={options.subscribeLocale}
      getLocale={options.getLocale}
    />,
  )

  return {
    open(request) {
      if (destroyed) return false
      return store.open(request)
    },
    openIfIdle(request) {
      if (destroyed) return false
      return store.openIfIdle(request)
    },
    close() {
      if (!destroyed) store.close()
    },
    dispose() {
      destroy()
    },
  }
}

// ── the view ────────────────────────────────────────────────────────────────

interface PanelHostViewProps extends PanelHostOptions {
  store: PanelStore
}

function PanelHostView(props: PanelHostViewProps): ReactNode {
  const request = useSyncExternalStore(
    useCallback(listener => props.store.subscribe(listener), [props.store]),
    props.store.getSnapshot,
    props.store.getSnapshot,
  )
  // A stable colorScheme subscription keeps the panel from flashing on theme change.
  const [scheme, setScheme] = useState<'light' | 'dark' | undefined>(() => props.getColorScheme?.())
  useEffect(() => {
    if (!props.subscribeTheme) return
    return props.subscribeTheme(() => setScheme(props.getColorScheme?.()))
  }, [props.subscribeTheme, props.getColorScheme])

  if (!request) return null
  return <BrowserPanel request={request} store={props.store} fetcher={props.fetcher} scheme={scheme} />
}

// ── the panel ───────────────────────────────────────────────────────────────

interface BrowserPanelProps {
  request: PanelRequest
  store: PanelStore
  fetcher?: FetchLike
  scheme?: 'light' | 'dark'
}

function BrowserPanel(props: BrowserPanelProps): ReactNode {
  const { request, store } = props
  const fetcher = props.fetcher ?? (fetch as unknown as FetchLike)

  /**
   * Which browser the panel is showing: `auto` follows the host's active
   * session (and the card's `browserSession` when opened from a tool call),
   * `home` is the start page, `session` is an explicit custom-tab pick.
   */
  const [view, setView] = useState<{ kind: 'auto' } | { kind: 'home' } | { kind: 'session'; id: string }>({ kind: 'auto' })
  const [timelineOpen, setTimelineOpen] = useState(false)
  const [debugOpen, setDebugOpen] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [narrow, setNarrow] = useState(false)

  const bootStatusRef = useRef<BrowserStatus | undefined>(undefined)
  const autoSession = request.browserSession ?? bootStatusRef.current?.session?.id
  const effectiveSession = view.kind === 'session' ? view.id : view.kind === 'home' ? autoSession : autoSession
  const showingHome =
    view.kind === 'home'
    || (view.kind === 'auto' && !request.browserSession && !bootStatusRef.current?.session && (bootStatusRef.current?.sessions?.length ?? 0) === 0)

  const session: StreamSession = useStreamSession({
    fetcher,
    ...(effectiveSession ? { session: effectiveSession } : {}),
    active: true,
    stallDetection: !showingHome,
  })
  bootStatusRef.current = session.status

  // Mount off-screen and slide in: the first paint carries extending:true, a
  // rAF clears it, and the 180ms transform transition does the rest. This is
  // the "dashboard extends" half of the capsule-pop → extend sequence.
  const [boot, setBoot] = useState<BootState>(() => ({ ...resetBoot(), extending: true }))
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      setBoot(previous => (previous.extending ? { ...previous, extending: false } : previous))
    })
    return () => cancelAnimationFrame(raf)
  }, [])
  const [width, setWidth] = useState<number>(PANEL_DEFAULT_WIDTH)
  const [dragged, setDragged] = useState(false)
  const [frameStyle, setFrameStyle] = useState<FrameStyle>(FRAME_STYLE_CHROME)
  const [addressDraft, setAddressDraft] = useState('')
  const [overlay, setOverlay] = useState(false)
  const leaseRef = useRef<PanelDockLease | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  const status: BrowserStatus | undefined = session.status
  // fps sparkline: a 24-poll ring of frame rates. Pushed in an effect, read at
  // render — status polls re-render anyway, so the line breathes with the stream.
  const fpsRing = useRef<number[]>([])
  useEffect(() => {
    const fps = status?.frames?.fps
    if (typeof fps === 'number' && fps > 0) fpsRing.current = [...fpsRing.current, fps].slice(-24)
  }, [status?.frames?.fps])

  // Fold every status poll into the boot machine. This is what drives the
  // capsule→extend→live staging and the challenge/ownership banners.
  useEffect(() => {
    if (!status) return
    setBoot(previous => {
      const next = reduceStatus(previous, status)
      return next
    })
  }, [status])

  // Auto-open discipline lives in the caller (openIfIdle); here we only react to
  // a challenge by bringing the panel forward, because that is the moment the
  // user is needed and a hidden panel is useless.
  useEffect(() => {
    // Only a BLOCKING challenge justifies yanking focus. A non-blocking one is
    // worth a badge, not an interruption.
    if (!boot.challenge?.blocking) return
    if (request.origin === 'challenge') return // already opened for this reason
    store.open({ ...request, origin: 'challenge' })
  }, [boot.challenge, request, store])

  // ── dock lease: this is the "dashboard extends" part ──────────────────────
  const effectiveWidth = desiredPanelWidth(
    status?.session ? { width: status.session.viewport.width, height: status.session.viewport.height } : undefined,
    width,
    dragged,
  )

  useEffect(() => {
    const doc = containerRef.current?.ownerDocument ?? document
    const viewportWidth = doc.defaultView?.innerWidth ?? 1440
    // Not enough room for side-by-side: overlay instead of squeezing the
    // conversation into an unreadable column.
    if (viewportWidth - effectiveWidth < PANEL_LEFT_CLEARANCE) {
      setOverlay(true)
      leaseRef.current?.release()
      leaseRef.current = null
      return
    }
    setOverlay(false)
    const lease = leaseRef.current ?? claimPanelDock(doc, effectiveWidth)
    leaseRef.current = lease
    lease.setMargin(effectiveWidth)
    // Someone else took the margin (another panel plugin): fall back rather than
    // fight them for the same property.
    if (!lease.isValid()) {
      setOverlay(true)
      lease.release()
      leaseRef.current = null
    }
    return () => {
      // Released on unmount and on width change (the effect re-runs and
      // re-claims); the lease restores exactly what it found.
    }
  }, [effectiveWidth])

  // Release the dock when the panel closes or the plugin unloads.
  useEffect(
    () => () => {
      leaseRef.current?.release()
      leaseRef.current = null
    },
    [],
  )

  // ── phone layout ───────────────────────────────────────────────────────────
  // Under PANEL_NARROW_PX the panel is a full-width sheet: no side-by-side dock
  // (there is no room), no resize handle (there is nothing to resize into), and
  // the controls grow to a thumb-reachable size.
  useEffect(() => {
    const win = containerRef.current?.ownerDocument?.defaultView
    if (!win) return
    const measure = (): void => setNarrow(win.innerWidth < PANEL_NARROW_PX)
    measure()
    win.addEventListener('resize', measure)
    return () => win.removeEventListener('resize', measure)
  }, [])

  // ── input forwarding ──────────────────────────────────────────────────────
  // Both halves are required. `scope === 'drive'` alone is not enough (a stale
  // token from a previous takeover would still say drive), and `owner === 'user'`
  // alone is not enough (the host could have re-assigned the pointer to the agent
  // while our poll was in flight).
  const driving = session.scope === 'drive' && boot.owner === 'user'

  const controlToken = session.controlToken ?? ''

  const onControl = useCallback(
    (message: ControlMessage) => {
      if (!controlToken) return
      // The control token is minted at grant time and its `scope` decides whether
      // the host accepts input at all. A `view` token 403s here, which is correct:
      // it means the takeover did not actually take.
      void sendControl(fetcher, controlToken, message)
    },
    [fetcher, controlToken],
  )

  const toggleTakeover = useCallback(async () => {
    if (driving) {
      await sendSession(fetcher, controlToken, { kind: 'resume' })
      session.refresh()
      return
    }
    // Ask the host to hand over the pointer, THEN re-grant for `drive` scope:
    // the host only issues a drive capability while a takeover is active.
    const began = await sendSession(fetcher, controlToken, { kind: 'takeover' })
    if (began.ok) await session.requestDrive()
  }, [driving, fetcher, session, controlToken])

  const onNav = useCallback(
    (action: 'back' | 'forward' | 'reload' | 'stop') => {
      void sendControl(fetcher, controlToken, { kind: 'nav', action })
    },
    [fetcher, controlToken],
  )

  const onAddress = useCallback(
    (url: string) => {
      const trimmed = url.trim()
      if (!trimmed) return
      // Prefix a bare host so "example.com" does not become a search or an error.
      const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
      void sendControl(fetcher, controlToken, { kind: 'address', url: normalized })
      setAddressDraft('')
    },
    [fetcher, controlToken],
  )

  const onTab = useCallback(
    (action: 'select' | 'close' | 'new', index?: number) => {
      void sendControl(fetcher, controlToken, { kind: 'tab', action, ...(index === undefined ? {} : { index }) })
    },
    [fetcher, controlToken],
  )

  const onCapture = useCallback(async () => {
    // The host reports the path of the capture it most recently wrote; we mint a
    // capability for it rather than reading pixels back out of the <img>, which a
    // cross-origin taint would block anyway.
    const path = status?.frames?.lastCapturePath
    if (!path) return
    const grant = await requestCaptureGrant(fetcher, path)
    if (!grant) return
    // Opened in a new tab: a signed, loopback-fenced URL is viewable by the user
    // but not embeddable from another origin, which is the intended posture.
    window.open(captureUrl(grant.token), '_blank', 'noopener')
  }, [fetcher, status])

  const onFrameSource = useCallback(
    (source: FrameSource) => {
      void sendSession(fetcher, controlToken, { kind: 'frame-source', source })
    },
    [fetcher, controlToken],
  )

  /** Home tab launch: bootstrap (or view) token → start-browser → jump to the stream. */
  const onLaunch = useCallback(
    async (url: string, label: string) => {
      if (!controlToken) return
      setLaunching(true)
      try {
        const normalized = url ? (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`) : ''
        const result = await sendSession(fetcher, controlToken, {
          kind: 'start-browser',
          ...(normalized ? { url: normalized } : {}),
          ...(label ? { label } : {}),
        })
        const started = result.body?.session
        if (result.ok && typeof started === 'string') {
          setView({ kind: 'session', id: started })
          session.refresh()
        }
      } finally {
        setLaunching(false)
      }
    },
    [fetcher, controlToken, session],
  )

  /** Desktop-view toggle: drive scope only (the route enforces the same). */
  const onToggleDesktopView = useCallback(() => {
    if (!controlToken) return
    const enabled = !(status?.session?.desktopView === true)
    void sendSession(fetcher, controlToken, { kind: 'set-desktop-view', enabled }).then(result => {
      if (result.ok) session.refresh()
    })
  }, [fetcher, controlToken, status, session])

  const onToggleDebugTap = useCallback(() => {
    if (!controlToken) return
    const enabled = !(status?.debug?.armed === true)
    void sendSession(fetcher, controlToken, { kind: 'set-debug-tap', enabled }).then(result => {
      if (result.ok) {
        session.refresh()
        if (enabled) setDebugOpen(true)
      }
    })
  }, [fetcher, controlToken, status, session])

  const onToggleRecording = useCallback(() => {
    if (!controlToken) return
    const enabled = !(status?.recording?.active === true)
    void sendSession(fetcher, controlToken, { kind: 'set-recording', enabled }).then(result => {
      if (result.ok) session.refresh()
    })
  }, [fetcher, controlToken, status, session])

  const onTabSelect = useCallback((id: string) => {
    if (id === 'home') setView({ kind: 'home' })
    else setView({ kind: 'session', id })
  }, [])

  // The first real frame is the moment the boot is over. The host's phase can lag
  // a poll behind, and a "connecting" spinner over live pixels reads as broken.
  const onFirstFrame = useCallback(() => {
    setBoot(previous => (previous.hasConnected ? previous : reducePhase(previous, 'streaming')))
  }, [])

  const resolveChallenge = useCallback(
    async (outcome: 'passed' | 'failed' | 'abandoned') => {
      const id = status?.challenge?.id
      if (!id) return
      await sendChallengeOutcome(fetcher, controlToken, id, outcome)
      session.refresh()
    },
    [fetcher, session, status, controlToken],
  )

  // ── drag handle ───────────────────────────────────────────────────────────
  const startResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const startX = event.clientX
    const startWidth = effectiveWidth
    const doc = containerRef.current?.ownerDocument ?? document
    const move = (moveEvent: PointerEvent): void => {
      setDragged(true)
      // Dragging the LEFT edge leftwards makes the panel wider.
      setWidth(clampPanelWidth(startWidth + (startX - moveEvent.clientX)))
    }
    const up = (): void => {
      doc.removeEventListener('pointermove', move)
      doc.removeEventListener('pointerup', up)
    }
    doc.addEventListener('pointermove', move)
    doc.addEventListener('pointerup', up)
  }, [effectiveWidth])

  const tabs = status?.session?.tabs ?? []
  const viewport = status?.session?.viewport

  return (
    <div
      ref={containerRef}
      style={overlay ? overlaySurfaceStyles(effectiveWidth, narrow) : dockedSurfaceStyles(effectiveWidth, boot.extending)}
      data-color-scheme={props.scheme}
      onTransitionEnd={() => setBoot(previous => (previous.extending ? { ...previous, extending: false } : previous))}
    >
      <div style={overlay ? overlayCardStyles(narrow ? '100%' : effectiveWidth) : dockedCardStyles}>
        {!overlay && !narrow ? <div style={resizeHandleStyles} onPointerDown={startResize} onDoubleClick={() => { setWidth(PANEL_DEFAULT_WIDTH); setDragged(false) }} role="separator" aria-orientation="vertical" title="drag to resize · double-click to reset" /> : null}

        <SessionTabStrip
          sessions={status?.sessions ?? []}
          selected={showingHome ? 'home' : (effectiveSession ?? 'home')}
          onSelect={onTabSelect}
          // View-only panels get no ×: stop-browser is drive-scoped, and a
          // close button that silently 403s is worse than no close button.
          onClose={session.scope === 'drive' ? sessionId => {
            // Close the WHOLE browser for that session's tab: the strip's tabs
            // are sessions, not pages. Index 0 of its own page list.
            void sendSession(fetcher, controlToken, { kind: 'stop-browser', id: sessionId }).catch(() => undefined)
          } : undefined}
          narrow={narrow}
        />

        {compatMode(status?.compat) === 'compat' ? (
          <div style={compatBannerStyles} data-compat-banner>
            newer harness protocol (v{String(status?.compat?.protocol)}) — panel in compatibility mode: core views stay live, brand-new harness features may not appear here until the plugin updates
          </div>
        ) : null}
        <header style={headerStyles}>
          <div style={{ minWidth: 0, flex: '1 1 auto' }}>
            <div style={headerTitleStyles}>{status?.session?.label ? `Live browser · ${status.session.label}` : 'Live browser'}</div>
            <div style={headerSubStyles}>
              {bootLabel(boot)}{status?.session?.desktopView ? ' · desktop view' : ''}
              {status?.recording?.active ? <span style={recChipStyles} title={`recording workflow “${status.recording.name ?? ''}” — gestures are being captured as replayable steps`}>● REC {status.recording.steps}</span> : null}
              {(status?.jobs ?? []).some(job => job.status === 'running')
                ? (() => {
                    const running = (status?.jobs ?? []).find(job => job.status === 'running')!
                    return <span style={jobChipStyles} title={`background job ${running.id} replaying workflow “${running.name}”`}>⚙ {running.name} {running.stepsDone}/{running.stepsTotal}</span>
                  })()
                : null}
            </div>
          </div>
          {fpsRing.current.length > 1 ? (
            <svg
              width="46"
              height="16"
              viewBox="0 0 46 16"
              role="img"
              aria-label={`frames per second over the last ${fpsRing.current.length} polls`}
              style={sparkStyles}
            >
              <title>{`fps ${fpsRing.current[fpsRing.current.length - 1]}`}</title>
              <polyline
                points={fpsRing.current.map((value, index) => `${1 + (index / 23) * 44},${(15 - Math.min(1, value / 30) * 13).toFixed(1)}`).join(' ')}
                fill="none"
                stroke="#3fb950"
                strokeWidth="1.2"
                strokeLinejoin="round"
                strokeLinecap="round"
                opacity="0.9"
              />
            </svg>
          ) : null}
          <select
            style={selectStyles}
            value={status?.frames?.source ?? 'screenshot'}
            aria-label="frame transport"
            title="frame transport — screencast is faster but holds a persistent CDP session, which is the tell stealth drivers remove"
            onChange={event => onFrameSource(event.target.value as FrameSource)}
          >
            {FRAME_SOURCES.filter(source => source !== 'mirror').map(source => (
              <option key={source} value={source}>
                {source}
              </option>
            ))}
          </select>
          <select style={selectStyles} value={frameStyle} aria-label="frame style" onChange={event => setFrameStyle(event.target.value as FrameStyle)}>
            {FRAME_STYLE_OPTIONS.map(style => (
              <option key={style} value={style}>
                {style}
              </option>
            ))}
          </select>
          <button type="button" style={iconButtonStyles} aria-label="close panel" onClick={() => store.close()}>
            ×
          </button>
        </header>

        <TimelineDrawer entries={status?.recent ?? []} open={timelineOpen} onToggle={() => setTimelineOpen(value => !value)} />
        <DebugDrawer debug={status?.debug} open={debugOpen} onToggle={() => setDebugOpen(value => !value)} />

        <div style={bodyStyles}>
          {showingHome ? (
            <HomeTab
              sessions={status?.sessions ?? []}
              launching={launching}
              onLaunch={(url, label) => void onLaunch(url, label)}
              onOpenSession={id => setView({ kind: 'session', id })}
            />
          ) : (
          <BrowserFrame
            style={frameStyle}
            url={status?.session?.tabs[status.session.activeTab]?.url ?? ''}
            title={tabs[status?.session?.activeTab ?? 0]?.title ?? ''}
            tabs={tabs}
            activeTab={status?.session?.activeTab ?? 0}
            phase={status?.phase ?? boot.phase}
            frameSource={status?.frames?.source ?? 'screenshot'}
            fps={status?.frames?.fps ?? 0}
            driving={driving}
            challenge={status?.challenge && status.challenge.state !== 'resolved' ? { vendor: status.challenge.vendor, blocking: status.challenge.blocking } : null}
            suppression={{ active: status?.stealth?.frameSuppression.active ?? false, reason: status?.stealth?.frameSuppression.reason ?? null }}
            error={status?.error?.message ?? session.error}
            addressDraft={addressDraft}
            onAddressDraftChange={setAddressDraft}
            onNav={onNav}
            onAddress={onAddress}
            onTab={onTab}
            onToggleTakeover={() => void toggleTakeover()}
            onCapture={() => void onCapture()}
          >
            <LiveViewport
              streamUrl={session.streamUrl}
              phase={session.phase}
              frameSource={status?.frames?.source ?? 'screenshot'}
              driving={driving}
              scope={session.scope}
              highlight={null}
              challengeBox={null}
              overlay={session.overlay}
              gesture={session.gesture}
              onControl={onControl}
              onFrameLoad={session.onLoad}
              onFirstFrame={onFirstFrame}
              error={session.error}
              placeholder={<Placeholder phase={session.phase} label={bootLabel(boot)} />}
            />
          </BrowserFrame>
          )}
        </div>

        {status?.challenge && status.challenge.state === 'awaiting-user' ? (
          <div style={handoffStyles}>
            <div style={{ flex: '1 1 auto', minWidth: 0 }}>
              <strong>{status.challenge.vendor}</strong> needs a human. The agent is paused.
            </div>
            <button type="button" style={resolveButtonStyles('#3fb950')} onClick={() => void resolveChallenge('passed')}>
              solved
            </button>
            <button type="button" style={resolveButtonStyles('#d29922')} onClick={() => void resolveChallenge('failed')}>
              failed
            </button>
            <button type="button" style={resolveButtonStyles('#8a8a94')} onClick={() => void resolveChallenge('abandoned')}>
              skip
            </button>
          </div>
        ) : null}

        <footer style={footerStyles}>
          {!showingHome ? (
            <button
              type="button"
              style={driving ? primaryButtonStyles('#d29922') : primaryButtonStyles('#58a6ff')}
              onClick={() => void toggleTakeover()}
              title={driving ? 'hand the pointer back to the agent' : 'take over the mouse and keyboard'}
            >
              {driving ? 'Resume agent' : 'Take over'}
            </button>
          ) : null}
          {!showingHome ? (
            <button
              type="button"
              style={status?.session?.desktopView ? primaryButtonStyles('#a371f7') : secondaryButtonStyles}
              onClick={onToggleDesktopView}
              disabled={!driving}
              title={
                driving
                  ? status?.session?.desktopView
                    ? 'desktop view is ON — the page gets a desktop UA and a 1366×768 viewport'
                    : 'ask the site for its desktop layout (desktop UA + wide viewport)'
                  : 'take over first — changing the fingerprint is a drive-class action'
              }
            >
              {status?.session?.desktopView ? 'Desktop ✓' : 'Desktop view'}
            </button>
          ) : null}
          {!showingHome ? (
            <button
              type="button"
              style={status?.debug?.armed ? primaryButtonStyles('#d29922') : secondaryButtonStyles}
              onClick={onToggleDebugTap}
              title={
                status?.debug?.armed
                  ? 'console + network tap is ARMED — extra listeners are attached (a posture gap); press to disarm and wipe the buffers'
                  : 'arm the console + network tap for the debug drawer — opt-in: it attaches extra listeners while armed'
              }
            >
              {status?.debug?.armed ? 'Debug tap ✓' : 'Debug tap'}
            </button>
          ) : null}
          {!showingHome ? (
            <button
              type="button"
              style={status?.recording?.active ? primaryButtonStyles('#f85149') : secondaryButtonStyles}
              onClick={onToggleRecording}
              disabled={!driving && !status?.recording?.active}
              title={
                status?.recording?.active
                  ? 'stop recording and save the workflow (typed secrets become {{variables}} — never stored)'
                  : driving
                    ? 'record your gestures as a replayable workflow — demonstrate, then stop and name it'
                    : 'take over first — a workflow records HUMAN gestures'
              }
            >
              {status?.recording?.active ? '● Stop & save' : 'Record'}
            </button>
          ) : null}
          <span style={footerNoteStyles}>
            {showingHome
              ? `${(status?.sessions?.length ?? 0) > 0 ? `${status!.sessions!.length} browser live` : 'no browsers yet — launch one or let the agent do it'}`
              : driving
                ? 'You own the pointer. Agent tools return “pointer-owned” until you resume.'
                : viewport
                  ? `${viewport.width}×${viewport.height} · ${status?.session?.provider ?? ''} · ${status?.stealth?.humanize ? 'humanized' : 'raw input'}`
                  : 'waiting for the browser…'}
          </span>
        </footer>
      </div>
    </div>
  )
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * The control token for this session.
 *
 * `useStreamSession` holds both tokens; the stream URL embeds the stream one, so
 * the control one is recovered from the same hook rather than re-granted. A
 * second grant per click would mint a new capability on every interaction.
 */



function Placeholder({ phase, label }: { phase: string; label: string }): ReactNode {
  return (
    <div style={placeholderStyles}>
      <div style={spinnerStyles} />
      <div style={{ fontSize: 12, opacity: 0.82 }}>{label}</div>
      <div style={{ fontSize: 10.5, opacity: 0.5 }}>{phase}</div>
    </div>
  )
}

// ── styles ──────────────────────────────────────────────────────────────────

const dockedCardStyles: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  background: 'var(--dsw-bg-primary, #101014)',
  borderLeft: '1px solid var(--dsw-border-color, rgba(128,128,128,0.24))',
}

function overlayCardStyles(width: number | '100%'): CSSProperties {
  if (width === '100%') {
    // Phone sheet: edge-to-edge, full height, no floating-card affordances.
    // dvh so a mobile browser's collapsing URL bar cannot crop the footer.
    return {
      width: '100%',
      maxWidth: '100vw',
      height: '100dvh',
      display: 'flex',
      flexDirection: 'column',
      minHeight: 0,
      borderRadius: 0,
      overflow: 'hidden',
      background: 'var(--dsw-bg-primary, #101014)',
      border: 'none',
      boxShadow: 'none',
      color: 'var(--dsw-text-primary, rgba(255,255,255,0.92))',
      font: 'inherit',
    }
  }
  return {
    width: `${Math.min(width, 940)}px`,
    maxWidth: '94vw',
    height: '86vh',
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    borderRadius: 12,
    overflow: 'hidden',
    background: 'var(--dsw-bg-primary, #101014)',
    border: '1px solid var(--dsw-border-color, rgba(128,128,128,0.24))',
    boxShadow: '0 24px 80px rgba(0,0,0,0.5)',
  }
}

const resizeHandleStyles: CSSProperties = {
  position: 'absolute',
  left: 0,
  top: 0,
  bottom: 0,
  width: 5,
  cursor: 'col-resize',
  zIndex: 2,
  background: 'transparent',
}

const compatBannerStyles: CSSProperties = {
  margin: '8px 12px 0', padding: '6px 12px', borderRadius: 8,
  background: 'rgba(210,153,34,0.12)', border: '1px solid rgba(210,153,34,0.45)',
  color: '#e3b341', fontSize: 11, lineHeight: '16px',
}

const headerStyles: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '8px 10px',
  flex: '0 0 auto',
  borderBottom: '1px solid var(--dsw-border-color, rgba(128,128,128,0.2))',
  background: 'var(--dsw-bg-secondary, #16161a)',
}

const headerTitleStyles: CSSProperties = {
  fontSize: 12.5,
  fontWeight: 600,
  color: 'var(--dsw-text-primary, #e6e6ea)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const headerSubStyles: CSSProperties = {
  fontSize: 10.5,
  color: 'var(--dsw-text-tertiary, #8a8a94)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  marginTop: 1,
}

const selectStyles: CSSProperties = {
  flex: '0 0 auto',
  fontSize: 10.5,
  padding: '2px 4px',
  borderRadius: 6,
  border: '1px solid var(--dsw-border-color, rgba(128,128,128,0.24))',
  background: 'var(--dsw-bg-tertiary, #20202a)',
  color: 'var(--dsw-text-secondary, #b8b8c2)',
  cursor: 'pointer',
}

const iconButtonStyles: CSSProperties = {
  flex: '0 0 auto',
  width: 24,
  height: 24,
  borderRadius: 6,
  border: '1px solid transparent',
  background: 'transparent',
  color: 'var(--dsw-text-secondary, #b8b8c2)',
  cursor: 'pointer',
  fontSize: 16,
  lineHeight: 1,
}

const bodyStyles: CSSProperties = {
  flex: '1 1 auto',
  minHeight: 0,
  padding: 10,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
}

const handoffStyles: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '8px 10px',
  fontSize: 11,
  flex: '0 0 auto',
  background: 'rgba(210,153,34,0.14)',
  borderTop: '1px solid rgba(210,153,34,0.3)',
  color: '#d29922',
}

function resolveButtonStyles(color: string): CSSProperties {
  return {
    flex: '0 0 auto',
    padding: '3px 9px',
    fontSize: 10.5,
    borderRadius: 6,
    cursor: 'pointer',
    border: `1px solid ${color}`,
    background: 'transparent',
    color,
  }
}

const footerStyles: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 10px',
  flex: '0 0 auto',
  borderTop: '1px solid var(--dsw-border-color, rgba(128,128,128,0.2))',
  background: 'var(--dsw-bg-secondary, #16161a)',
}

const secondaryButtonStyles: CSSProperties = {
  minHeight: 30,
  padding: '0 10px',
  fontSize: 11.5,
  fontWeight: 600,
  borderRadius: 8,
  border: '1px solid var(--dsw-border-color, rgba(128,128,128,0.3))',
  background: 'transparent',
  color: 'var(--dsw-text-secondary, rgba(255,255,255,0.7))',
  cursor: 'pointer',
}

function primaryButtonStyles(color: string): CSSProperties {
  return {
    flex: '0 0 auto',
    padding: '5px 12px',
    fontSize: 11.5,
    fontWeight: 600,
    borderRadius: 7,
    cursor: 'pointer',
    border: `1px solid ${color}`,
    background: `${color}22`,
    color,
  }
}

const jobChipStyles: CSSProperties = {
  color: '#67e8f9',
  fontWeight: 600,
  letterSpacing: '0.04em',
}

const sparkStyles: CSSProperties = {
  flex: '0 0 auto',
  alignSelf: 'center',
}

const recChipStyles: CSSProperties = {
  color: '#f85149',
  fontWeight: 600,
  letterSpacing: '0.04em',
}

const footerNoteStyles: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  fontSize: 10.5,
  lineHeight: 1.4,
  color: 'var(--dsw-text-tertiary, #8a8a94)',
}

const placeholderStyles: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  width: '100%',
  height: '100%',
  color: 'var(--dsw-text-secondary, #b8b8c2)',
}

const spinnerStyles: CSSProperties = {
  width: 22,
  height: 22,
  borderRadius: '50%',
  border: '2px solid rgba(88,166,255,0.24)',
  borderTopColor: '#58a6ff',
  animation: 'dsh-browser-spin 0.9s linear infinite',
}

export { shouldAutoOpen }
