/**
 * Custom tabs: one per browser session, plus the home tab.
 *
 * These are SESSION tabs (whole browsers, one per sub-agent), deliberately
 * distinct from the PAGE tabs inside `BrowserFrame` (tabs within one browser).
 * The visual language keeps them apart: session tabs sit above the panel header
 * with a phase dot and a label; page tabs live in the frame chrome below it.
 *
 * The strip is always rendered — on first open, with zero sessions, it shows
 * just the home tab, which is the "custom tabs on first open" surface: the
 * panel starts as a browser start page, not a spinner.
 *
 * @module @dsh-community/dsh-browser/client/session-tabs
 */

import { useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { ActionEntry, ClipRef, SessionSummary } from '../protocol.js'

export interface SessionTabStripProps {
  sessions: SessionSummary[]
  /** 'home' or a session id. */
  selected: string
  onSelect(id: string): void
  /** Narrow layout: bigger hit targets, horizontal scroll. */
  narrow?: boolean
  /**
   * Close a session's browser (drive-scoped control message). Omitted = the
   * strip is view-only and renders no close affordances.
   */
  onClose?(id: string): void
}

/**
 * A stable per-origin avatar: hue hashed from the hostname, initial from its
 * first label character. Offline and deterministic — no favicon fetches (a
 * favicon request from the PANEL would be a cross-origin request the page
 * never asked for, and it would leak which sites the agent visits to a
 * third-party favicon cache).
 */
export function originAvatar(url: string | undefined): { hue: number; initial: string; host: string } {
  let host = ''
  try {
    host = new URL(url ?? '').hostname
  } catch {
    host = ''
  }
  if (!host) return { hue: 220, initial: '•', host: '' }
  let hash = 5381
  for (let i = 0; i < host.length; i += 1) hash = ((hash << 5) + hash + host.charCodeAt(i)) | 0
  const hue = Math.abs(hash) % 360
  const initial = (host.replace(/^www\./, '')[0] ?? '•').toUpperCase()
  return { hue, initial, host }
}

export function SessionTabStrip(props: SessionTabStripProps): ReactNode {
  const sessions = props.sessions ?? []
  return (
    <div style={stripStyles} role="tablist" aria-label="browser sessions">
      <button
        type="button"
        role="tab"
        aria-selected={props.selected === 'home'}
        style={tabStyles(props.selected === 'home', props.narrow === true)}
        onClick={() => props.onSelect('home')}
        title="start page — launch a browser or jump into a running one"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M2 7.2 8 2l6 5.2V13a1 1 0 0 1-1 1H9V9.5H7V14H3a1 1 0 0 1-1-1z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        </svg>
        <span>Home</span>
      </button>
      {sessions.map(entry => {
        const selected = props.selected === entry.id
        const avatar = originAvatar(entry.url)
        const live = entry.phase === 'streaming' || entry.phase === 'navigating' || entry.phase === 'ready'
        // A div with role=tab, not a button: a tab that contains a close
        // affordance cannot be a <button> (no interactive content inside a
        // button), and the close tap must not select the tab.
        return (
          <div
            key={entry.id}
            role="tab"
            tabIndex={0}
            aria-selected={selected}
            style={tabStyles(selected, props.narrow === true)}
            onClick={() => props.onSelect(entry.id)}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                props.onSelect(entry.id)
              }
            }}
            title={`${entry.label ?? entry.id} · ${avatar.host || entry.url || entry.phase}${entry.desktopView ? ' · desktop view' : ''}${entry.challengeVendor ? ` · ${entry.challengeVendor} challenge` : ''}`}
          >
            <span style={avatarStyles(avatar.hue)} aria-hidden="true">{avatar.initial}</span>
            <span style={dotStyles(entry, live)} aria-hidden="true" />
            <span style={tabLabelStyles}>{entry.label ?? entry.id.slice(0, 6)}</span>
            {entry.desktopView ? (
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-label="desktop view" style={{ flex: '0 0 auto', opacity: 0.75 }}>
                <rect x="1.5" y="3" width="13" height="8.5" rx="1.4" stroke="currentColor" strokeWidth="1.4" />
                <path d="M6 14h4M8 11.5V14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            ) : null}
            {entry.owner === 'user' ? <span style={youDriveStyles}>you</span> : null}
            {props.onClose ? (
              <span
                role="button"
                tabIndex={0}
                aria-label={`close ${entry.label ?? entry.id}`}
                title="close this browser"
                style={closeStyles(props.narrow === true)}
                onClick={event => {
                  event.stopPropagation()
                  props.onClose?.(entry.id)
                }}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.stopPropagation()
                    event.preventDefault()
                    props.onClose?.(entry.id)
                  }
                }}
              >
                ×
              </span>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function avatarStyles(hue: number): CSSProperties {
  return {
    flex: '0 0 auto',
    width: 14,
    height: 14,
    borderRadius: 4,
    background: `hsl(${hue}, 55%, 42%)`,
    color: '#fff',
    fontSize: 9,
    fontWeight: 700,
    lineHeight: '14px',
    textAlign: 'center',
    textTransform: 'uppercase',
    userSelect: 'none',
  }
}

function closeStyles(narrow: boolean): CSSProperties {
  return {
    flex: '0 0 auto',
    minWidth: narrow ? 20 : 16,
    height: narrow ? 20 : 16,
    borderRadius: 5,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 12,
    lineHeight: 1,
    color: 'var(--dsw-text-secondary, rgba(255,255,255,0.58))',
    cursor: 'pointer',
  }
}

function dotStyles(entry: SessionSummary, live: boolean): CSSProperties {
  const color = entry.challengeVendor
    ? '#d29922'
    : entry.phase === 'streaming' || entry.phase === 'ready' || entry.phase === 'navigating'
      ? '#3fb950'
      : entry.phase === 'error'
        ? '#f85149'
        : '#8a8a94'
  return {
    flex: '0 0 auto',
    width: 7,
    height: 7,
    borderRadius: '50%',
    background: color,
    boxShadow: `0 0 5px ${color}`,
    // A streaming browser breathes: the phase dot pulses on the same keyframe
    // the capsule uses, so "alive" reads at a glance across many tabs.
    ...(live ? { animation: 'dsh-browser-pulse 1.6s ease-in-out infinite' } : {}),
  }
}

// ── timeline drawer ─────────────────────────────────────────────────────────

export interface TimelineDrawerProps {
  entries: ActionEntry[]
  open: boolean
  onToggle(): void
}

/**
 * The session's recent tool actions, newest first.
 *
 * This is the "session recorder" gap closed at the honest scale: not video, but
 * a durable per-action log the user can scan while the stream animates the
 * gestures. Entries never contain typed text — the host timeline stores
 * summaries only.
 */
export function TimelineDrawer(props: TimelineDrawerProps): ReactNode {
  const entries = [...(props.entries ?? [])].reverse().slice(0, 12)
  return (
    <div style={drawerStyles}>
      <button type="button" style={drawerToggleStyles} onClick={props.onToggle} aria-expanded={props.open}>
        <span style={{ transform: props.open ? 'rotate(90deg)' : 'none', display: 'inline-block', transition: 'transform 140ms ease' }}>›</span>
        {' '}timeline
        {entries.length > 0 ? <span style={countBadgeStyles}>{entries.length}</span> : null}
      </button>
      {props.open ? (
        <div style={drawerBodyStyles}>
          {entries.length === 0 ? (
            <div style={emptyTimelineStyles}>no actions yet — the agent’s steps will appear here</div>
          ) : (
            entries.map((entry, index) => (
              <div key={`${entry.ts}-${index}`}>
                <div style={entryRowStyles}>
                  <span style={entryDotStyles(entry)} aria-hidden="true" />
                  <span style={toolIconStyles} data-toolicon={entry.tool.replace('browser_', '')} aria-hidden="true">{toolIcon(entry.tool)}</span>
                  <span style={entryToolStyles}>{entry.tool.replace('browser_', '')}</span>
                  <span style={entrySummaryStyles}>{entry.summary}</span>
                  <span style={entryTimeStyles}>{relativeTime(entry.ts)}</span>
                </div>
                {entry.clip ? <ClipPlayer clip={entry.clip} /> : null}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}

// ── debug drawer ────────────────────────────────────────────────────────────

export interface DebugDrawerProps {
  debug?: {
    armed: boolean
    supported: boolean
    console: Array<{ ts: number; level: string; text: string }>
    network: Array<{ ts: number; method: string; url: string; status?: number; resourceType?: string; failure?: string }>
  }
  open: boolean
  onToggle(): void
}

/**
 * Console + network feed, newest first — the panel's devtools-lite.
 *
 * Opt-in like everything else here: nothing is captured until the user arms
 * the tap, and while it is armed the drawer says out loud that extra
 * listeners are attached (a posture gap the user chose with eyes open).
 */
export function DebugDrawer(props: DebugDrawerProps): ReactNode {
  const debug = props.debug
  const console = [...(debug?.console ?? [])].reverse().slice(0, 12)
  const network = [...(debug?.network ?? [])].reverse().slice(0, 12)
  const count = (debug?.console?.length ?? 0) + (debug?.network?.length ?? 0)
  return (
    <div style={drawerStyles}>
      <button type="button" style={drawerToggleStyles} onClick={props.onToggle} aria-expanded={props.open}>
        <span style={{ transform: props.open ? 'rotate(90deg)' : 'none', display: 'inline-block', transition: 'transform 140ms ease' }}>›</span>
        {' '}console + network
        {count > 0 ? <span style={countBadgeStyles}>{count}</span> : null}
      </button>
      {props.open ? (
        <div style={drawerBodyStyles}>
          {!debug?.armed ? (
            <div style={emptyTimelineStyles}>tap disarmed — press “Debug tap” below to start capturing console + network</div>
          ) : !debug.supported ? (
            <div style={emptyTimelineStyles}>this engine does not expose console/network taps</div>
          ) : (
            <>
              <div style={debugSectionStyles}>posture gap: console + network listeners are attached while the tap is armed</div>
              {console.length === 0 && network.length === 0 ? (
                <div style={emptyTimelineStyles}>nothing captured yet — interact with the page</div>
              ) : null}
              {console.length > 0 ? <div style={debugSectionStyles}>console</div> : null}
              {console.map((entry, index) => (
                <div key={`c-${entry.ts}-${index}`} style={entryRowStyles}>
                  <span style={debugLevelDotStyles(entry.level)} aria-hidden="true" />
                  <span style={entryToolStyles}>{entry.level}</span>
                  <span style={entrySummaryStyles}>{entry.text}</span>
                  <span style={entryTimeStyles}>{relativeTime(entry.ts)}</span>
                </div>
              ))}
              {network.length > 0 ? <div style={debugSectionStyles}>network</div> : null}
              {network.map((entry, index) => (
                <div key={`n-${entry.ts}-${index}`} style={entryRowStyles}>
                  <span style={debugStatusDotStyles(entry.status, entry.failure)} aria-hidden="true" />
                  <span style={entryToolStyles}>{typeof entry.status === 'number' ? String(entry.status) : '—'} {entry.method}</span>
                  <span style={entrySummaryStyles}>{entry.failure ? `${entry.url} (${entry.failure})` : entry.url}</span>
                  <span style={entryTimeStyles}>{relativeTime(entry.ts)}</span>
                </div>
              ))}
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}

const debugSectionStyles: CSSProperties = {
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: 'var(--dsw-text-muted, #8b949e)',
  padding: '4px 2px 2px',
}

function debugLevelDotStyles(level: string): CSSProperties {
  const color = level === 'error' ? '#f85149' : level === 'warning' || level === 'warn' ? '#d29922' : '#58a6ff'
  return { flex: '0 0 auto', width: 6, height: 6, borderRadius: '50%', background: color }
}

function debugStatusDotStyles(status: number | undefined, failure: string | undefined): CSSProperties {
  const color = failure || status === 0 || (typeof status === 'number' && status >= 400) ? '#f85149' : '#3fb950'
  return { flex: '0 0 auto', width: 6, height: 6, borderRadius: '50%', background: color }
}

const toolIconStyles: CSSProperties = {
  flex: '0 0 auto',
  display: 'inline-flex',
  alignItems: 'center',
  color: 'var(--dsw-text-muted, #8b949e)',
}

/**
 * A 10px glyph per tool family, so the timeline reads as pictures first and
 * words second. Strokes only — they inherit the row's muted color.
 */
/**
 * Inline flipbook for a delivered clip: fetches the signed manifest once,
 * then cycles its frames at the recorded fps. SSR renders the shell only —
 * the fetch lives in an effect, so Node never touches the network.
 */
function ClipPlayer(props: { clip: ClipRef }): ReactNode {
  const [manifest, setManifest] = useState<{
    at?: number
    fps?: number
    frames?: { url?: string; t?: number }[]
    events?: { t: number; type: string; actor: string; x?: number; y?: number; text: string }[]
  } | null>(null)
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(true)
  useEffect(() => {
    let dead = false
    void fetch(props.clip.manifest)
      .then(response => (response.ok ? response.json() : null))
      .then((parsed: unknown) => {
        if (dead || typeof parsed !== 'object' || parsed === null) return
        const frames = (parsed as { frames?: unknown }).frames
        if (Array.isArray(frames)) setManifest(parsed as { fps?: number; frames?: { url?: string }[] })
      })
      .catch(() => undefined)
    return () => { dead = true }
  }, [props.clip.manifest])
  const frames = (manifest?.frames ?? []).filter((frame): frame is { url: string; t?: number } => typeof frame?.url === 'string')
  useEffect(() => {
    if (!playing || frames.length === 0) return
    const fps = Math.min(12, Math.max(1, Math.round(manifest?.fps ?? props.clip.fps ?? 3)))
    const timer = setInterval(() => setIndex(i => (i + 1) % frames.length), Math.round(1000 / fps))
    return () => clearInterval(timer)
  }, [playing, frames.length, manifest?.fps, props.clip.fps])
  const position = Math.min(index, Math.max(0, frames.length - 1))
  const current = frames[position]
  // The gesture track: marks whose timestamp falls inside this frame's window
  // draw the model's hand back on top of the raw captures.
  const events = manifest?.events ?? []
  const frameAt = (i: number): number => frames[i]?.t ?? (manifest?.at ?? 0) + Math.round((i * 1000) / Math.max(1, props.clip.fps))
  const windowEnd = position + 1 < frames.length ? frameAt(position + 1) : frameAt(position) + Math.round(1000 / Math.max(1, props.clip.fps))
  const marks = events.filter(e => typeof e.x === 'number' && typeof e.y === 'number' && e.t >= frameAt(position) && e.t < windowEnd)
  const caption = [...events].reverse().find(e => e.t <= frameAt(position))?.text
  return (
    <div style={clipPlayerStyles} data-clip-id={props.clip.id}>
      <div style={clipStageStyles}>
        {current ? (
          <img src={current.url} alt={`clip frame ${position + 1} of ${frames.length}`} style={clipFrameStyles} />
        ) : (
          <div style={clipLoadingStyles}>loading clip…</div>
        )}
        {marks.map((mark, i) => (
          <span
            key={`${mark.t}-${i}`}
            style={{ ...clipMarkStyles, left: `${(mark.x ?? 0) * 100}%`, top: `${(mark.y ?? 0) * 100}%` }}
            data-gesture-mark={mark.type}
            aria-hidden="true"
          >
            {mark.type === 'click' || mark.type === 'down' ? (
              <span style={clipRippleStyles(mark.actor)} />
            ) : null}
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ display: 'block' }}>
              <path d="M2 1.5 11 7.2 6.6 8.1 8.8 12.4 6.8 13.3 4.7 9 2 11.6Z" fill={mark.actor === 'user' ? '#f0883e' : '#58a6ff'} stroke="#010409" strokeWidth="0.8" />
            </svg>
          </span>
        ))}
      </div>
      <div style={clipBarStyles}>
        <span style={clipCaptionStyles} data-gesture-caption>{caption ?? '…'}</span>
        <button type="button" style={clipButtonStyles} onClick={() => setPlaying(value => !value)} aria-label={playing ? 'pause clip' : 'play clip'}>
          {playing ? '❚❚' : '▶'}
        </button>
        <span style={clipMetaStyles}>
          {frames.length > 0 ? `${Math.min(index, frames.length - 1) + 1}/${frames.length}` : '—'} · {props.clip.seconds}s @ {props.clip.fps}fps
        </span>
      </div>
    </div>
  )
}

const clipPlayerStyles: CSSProperties = {
  margin: '2px 0 6px 22px',
  border: '1px solid rgba(103,232,249,0.28)',
  borderRadius: 8,
  overflow: 'hidden',
  background: 'rgba(1,4,9,0.72)',
}
const clipStageStyles: CSSProperties = { position: 'relative', overflow: 'hidden' }
const clipFrameStyles: CSSProperties = { display: 'block', width: '100%', maxHeight: 220, objectFit: 'contain', background: '#010409' }
const clipMarkStyles: CSSProperties = { position: 'absolute', transform: 'translate(-2px,-2px)', pointerEvents: 'none', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.7))' }
const clipRippleStyles = (actor: string): CSSProperties => ({
  position: 'absolute', left: 0, top: 0, width: 26, height: 26, borderRadius: '50%',
  border: `2px solid ${actor === 'user' ? '#f0883e' : '#67e8f9'}`,
  transform: 'translate(-50%,-50%)',
  animation: 'dsh-browser-markpop 700ms ease-out forwards',
})
const clipCaptionStyles: CSSProperties = {
  flex: '1 1 auto', fontSize: 10, color: '#a5d6ff', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
}
const clipLoadingStyles: CSSProperties = { padding: '14px 12px', fontSize: 11, color: '#8b949e' }
const clipBarStyles: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', borderTop: '1px solid rgba(103,232,249,0.18)' }
const clipButtonStyles: CSSProperties = {
  border: '1px solid rgba(103,232,249,0.35)', background: 'rgba(103,232,249,0.08)', color: '#67e8f9',
  borderRadius: 5, fontSize: 9, lineHeight: '14px', padding: '1px 6px', cursor: 'pointer',
}
const clipMetaStyles: CSSProperties = { fontSize: 10, color: '#8b949e', fontVariantNumeric: 'tabular-nums' }

function toolIcon(tool: string): ReactNode {
  const t = tool.replace('browser_', '')
  const common = { width: 10, height: 10, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  if (t === 'click' || t === 'act') return <svg {...common}><path d="M2.5 1.5 9.5 6.2 6 7l1.8 3.6-1.7.8L4.3 7.8 2.5 9.5Z" /></svg>
  if (t === 'type' || t === 'fill_form') return <svg {...common}><rect x="1" y="3" width="10" height="6" rx="1" /><path d="M3 5h.01M5 5h.01M7 5h.01M9 5h.01M4 7h4" /></svg>
  if (t === 'press') return <svg {...common}><rect x="3" y="3.5" width="6" height="5" rx="1" /><path d="M5 6.5h2" /></svg>
  if (t === 'scroll' || t === 'swipe') return <svg {...common}><path d="M6 2v8M3.5 7.5 6 10l2.5-2.5" /></svg>
  if (t === 'navigate' || t === 'tabs') return <svg {...common}><circle cx="6" cy="6" r="4.4" /><path d="M1.6 6h8.8M6 1.6c-1.6 1.3-2.3 2.9-2.3 4.4S4.4 9.1 6 10.4c1.6-1.3 2.3-2.9 2.3-4.4S7.6 2.9 6 1.6Z" /></svg>
  if (t === 'observe' || t === 'see') return <svg {...common}><path d="M1.5 6S3.5 2.8 6 2.8 10.5 6 10.5 6 8.5 9.2 6 9.2 1.5 6 1.5 6Z" /><circle cx="6" cy="6" r="1.4" /></svg>
  if (t === 'extract') return <svg {...common}><path d="M4.5 2 3 6l1.5 4M7.5 2 9 6l-1.5 4" /></svg>
  if (t === 'files') return <svg {...common}><path d="M6 2v5M4 5.2 6 7.2l2-2M2.5 9.5h7" /></svg>
  if (t === 'workflow') return <svg {...common}><circle cx="6" cy="6" r="4.4" /><circle cx="6" cy="6" r="1.6" fill="currentColor" stroke="none" /></svg>
  if (t === 'task') return <svg {...common}><circle cx="6" cy="6" r="2" /><path d="M6 1.6v1.2M6 9.2v1.2M10.4 6H9.2M2.8 6H1.6M9.1 2.9l-.9.9M3.8 8.2l-.9.9M9.1 9.1l-.9-.9M3.8 3.8l-.9-.9" /></svg>
  if (t === 'challenge' || t === 'handoff' || t === 'takeover') return <svg {...common}><path d="M4 7V3.4a1 1 0 0 1 2 0V6l2.6.7c.9.2 1.4 1.1 1.3 2l-.3 1.6a2 2 0 0 1-2 1.7H5.6a2.2 2.2 0 0 1-1.8-.9L2.4 9.2a.9.9 0 0 1 1.4-1.1L4 8.6Z" /></svg>
  if (t === 'clip') return <svg {...common}><rect x="1.5" y="2.5" width="9" height="7" rx="1" /><path d="M1.5 4.5h9M3.5 2.5v2M6 2.5v2M8.5 2.5v2" /></svg>
  if (t === 'transcript') return <svg {...common}><path d="M3 3h6M3 5.5h6M3 8h4" /></svg>
  if (t === 'cookies') return <svg {...common}><circle cx="6" cy="6" r="4.4" /><path d="M4.4 5h.01M7.4 4.4h.01M6.4 7.6h.01" /></svg>
  return <svg {...common}><circle cx="6" cy="6" r="1.6" fill="currentColor" stroke="none" /></svg>
}

function entryDotStyles(entry: ActionEntry): CSSProperties {
  const color = entry.ok ? '#3fb950' : entry.refused === 'policy' ? '#f85149' : '#d29922'
  return { flex: '0 0 auto', width: 6, height: 6, borderRadius: '50%', background: color }
}

function relativeTime(ts: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (seconds < 5) return 'now'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.round(minutes / 60)}h`
}

// ── styles ──────────────────────────────────────────────────────────────────

const stripStyles: CSSProperties = {
  display: 'flex',
  alignItems: 'stretch',
  gap: 4,
  padding: '6px 8px 0',
  flex: '0 0 auto',
  overflowX: 'auto',
  overflowY: 'hidden',
  scrollbarWidth: 'none',
  background: 'var(--dsw-bg-secondary, #121216)',
  borderBottom: '1px solid var(--dsw-border-color, rgba(128,128,128,0.16))',
}

function tabStyles(selected: boolean, narrow: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    flex: '0 0 auto',
    minHeight: narrow ? 38 : 30,
    padding: narrow ? '0 12px' : '0 9px',
    fontSize: 11.5,
    fontWeight: selected ? 650 : 500,
    borderRadius: '8px 8px 0 0',
    border: `1px solid ${selected ? 'var(--dsw-border-color, rgba(128,128,128,0.34))' : 'transparent'}`,
    borderBottom: 'none',
    background: selected ? 'var(--dsw-bg-primary, #1a1a20)' : 'transparent',
    color: selected ? 'var(--dsw-text-primary, rgba(255,255,255,0.92))' : 'var(--dsw-text-secondary, rgba(255,255,255,0.55))',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    marginBottom: -1,
  }
}

const tabLabelStyles: CSSProperties = {
  maxWidth: 120,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const youDriveStyles: CSSProperties = {
  fontSize: 9,
  padding: '1px 5px',
  borderRadius: 999,
  background: 'rgba(210,153,34,0.22)',
  border: '1px solid rgba(210,153,34,0.5)',
  color: 'rgba(255,255,255,0.85)',
}

const drawerStyles: CSSProperties = {
  flex: '0 0 auto',
  borderBottom: '1px solid var(--dsw-border-color, rgba(128,128,128,0.16))',
  background: 'var(--dsw-bg-secondary, rgba(255,255,255,0.02))',
}

const drawerToggleStyles: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  width: '100%',
  minHeight: 30,
  padding: '0 10px',
  fontSize: 10.5,
  fontWeight: 600,
  letterSpacing: 0.4,
  textTransform: 'uppercase',
  background: 'transparent',
  border: 'none',
  color: 'var(--dsw-text-secondary, rgba(255,255,255,0.55))',
  cursor: 'pointer',
  textAlign: 'left',
}

const countBadgeStyles: CSSProperties = {
  fontSize: 9.5,
  padding: '0 5px',
  borderRadius: 999,
  background: 'rgba(128,128,128,0.2)',
  color: 'var(--dsw-text-primary, rgba(255,255,255,0.8))',
}

const drawerBodyStyles: CSSProperties = {
  maxHeight: 150,
  overflowY: 'auto',
  WebkitOverflowScrolling: 'touch',
  padding: '2px 8px 8px',
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
}

const emptyTimelineStyles: CSSProperties = {
  fontSize: 11,
  padding: '6px 4px',
  color: 'var(--dsw-text-secondary, rgba(255,255,255,0.45))',
}

const entryRowStyles: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  fontSize: 11,
  padding: '3px 4px',
  borderRadius: 6,
}

const entryToolStyles: CSSProperties = {
  flex: '0 0 auto',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 10,
  color: 'rgba(88,166,255,0.9)',
}

const entrySummaryStyles: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--dsw-text-primary, rgba(255,255,255,0.82))',
}

const entryTimeStyles: CSSProperties = {
  flex: '0 0 auto',
  fontSize: 9.5,
  color: 'var(--dsw-text-secondary, rgba(255,255,255,0.4))',
  fontVariantNumeric: 'tabular-nums',
}
