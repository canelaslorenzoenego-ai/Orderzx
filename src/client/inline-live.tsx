/**
 * The side dashboard — the harness-styled browser card that lives BESIDE the
 * chat, never inside it.
 *
 * The user's reference is the DeepSeek Harness device dashboard: a light card
 * with a toolbar (device label · follow toggle · close), control segments
 * (zoom · frame style), an icon row (nav · camera · rotate), the framed live
 * screen, and a "● live" status row. Earlier revisions grew that card inside
 * the message flow; it conflicted with the chat bar, so the card moved to the
 * side (panel-host.tsx):
 *
 *  - **Wide (≥900px):** a leased right-hand column — the app frame is pushed
 *    over by exactly the panel width, so the conversation and its composer bar
 *    are narrowed, never covered.
 *  - **Phone (<900px):** a right-edge drawer that slides over the chat while
 *    open and is fully hidden when closed. The chat bar stays free.
 *
 * The card itself is placement-agnostic: the host renders it with `fill`
 * (frame area flexes to the column height) and hands it its already-polled
 * `session` so exactly one status poll feeds the surface.
 *
 *  - **Harness theme.** Light card chrome (white surfaces, hairline borders,
 *    grey toolbars) exactly like the reference dashboard — the chat around it
 *    keeps whatever theme the harness uses.
 *  - **The whole chrome fits at once.** Zoom segments: fit (default,
 *    `clamp(240px, 46dvh, 460px)` floor when filling), S (300px), M (420px).
 *  - **The model has hands.** The agent's pointer renders as a blue hand with
 *    an "agent" tag (interaction-overlay); clicks squash the hand and ripple;
 *    scrolls draw arrows; typing shows a keyboard badge.
 *  - **Real controls.** Back/forward/reload/stop and camera send real control
 *    messages on the session's control token (same path the panel uses);
 *    frame style + zoom are client-side; drive-class controls live in the full
 *    panel, reached with ⤢.
 *  - **Auto-follow.** While ON (default) the host retracts the side surface
 *    after INLINE-equivalent idleness (shouldRetractPanel); OFF pins it open.
 *
 * @module @dsh-community/dsh-browser/client/inline-live
 */

import { useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { BrowserStatus, ControlMessage, SessionSummary } from '../protocol.js'
import { STREAMING_PHASES } from '../protocol.js'
import { BrowserFrame, FRAME_STYLE_OPTIONS, NavIcon, type FrameStyle } from './browser-frame.js'
import { bootLabel, reduceStatus, resetBoot, type BootState } from './boot-sequence.js'
import { LiveViewport, useStreamSession, type StreamSession } from './live-viewport.js'
import { captureUrl, requestCaptureGrant, sendChallengeOutcome, sendControl, type FetchLike } from './wire.js'
import { useEffect } from 'react'

// ── pure helpers ────────────────────────────────────────────────────────────

/** Dashboard zoom levels — the reference's fit/100%/S/M row, minus the absurd. */
export type DashboardZoom = 'fit' | 'S' | 'M'
export const DASHBOARD_ZOOMS: readonly DashboardZoom[] = ['fit', 'S', 'M']

/**
 * Pure: the frame-box height (or min-height when filling) for a zoom level.
 * Fit = whole chrome, one screen.
 */
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

// ── the side dashboard card ─────────────────────────────────────────────────

export interface InlineLiveFrameProps {
  /** The conversation/session id the card belongs to. */
  sessionId: string
  /** The browser session key, when known (host passes status-derived id). */
  browserSession?: string
  fetcher?: FetchLike
  /**
   * Host-provided stream session. The side host already polls status for its
   * own logic; handing the same session down keeps exactly ONE poll per
   * surface. Omitted → the card polls for itself (standalone use).
   */
  session?: StreamSession
  /** Fill the parent column: the frame area flexes instead of fixed height. */
  fill?: boolean
  /** Auto-follow state, owned by the host (pins the surface open when off). */
  follow: boolean
  onFollowChange(on: boolean): void
  /** Opens the full panel (takeover, desktop view, drawers live there). */
  onOpenPanel?(): void
  /** Shows the all-browsers grid (present when several sessions are live). */
  onOpenGrid?(): void
  /** Closes the side surface (dock lease released / drawer slides away). */
  onRequestClose?(): void
}

export function InlineLiveFrame(props: InlineLiveFrameProps): ReactNode {
  if (props.session) return <DashboardCard {...props} session={props.session} />
  return <SelfPollingCard {...props} />
}

/** Polls its own stream session, then renders the card. */
function SelfPollingCard(props: InlineLiveFrameProps): ReactNode {
  const session = useStreamSession({
    ...(props.fetcher ? { fetcher: props.fetcher } : {}),
    session: props.sessionId || undefined,
    active: true,
    stallDetection: true,
  })
  return <DashboardCard {...props} session={session} />
}

function DashboardCard(props: InlineLiveFrameProps & { session: StreamSession }): ReactNode {
  const { session } = props
  const status = session.status
  const [boot, setBoot] = useState<BootState>(() => resetBoot())
  const [zoom, setZoom] = useState<DashboardZoom>('fit')
  const [frameStyle, setFrameStyle] = useState<FrameStyle>('chrome')

  useEffect(() => {
    if (!status) return
    setBoot(previous => reduceStatus(previous, status))
  }, [status])

  const tabs = useMemo(() => {
    const list = status?.session?.tabs ?? []
    const active = status?.session?.activeTab ?? 0
    return list.map((tab, index) => ({ index, title: tab.title ?? '', url: tab.url ?? '', active: index === active }))
  }, [status?.session?.tabs, status?.session?.activeTab])

  const [addressDraft, setAddressDraft] = useState('')
  const fps = status?.frames?.fps ?? 0
  // fps sparkline: same 24-poll ring the full panel draws, shrunk to the header.
  const fpsRing = useRef<number[]>([])
  useEffect(() => {
    const value = status?.frames?.fps
    if (typeof value === 'number' && value > 0) fpsRing.current = [...fpsRing.current, value].slice(-24)
  }, [status?.frames?.fps])
  const lastAction = status?.recent?.[status.recent.length - 1]
  const streaming = (STREAMING_PHASES as readonly string[]).includes(status?.phase ?? 'idle')
  const activeUrl = tabs[status?.session?.activeTab ?? 0]?.url ?? ''
  const controlToken = session.controlToken
  const canControl = controlToken !== undefined
  const canCapture = canControl && (status?.frames?.lastCapturePath ?? null) !== null

  const nav = (action: 'back' | 'forward' | 'reload' | 'stop'): void => {
    control({ kind: 'nav', action })
  }

  /** One signed-control path for everything the dash drives itself. */
  const control = (msg: ControlMessage): void => {
    if (!controlToken) return
    void sendControl(props.fetcher ?? (fetch as unknown as FetchLike), controlToken, msg).catch(() => undefined)
  }

  const address = (url: string): void => {
    control({ kind: 'address', url })
    setAddressDraft('')
  }

  const tab = (action: 'select' | 'close' | 'new', index?: number): void => {
    control({ kind: 'tab', action, ...(index !== undefined ? { index } : {}) })
  }

  const resolveChallenge = (outcome: 'passed' | 'failed' | 'abandoned'): void => {
    const id = status?.challenge?.id
    if (!id || !controlToken) return
    void sendChallengeOutcome(props.fetcher ?? (fetch as unknown as FetchLike), controlToken, id, outcome)
      .then(() => session.refresh())
      .catch(() => undefined)
  }

  const capture = (): void => {
    const path = status?.frames?.lastCapturePath
    if (!path || !controlToken) return
    void (async () => {
      const grant = await requestCaptureGrant(props.fetcher ?? (fetch as unknown as FetchLike), path)
      if (grant) window.open(captureUrl(grant.token), '_blank', 'noopener')
    })()
  }

  const frameBoxStyles: CSSProperties = props.fill
    ? { flex: '1 1 auto', minHeight: dashboardZoomHeight(zoom), display: 'flex', flexDirection: 'column' }
    : { height: dashboardZoomHeight(zoom), display: 'flex', flexDirection: 'column', minHeight: 0 }

  return (
    <div style={props.fill ? dashCardFillStyles : dashCardStyles} data-dsh-side-dash={streaming ? 'live' : 'idle'}>
      {/* ── header row: label · auto-follow · panel · close ── */}
      <div style={dashHeaderStyles}>
        <span style={dashTitleButtonStyles}>
          <span style={dashDotStyles(streaming)} aria-hidden="true" />
          <span style={dashTitleStyles}>Live browser</span>
        </span>
        {fpsRing.current.length > 1 ? (
          <svg
            width="40"
            height="14"
            viewBox="0 0 40 14"
            role="img"
            aria-label={`frames per second over the last ${fpsRing.current.length} polls`}
            style={{ flex: '0 0 auto' }}
          >
            <title>{`fps ${fpsRing.current[fpsRing.current.length - 1]}`}</title>
            <polyline
              points={fpsRing.current.map((value, index) => `${1 + (index / 23) * 38},${(13 - Math.min(1, value / 30) * 11).toFixed(1)}`).join(' ')}
              fill="none"
              stroke="#22a06b"
              strokeWidth="1.2"
              strokeLinejoin="round"
              strokeLinecap="round"
              opacity="0.9"
            />
          </svg>
        ) : null}
        <button
          type="button"
          style={followChipStyles(props.follow)}
          onClick={() => props.onFollowChange(!props.follow)}
          aria-pressed={props.follow}
          title={props.follow
            ? 'auto-follow ON: the side view folds away when the model stops searching'
            : 'auto-follow OFF: the side view stays exactly where it is'}
        >
          <span style={followDotStyles(props.follow)} aria-hidden="true" />
          auto-follow
        </button>
        {props.onOpenGrid ? (
          <button type="button" style={iconBtnStyles} onClick={props.onOpenGrid} title="all live browsers — main agent and sub-agents, side by side" aria-label="all live browsers">
            ▦
          </button>
        ) : null}
        {props.onOpenPanel ? (
          <button type="button" style={iconBtnStyles} onClick={props.onOpenPanel} title="open the full panel — takeover, desktop view, timeline, console">
            ⤢
          </button>
        ) : null}
        <button
          type="button"
          style={iconBtnStyles}
          onClick={() => props.onRequestClose?.()}
          aria-label="close the side dashboard"
          title="close — the chat gets the whole window back; the capsule reopens this"
        >
          ×
        </button>
      </div>

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
      <div style={frameBoxStyles}>
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
          onAddress={address}
          onTab={tab}
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

      {/* ── challenge handoff: unblock the agent without opening the panel ── */}
      {status?.challenge && status.challenge.state === 'awaiting-user' ? (
        <div style={handoffRowStyles} data-dash-handoff={status.challenge.blocking === true ? 'blocking' : 'waiting'}>
          <span style={handoffTextStyles}>
            <strong>{status.challenge.vendor}</strong> needs a human — the agent is paused
          </span>
          <button type="button" style={handoffBtnStyles('#3fb950')} onClick={() => resolveChallenge('passed')}>solved</button>
          <button type="button" style={handoffBtnStyles('#d29922')} onClick={() => resolveChallenge('failed')}>failed</button>
          <button type="button" style={handoffBtnStyles('#8a8a94')} onClick={() => resolveChallenge('abandoned')}>skip</button>
        </div>
      ) : null}

      {/* ── status row: the reference's "● live" ── */}
      <div style={dashStatusStyles}>
        <span style={statusDotStyles(streaming)} aria-hidden="true" />
        <span style={statusLabelStyles}>{streaming ? 'live' : bootLabel(boot)}</span>
        {streaming ? <span style={statusMetaStyles}>{fps} fps · {status?.frames?.source ?? 'screenshot'}</span> : null}
        <span style={statusMetaStyles}>{status?.takeover ? 'you are driving' : 'agent driving'}</span>
        {lastAction ? (
          <span style={lastActionStyles} data-dash-last-action title={lastAction.summary}>
            {lastAction.summary.length > 26 ? `${lastAction.summary.slice(0, 26)}…` : lastAction.summary}
          </span>
        ) : null}
        {status?.recording?.active ? <span style={recChipStyles}>● REC {status.recording.steps}</span> : null}
      </div>
    </div>
  )
}

// ── all-browsers grid: main agent + every sub-agent, at once ────────────────

export interface SessionGridProps {
  sessions: SessionSummary[]
  /** 2 columns on the wide dock, 1 on the phone split. */
  cols: number
  onFocus(id: string): void
}

/**
 * Every live browser at once. Sub-agents each get their own session
 * (browser_start with a label); the side dashboard shows them ALL as tiles —
 * one poll per tile, hands and all — instead of making you flip tabs.
 */
export function SessionGrid(props: SessionGridProps): ReactNode {
  return (
    <div style={gridWrapStyles}>
      <div style={gridHeaderStyles}>
        {props.sessions.length} live browsers — tap one to focus
      </div>
      <div
        style={{ ...gridStyles, gridTemplateColumns: `repeat(${props.cols}, minmax(0, 1fr))` }}
        data-dash-grid={props.sessions.length}
      >
        {props.sessions.map(entry => (
          <SessionTile key={entry.id} entry={entry} onFocus={props.onFocus} />
        ))}
      </div>
    </div>
  )
}

export function SessionTile(props: { entry: SessionSummary; onFocus(id: string): void }): ReactNode {
  const { entry } = props
  const session = useStreamSession({ session: entry.id, active: true, stallDetection: false })
  const status = session.status
  const streaming = (STREAMING_PHASES as readonly string[]).includes(status?.phase ?? entry.phase ?? 'idle')
  const fps = status?.frames?.fps ?? 0
  const active = status?.session?.tabs?.[status?.session?.activeTab ?? 0]

  return (
    <button
      type="button"
      style={tileStyles}
      onClick={() => props.onFocus(entry.id)}
      data-dash-tile={entry.id}
      aria-label={`focus browser ${entry.label ?? entry.id.slice(0, 6)}`}
      title={`${entry.label ?? entry.id.slice(0, 6)} · ${active?.url ?? entry.url}`}
    >
      <span style={tileHeadStyles}>
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            flex: '0 0 auto',
            background: entry.challengeVendor ? '#d29922' : streaming ? '#22a06b' : '#94a3b8',
          }}
          aria-hidden="true"
        />
        <span style={tileLabelStyles}>{entry.label ?? entry.id.slice(0, 6)}</span>
        {entry.desktopView ? <span style={tileMetaStyles}>desktop</span> : null}
        {streaming && fps > 0 ? <span style={tileMetaStyles}>{fps} fps</span> : null}
      </span>
      <span style={tileViewStyles}>
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
          placeholder={<div style={placeholderStyles}>{entry.label ?? entry.id.slice(0, 6)}…</div>}
        />
      </span>
      <span style={tileUrlStyles}>{active?.url ?? entry.url}</span>
    </button>
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

// ── styles: harness-light dashboard card ────────────────────────────────────

const dashCardStyles: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  margin: '8px 0',
  minWidth: 0,
  borderRadius: 16,
  overflow: 'hidden',
  // Frosted glass on the harness's misty canvas — the DeepSeek entry-card
  // treatment (white fill, 1px #e5e7eb border, 16px rounding).
  background: 'var(--dsw-bg-secondary, rgba(255,255,255,0.82))',
  backdropFilter: 'blur(12px) saturate(1.1)',
  WebkitBackdropFilter: 'blur(12px) saturate(1.1)',
  border: '1px solid var(--dsw-border-color, #e5e7eb)',
  boxShadow: '0 6px 24px rgba(15,23,42,0.06)',
  color: 'var(--dsw-text-primary, #000000)',
  font: 'inherit',
  fontFamily: 'var(--dsw-font-family, Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif)',
}

const dashCardFillStyles: CSSProperties = {
  ...dashCardStyles,
  margin: 0,
  height: '100%',
  borderRadius: 0,
  border: 'none',
  boxShadow: 'none',
  background: 'var(--dsw-bg-secondary, rgba(255,255,255,0.92))',
}

const dashHeaderStyles: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 8,
  padding: '8px 10px',
  // The harness canvas mist: cool blue-grey fading to white, top-down.
  background: 'linear-gradient(180deg, rgba(214,219,220,0.35), rgba(255,255,255,0.9))',
  borderBottom: '1px solid var(--dsw-border-color, #e5e7eb)',
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
  color: 'var(--dsw-text-primary, #000000)',
  font: 'inherit',
  fontSize: 13,
  fontWeight: 700,
  textAlign: 'left',
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
  color: 'var(--dsw-text-secondary, #475569)',
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
  background: 'var(--dsw-bg-tertiary, rgba(229,231,235,0.35))',
  borderBottom: '1px solid var(--dsw-border-color, #e5e7eb)',
  flex: '0 0 auto',
}

const segmentedWrapStyles: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 2,
  padding: 2,
  borderRadius: 8,
  background: 'var(--dsw-bg-secondary, rgba(255,255,255,0.85))',
  border: '1px solid var(--dsw-border-color, #e5e7eb)',
}

const segmentedLabelStyles: CSSProperties = {
  fontSize: 10.5,
  color: 'var(--dsw-text-tertiary, #94a3b8)',
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
    // The wordmark blue is the ONLY accent — tinted, never a solid fill.
    color: active ? 'var(--dsw-text-primary, #4d6bfe)' : 'var(--dsw-text-secondary, #475569)',
    background: active ? 'rgba(77, 107, 254, 0.10)' : 'transparent',
    fontWeight: active ? 600 : 400,
  }
}

const dashNavStyles: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 4,
  padding: '5px 8px',
  background: 'var(--dsw-bg-secondary, rgba(255,255,255,0.9))',
  borderBottom: '1px solid var(--dsw-border-color, #e5e7eb)',
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
    color: 'var(--dsw-text-secondary, #475569)',
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
  flexWrap: 'wrap',
  gap: 8,
  padding: '6px 12px',
  background: 'var(--dsw-bg-secondary, rgba(255,255,255,0.9))',
  borderTop: '1px solid var(--dsw-border-color, #e5e7eb)',
  fontSize: 11,
  flex: '0 0 auto',
}

function statusDotStyles(streaming: boolean): CSSProperties {
  return { width: 7, height: 7, borderRadius: '50%', background: streaming ? '#22a06b' : 'var(--dsw-text-tertiary, #6b7280)' }
}

const statusLabelStyles: CSSProperties = {
  color: 'var(--dsw-text-secondary, #475569)',
  fontWeight: 600,
}

const statusMetaStyles: CSSProperties = {
  color: 'var(--dsw-text-tertiary, #94a3b8)',
  fontVariantNumeric: 'tabular-nums',
}

const recChipStyles: CSSProperties = {
  color: '#d0342c',
  fontWeight: 700,
  fontVariantNumeric: 'tabular-nums',
}

const handoffRowStyles: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 6,
  padding: '6px 10px',
  background: 'rgba(210, 153, 34, 0.12)',
  borderTop: '1px solid rgba(210, 153, 34, 0.35)',
  fontSize: 11,
  color: 'var(--dsw-text-primary, #1f2329)',
  flex: '0 0 auto',
}

const handoffTextStyles: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
}

function handoffBtnStyles(color: string): CSSProperties {
  return {
    flex: '0 0 auto',
    padding: '3px 8px',
    borderRadius: 6,
    border: `1px solid ${color}`,
    background: 'transparent',
    color,
    font: 'inherit',
    fontSize: 10.5,
    fontWeight: 600,
    cursor: 'pointer',
  }
}

const gridWrapStyles: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  flex: '1 1 auto',
  gap: 8,
  padding: 8,
  overflowY: 'auto',
  background: 'linear-gradient(180deg, rgba(214,219,220,0.30), rgba(255,255,255,0.92))',
}

const gridHeaderStyles: CSSProperties = {
  flex: '0 0 auto',
  fontSize: 11,
  fontWeight: 600,
  color: '#475569',
  padding: '2px 4px',
}

const gridStyles: CSSProperties = {
  display: 'grid',
  gap: 8,
  alignContent: 'start',
}

const tileStyles: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: 6,
  borderRadius: 12,
  border: '1px solid #e5e7eb',
  background: 'rgba(255,255,255,0.85)',
  cursor: 'pointer',
  textAlign: 'left',
  font: 'inherit',
  color: 'inherit',
  minWidth: 0,
}

const tileHeadStyles: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
}

const tileLabelStyles: CSSProperties = {
  flex: '0 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 11.5,
  fontWeight: 600,
  color: '#000000',
}

const tileMetaStyles: CSSProperties = {
  flex: '0 0 auto',
  fontSize: 10,
  color: '#94a3b8',
  fontVariantNumeric: 'tabular-nums',
}

const tileViewStyles: CSSProperties = {
  position: 'relative',
  display: 'block',
  height: 150,
  borderRadius: 8,
  overflow: 'hidden',
  background: '#0b1020',
}

const tileUrlStyles: CSSProperties = {
  display: 'block',
  fontSize: 10,
  color: '#94a3b8',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const lastActionStyles: CSSProperties = {
  flex: '0 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--dsw-text-secondary, #475569)',
  background: 'var(--dsw-bg-tertiary, rgba(229,231,235,0.5))',
  borderRadius: 6,
  padding: '1px 6px',
}
