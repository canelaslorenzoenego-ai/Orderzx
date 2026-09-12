/**
 * The home tab: what the panel shows before (or between) browsers.
 *
 * The first thing a user sees when the dashboard extends should not be a
 * spinner waiting on a model turn — it should be a start page they can act on:
 * launch a browser right here, pick a recent site, or jump into one of the
 * sub-agent browsers already running. The agent starting browsers and the user
 * starting browsers are two doors into the same host; this is the user's door.
 *
 * SSR-safe and dependency-free like every other client module: inline styles
 * only, no network calls at render, all strings local.
 *
 * @module @dsh-community/dsh-browser/client/home-tab
 */

import { useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { SessionSummary } from '../protocol.js'

/** Recently launched URLs, kept client-side only. Never leaves the machine. */
const MRU_KEY = 'dsh-browser.mru.v1'
const MRU_MAX = 8

export function readMru(): string[] {
  try {
    const raw = localStorage.getItem(MRU_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is string => typeof entry === 'string' && /^https?:\/\//i.test(entry)).slice(0, MRU_MAX)
  } catch {
    return []
  }
}

export function pushMru(url: string): void {
  try {
    const normalized = url.trim()
    if (!/^https?:\/\//i.test(normalized)) return
    const next = [normalized, ...readMru().filter(entry => entry !== normalized)].slice(0, MRU_MAX)
    localStorage.setItem(MRU_KEY, JSON.stringify(next))
  } catch {
    // Private mode / disabled storage: the home tab simply loses its recents.
  }
}

export interface HomeTabProps {
  /** Live sub-agent browsers, offered as jump-in cards. */
  sessions: SessionSummary[]
  /** True while a launch request is in flight. */
  launching: boolean
  /** Host reported no engine available — show the install hint instead of a dead button. */
  engineMissing?: boolean
  onLaunch(url: string, label: string): void
  onOpenSession(id: string): void
}

export function HomeTab(props: HomeTabProps): ReactNode {
  const [url, setUrl] = useState('')
  const [label, setLabel] = useState('')
  const [mru, setMru] = useState<string[]>(() => readMru())

  const launch = (): void => {
    props.onLaunch(url.trim(), label.trim())
    if (url.trim()) {
      pushMru(normalizeUrl(url.trim()))
      setMru(readMru())
    }
    setUrl('')
  }

  const sessions = props.sessions ?? []

  return (
    <div style={homeStyles}>
      <MonitorMark />
      <div style={titleStyles}>Start a browser</div>
      <div style={subtitleStyles}>
        The agent can launch browsers itself — this is your door. Sessions you start here stream, accept takeover and
        solve challenges exactly like agent-started ones.
      </div>

      <div style={launchRowStyles}>
        <input
          style={urlInputStyles}
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="example.com or https://…"
          aria-label="start url"
          value={url}
          disabled={props.launching}
          onChange={event => setUrl(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') launch()
          }}
        />
        <input
          style={labelInputStyles}
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="label (optional)"
          aria-label="session label"
          value={label}
          disabled={props.launching}
          onChange={event => setLabel(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') launch()
          }}
        />
        <button
          type="button"
          style={launchButtonStyles(props.launching || props.engineMissing === true)}
          disabled={props.launching || props.engineMissing === true}
          onClick={launch}
        >
          {props.launching ? 'launching…' : 'Launch'}
        </button>
      </div>

      {props.engineMissing ? (
        <div style={hintStyles}>
          No browser driver found. Install one on the host machine: <code style={codeStyles}>npm i patchright</code> (or
          point <code style={codeStyles}>engine.cdpEndpoint</code> at a running Chrome).
        </div>
      ) : null}

      {mru.length > 0 ? (
        <div style={sectionStyles}>
          <div style={sectionTitleStyles}>Recent</div>
          <div style={tileGridStyles}>
            {mru.map(entry => (
              <button
                key={entry}
                type="button"
                style={tileStyles}
                title={entry}
                onClick={() => {
                  props.onLaunch(entry, '')
                  pushMru(entry)
                  setMru(readMru())
                }}
              >
                <span style={tileHostStyles}>{hostOf(entry)}</span>
                <span style={tilePathStyles}>{pathOf(entry)}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {sessions.length > 0 ? (
        <div style={sectionStyles}>
          <div style={sectionTitleStyles}>Running browsers</div>
          <div style={sessionListStyles}>
            {sessions.map(entry => (
              <button key={entry.id} type="button" style={sessionCardStyles} onClick={() => props.onOpenSession(entry.id)}>
                <span style={phaseDotStyles(entry)} aria-hidden="true" />
                <span style={{ flex: '1 1 auto', minWidth: 0 }}>
                  <span style={sessionNameStyles}>{entry.label ?? entry.id.slice(0, 8)}</span>
                  <span style={sessionUrlStyles}>{entry.url ? hostOf(entry.url) : entry.phase}</span>
                </span>
                <span style={sessionOwnerStyles}>{entry.owner === 'user' ? 'you drive' : 'agent drives'}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function normalizeUrl(value: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`
}

function hostOf(url: string): string {
  try {
    const parsed = new URL(normalizeUrl(url))
    return parsed.host || url.slice(0, 40)
  } catch {
    return url.slice(0, 40)
  }
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(normalizeUrl(url))
    const path = `${parsed.pathname}${parsed.search}`
    return path.length > 1 ? path.slice(0, 44) : ''
  } catch {
    return ''
  }
}

/** The chatbar monitor glyph, reused at hero size. Inline SVG — no assets. */
function MonitorMark(): ReactNode {
  return (
    <svg width="52" height="44" viewBox="0 0 20 17" fill="none" aria-hidden="true" style={{ display: 'block', margin: '0 auto' }}>
      <rect x="1" y="1.5" width="18" height="11.5" rx="2" stroke="rgba(88,166,255,0.9)" strokeWidth="1.3" />
      <rect x="3" y="3.5" width="14" height="7.5" rx="1" fill="rgba(88,166,255,0.16)" />
      <path d="M7 15.5h6M10 13v2.5" stroke="rgba(88,166,255,0.9)" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="10" cy="7.2" r="1.5" fill="rgba(63,185,80,0.95)">
        <animate attributeName="opacity" values="1;0.35;1" dur="1.6s" repeatCount="indefinite" />
      </circle>
    </svg>
  )
}

// ── styles ──────────────────────────────────────────────────────────────────

const homeStyles: CSSProperties = {
  flex: '1 1 auto',
  minHeight: 0,
  overflowY: 'auto',
  WebkitOverflowScrolling: 'touch',
  padding: '22px 16px 18px',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
}

const titleStyles: CSSProperties = {
  fontSize: 15,
  fontWeight: 650,
  textAlign: 'center',
  color: 'var(--dsw-text-primary, rgba(255,255,255,0.92))',
}

const subtitleStyles: CSSProperties = {
  fontSize: 11.5,
  lineHeight: 1.5,
  textAlign: 'center',
  maxWidth: 380,
  margin: '0 auto',
  color: 'var(--dsw-text-secondary, rgba(255,255,255,0.58))',
}

const launchRowStyles: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  justifyContent: 'center',
}

const urlInputStyles: CSSProperties = {
  flex: '2 1 180px',
  minWidth: 0,
  minHeight: 38,
  padding: '0 10px',
  fontSize: 12.5,
  borderRadius: 8,
  border: '1px solid var(--dsw-border-color, rgba(128,128,128,0.3))',
  background: 'var(--dsw-bg-primary, rgba(0,0,0,0.25))',
  color: 'var(--dsw-text-primary, rgba(255,255,255,0.92))',
  outline: 'none',
}

const labelInputStyles: CSSProperties = {
  ...urlInputStyles,
  flex: '1 1 110px',
}

function launchButtonStyles(disabled: boolean): CSSProperties {
  return {
    flex: '0 0 auto',
    minHeight: 38,
    padding: '0 16px',
    fontSize: 12.5,
    fontWeight: 600,
    borderRadius: 8,
    border: '1px solid rgba(63,185,80,0.5)',
    background: disabled ? 'rgba(128,128,128,0.18)' : 'rgba(63,185,80,0.22)',
    color: disabled ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.95)',
    cursor: disabled ? 'default' : 'pointer',
  }
}

const hintStyles: CSSProperties = {
  fontSize: 11,
  lineHeight: 1.5,
  padding: '8px 10px',
  borderRadius: 8,
  border: '1px solid rgba(210,153,34,0.4)',
  background: 'rgba(210,153,34,0.1)',
  color: 'var(--dsw-text-primary, rgba(255,255,255,0.85))',
}

const codeStyles: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 10.5,
  padding: '1px 4px',
  borderRadius: 4,
  background: 'rgba(128,128,128,0.16)',
}

const sectionStyles: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 }

const sectionTitleStyles: CSSProperties = {
  fontSize: 10.5,
  fontWeight: 600,
  letterSpacing: 0.6,
  textTransform: 'uppercase',
  color: 'var(--dsw-text-secondary, rgba(255,255,255,0.5))',
}

const tileGridStyles: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
  gap: 6,
}

const tileStyles: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 2,
  minHeight: 46,
  padding: '8px 10px',
  borderRadius: 9,
  border: '1px solid var(--dsw-border-color, rgba(128,128,128,0.24))',
  background: 'var(--dsw-bg-secondary, rgba(255,255,255,0.04))',
  cursor: 'pointer',
  textAlign: 'left',
}

const tileHostStyles: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--dsw-text-primary, rgba(255,255,255,0.9))',
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const tilePathStyles: CSSProperties = {
  fontSize: 10,
  color: 'var(--dsw-text-secondary, rgba(255,255,255,0.5))',
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const sessionListStyles: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 }

const sessionCardStyles: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minHeight: 46,
  padding: '8px 10px',
  borderRadius: 9,
  border: '1px solid var(--dsw-border-color, rgba(128,128,128,0.24))',
  background: 'var(--dsw-bg-secondary, rgba(255,255,255,0.04))',
  cursor: 'pointer',
  textAlign: 'left',
}

function phaseDotStyles(entry: SessionSummary): CSSProperties {
  const color =
    entry.challengeVendor
      ? '#d29922'
      : entry.phase === 'streaming' || entry.phase === 'ready'
        ? '#3fb950'
        : entry.phase === 'error'
          ? '#f85149'
          : '#8a8a94'
  return {
    flex: '0 0 auto',
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: color,
    boxShadow: `0 0 6px ${color}`,
  }
}

const sessionNameStyles: CSSProperties = {
  display: 'block',
  fontSize: 12.5,
  fontWeight: 600,
  color: 'var(--dsw-text-primary, rgba(255,255,255,0.92))',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const sessionUrlStyles: CSSProperties = {
  display: 'block',
  fontSize: 10.5,
  color: 'var(--dsw-text-secondary, rgba(255,255,255,0.55))',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const sessionOwnerStyles: CSSProperties = {
  flex: '0 0 auto',
  fontSize: 10,
  padding: '2px 7px',
  borderRadius: 999,
  border: '1px solid rgba(128,128,128,0.3)',
  color: 'var(--dsw-text-secondary, rgba(255,255,255,0.65))',
}
