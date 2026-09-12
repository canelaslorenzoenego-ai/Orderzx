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

import type { CSSProperties, ReactNode } from 'react'
import type { ActionEntry, SessionSummary } from '../protocol.js'

export interface SessionTabStripProps {
  sessions: SessionSummary[]
  /** 'home' or a session id. */
  selected: string
  onSelect(id: string): void
  /** Narrow layout: bigger hit targets, horizontal scroll. */
  narrow?: boolean
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
        return (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={selected}
            style={tabStyles(selected, props.narrow === true)}
            onClick={() => props.onSelect(entry.id)}
            title={`${entry.label ?? entry.id} · ${entry.url || entry.phase}${entry.challengeVendor ? ` · ${entry.challengeVendor} challenge` : ''}`}
          >
            <span style={dotStyles(entry)} aria-hidden="true" />
            <span style={tabLabelStyles}>{entry.label ?? entry.id.slice(0, 6)}</span>
            {entry.owner === 'user' ? <span style={youDriveStyles}>you</span> : null}
          </button>
        )
      })}
    </div>
  )
}

function dotStyles(entry: SessionSummary): CSSProperties {
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
              <div key={`${entry.ts}-${index}`} style={entryRowStyles}>
                <span style={entryDotStyles(entry)} aria-hidden="true" />
                <span style={entryToolStyles}>{entry.tool.replace('browser_', '')}</span>
                <span style={entrySummaryStyles}>{entry.summary}</span>
                <span style={entryTimeStyles}>{relativeTime(entry.ts)}</span>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
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
