/**
 * The browser frame: the desktop twin of dsh-android's phone shell.
 *
 * dsh-android wraps the device stream in a bezel / phone-shell frame with a
 * three-button navigation panel (◁ ○ □). A browser needs the same idea with
 * different chrome: a tab strip, a nav row (back / forward / reload / stop), an
 * address bar, and a status rail for the frame tier and pointer ownership.
 *
 * Two things this component is responsible for that the Android one is not:
 *
 *  1. **Address bar as an input surface.** The user can type a URL and go. That
 *     is a `drive`-scoped action, so the bar is disabled (with an explanation)
 *     unless the user owns the pointer — otherwise typing would race the agent.
 *  2. **Showing the stealth posture.** The frame tier, fps and any automatic
 *     suppression are visible here. A user who cannot see that their stream
 *     silently dropped from `screencast` to `screenshot` cannot debug why it
 *     looks choppy, and cannot tell whether they are being quiet or loud.
 *
 * All styling is inline plus one injected `<style>` for keyframes (inline style
 * objects cannot carry @keyframes). No external stylesheet: the DSH file
 * preview and the web client both run without one.
 *
 * @module @dsh-community/dsh-browser/client/browser-frame
 */

import type { CSSProperties, ReactNode } from 'react'
import type { BootPhase, FrameSource } from '../protocol.js'

// ── frame styles ────────────────────────────────────────────────────────────

export const FRAME_STYLE_CHROME = 'chrome'
export const FRAME_STYLE_MINIMAL = 'minimal'
export const FRAME_STYLE_FRAMELESS = 'frameless'

export const FRAME_STYLE_OPTIONS = [FRAME_STYLE_CHROME, FRAME_STYLE_MINIMAL, FRAME_STYLE_FRAMELESS] as const
export type FrameStyle = (typeof FRAME_STYLE_OPTIONS)[number]

/** Window shell: rounded top corners, the traffic-light row, a hairline border. */
export const WINDOW_SHELL_STYLES: CSSProperties = {
  borderRadius: 12,
  overflow: 'hidden',
  border: '1px solid var(--dsw-border-color, rgba(15,23,42,0.12))',
  background: 'var(--dsw-bg-secondary, #ffffff)',
  boxShadow: '0 10px 30px rgba(15,23,42,0.12), 0 2px 6px rgba(15,23,42,0.08)',
  display: 'flex',
  flexDirection: 'column',
  // FILL the parent column (panel body / inline chat box). Without this the
  // shell is height:auto — the viewport region inside has nothing to stretch
  // into and the whole window collapses to its chrome rows (the "black screen
  // with a 40px sliver" the user saw on their phone).
  flex: '1 1 auto',
  minHeight: 0,
}

export const TITLEBAR_STYLES: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '7px 10px',
  background: 'var(--dsw-bg-tertiary, #f5f6f8)',
  borderBottom: '1px solid var(--dsw-border-color, rgba(15,23,42,0.10))',
  flex: '0 0 auto',
  // The whole titlebar is the drag region for a future desktop shell; harmless
  // in the browser and it documents intent.
  userSelect: 'none',
}

export const TRAFFIC_LIGHTS = ['#ff5f57', '#febc2e', '#28c840'] as const

export const TAB_STRIP_STYLES: CSSProperties = {
  display: 'flex',
  alignItems: 'stretch',
  gap: 4,
  padding: '4px 8px 0',
  background: 'var(--dsw-bg-tertiary, #f5f6f8)',
  overflowX: 'auto',
  overflowY: 'hidden',
  flex: '0 0 auto',
  scrollbarWidth: 'thin',
}

export function tabStyles(active: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 10px',
    maxWidth: 180,
    minWidth: 72,
    fontSize: 11.5,
    lineHeight: 1.2,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    cursor: 'pointer',
    border: '1px solid transparent',
    borderBottom: 'none',
    borderRadius: '8px 8px 0 0',
    color: active ? 'var(--dsw-text-primary, #1f2329)' : 'var(--dsw-text-tertiary, #6b7280)',
    background: active ? 'var(--dsw-bg-secondary, #ffffff)' : 'transparent',
    borderColor: active ? 'var(--dsw-border-color, rgba(15,23,42,0.12))' : 'transparent',
    flex: '0 0 auto',
  }
}

export const NAV_ROW_STYLES: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 8px',
  background: 'var(--dsw-bg-secondary, #ffffff)',
  borderBottom: '1px solid var(--dsw-border-color, rgba(15,23,42,0.08))',
  flex: '0 0 auto',
}

export const ADDRESS_BAR_STYLES: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  height: 28,
  padding: '0 10px',
  borderRadius: 14,
  fontSize: 12,
  background: 'var(--dsw-bg-tertiary, #f2f3f5)',
  border: '1px solid var(--dsw-border-color, rgba(15,23,42,0.10))',
  color: 'var(--dsw-text-secondary, #4b5563)',
  overflow: 'hidden',
}

export const INPUT_STYLES: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  border: 'none',
  outline: 'none',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
}

export const STATUS_RAIL_STYLES: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '5px 10px',
  fontSize: 10.5,
  lineHeight: 1.3,
  flex: '0 0 auto',
  flexWrap: 'wrap',
  borderTop: '1px solid var(--dsw-border-color, rgba(15,23,42,0.08))',
  background: 'var(--dsw-bg-tertiary, #f5f6f8)',
  color: 'var(--dsw-text-tertiary, #6b7280)',
}

/** Where the stream/synthetic frame renders. */
export const SCREEN_STYLES: CSSProperties = {
  position: 'relative',
  flex: '1 1 auto',
  minHeight: 0,
  background: '#0b0b0f',
  overflow: 'hidden',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}

// ── nav button ──────────────────────────────────────────────────────────────

export const NAV_BUTTON_IDS = ['back', 'forward', 'reload', 'stop', 'takeover', 'capture'] as const
export type NavButtonId = (typeof NAV_BUTTON_IDS)[number]

/** 16px glyph paths, drawn rather than sourced — no icon font, no network. */
export const NAV_ICON_PATHS: Record<NavButtonId, string> = {
  back: 'M10 3 L5 8 L10 13 M5 8 H14',
  forward: 'M6 3 L11 8 L6 13 M11 8 H2',
  reload: 'M13.5 8a5.5 5.5 0 1 1-1.7-3.97M13.5 2.5V5H11',
  stop: 'M4.5 4.5 L11.5 11.5 M11.5 4.5 L4.5 11.5',
  takeover: 'M8 2.5v6.2M8 8.7 5.6 6.3M8 8.7l2.4-2.4M3.5 13.5h9',
  capture: 'M2.5 5.5h2l1-1.5h5l1 1.5h2v7h-11zM8 11.2a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8z',
}

export function navButtonStyles(disabled: boolean, active = false): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 26,
    height: 26,
    padding: 0,
    flex: '0 0 auto',
    borderRadius: 7,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.38 : 1,
    border: '1px solid transparent',
    background: active ? 'var(--dsw-bg-hover, rgba(15,23,42,0.08))' : 'transparent',
    borderColor: active ? 'var(--dsw-border-color, rgba(15,23,42,0.16))' : 'transparent',
    color: active ? 'var(--dsw-text-primary, #1f2329)' : 'var(--dsw-text-secondary, #4b5563)',
  }
}

export function NavIcon({ id, size = 16 }: { id: NavButtonId; size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d={NAV_ICON_PATHS[id]}
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// ── status badges ───────────────────────────────────────────────────────────

/** Frame tier badge. The tier is a stealth decision, so it is always visible. */
export function frameTierLabel(source: FrameSource): string {
  switch (source) {
    case 'screenshot': return 'on-demand'
    case 'screencast': return 'screencast'
    case 'dom': return 'synthetic'
    case 'mirror': return 'mirror'
    default: return String(source)
  }
}

export function badgeStyles(tone: 'neutral' | 'live' | 'attention' | 'error'): CSSProperties {
  const palette = {
    neutral: { fg: 'var(--dsw-text-tertiary, #6b7280)', bg: 'rgba(15,23,42,0.06)' },
    live: { fg: '#3fb950', bg: 'rgba(63,185,80,0.14)' },
    attention: { fg: '#d29922', bg: 'rgba(210,153,34,0.16)' },
    error: { fg: '#f85149', bg: 'rgba(248,81,73,0.16)' },
  }[tone]
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '1px 6px',
    borderRadius: 999,
    fontSize: 10,
    lineHeight: 1.5,
    fontWeight: 500,
    color: palette.fg,
    background: palette.bg,
    whiteSpace: 'nowrap',
  }
}

export function phaseTone(phase: BootPhase): 'neutral' | 'live' | 'attention' | 'error' {
  if (phase === 'error') return 'error'
  if (phase === 'handoff' || phase === 'takeover') return 'attention'
  if (phase === 'streaming') return 'live'
  return 'neutral'
}

// ── the frame ───────────────────────────────────────────────────────────────

export interface BrowserFrameProps {
  style: FrameStyle
  url: string
  title: string
  tabs: Array<{ index: number; title: string; url: string; active: boolean }>
  activeTab: number
  phase: BootPhase
  frameSource: FrameSource
  fps: number
  /** True while a human owns the pointer — enables the address bar and input. */
  driving: boolean
  /** Non-null while a challenge awaits the human. */
  challenge: { vendor: string; blocking: boolean } | null
  suppression: { active: boolean; reason: string | null }
  error: string | null
  /** The stream / synthetic frame / placeholder. */
  children: ReactNode
  onNav(action: 'back' | 'forward' | 'reload' | 'stop'): void
  onAddress(url: string): void
  onTab(action: 'select' | 'close' | 'new', index?: number): void
  onToggleTakeover(): void
  onCapture(): void
  addressDraft: string
  onAddressDraftChange(value: string): void
}

/**
 * Render the browser shell around the live view.
 *
 * `frameless` drops all chrome (just the pixels) for users who want maximum
 * viewport; `minimal` keeps the nav row and status rail but no tab strip.
 */
export function BrowserFrame(props: BrowserFrameProps): ReactNode {
  const { style } = props
  const showTabs = style === FRAME_STYLE_CHROME && props.tabs.length > 0
  const showNav = style !== FRAME_STYLE_FRAMELESS

  return (
    <div style={WINDOW_SHELL_STYLES} data-dsh-browser-frame={style}>
      {style === FRAME_STYLE_CHROME ? (
        <div style={TITLEBAR_STYLES}>
          <span style={{ display: 'flex', gap: 6, flex: '0 0 auto' }}>
            {TRAFFIC_LIGHTS.map(color => (
              <span key={color} style={{ width: 10, height: 10, borderRadius: '50%', background: color, display: 'block' }} />
            ))}
          </span>
          <span
            style={{
              flex: '1 1 auto',
              minWidth: 0,
              textAlign: 'center',
              fontSize: 11,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: 'var(--dsw-text-tertiary, #6b7280)',
            }}
          >
            {props.title || props.url || 'new tab'}
          </span>
          <span style={{ flex: '0 0 auto', width: 54 }} />
        </div>
      ) : null}

      {showTabs ? (
        <div style={TAB_STRIP_STYLES} role="tablist">
          {props.tabs.map(tab => (
            <div
              key={tab.index}
              role="tab"
              aria-selected={tab.active}
              tabIndex={0}
              style={tabStyles(tab.active)}
              title={tab.url}
              onClick={() => props.onTab('select', tab.index)}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') props.onTab('select', tab.index)
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{tab.title || prettyHost(tab.url) || `tab ${tab.index + 1}`}</span>
              {props.driving ? (
                <span
                  role="button"
                  aria-label="close tab"
                  tabIndex={-1}
                  style={{ flex: '0 0 auto', opacity: 0.6, cursor: 'pointer' }}
                  onClick={event => {
                    event.stopPropagation()
                    props.onTab('close', tab.index)
                  }}
                >
                  ×
                </span>
              ) : null}
            </div>
          ))}
          {props.driving ? (
            <div style={{ ...tabStyles(false), minWidth: 28, maxWidth: 28, justifyContent: 'center' }} role="button" tabIndex={0} aria-label="new tab" onClick={() => props.onTab('new')}>
              +
            </div>
          ) : null}
        </div>
      ) : null}

      {showNav ? (
        <div style={NAV_ROW_STYLES}>
          {(['back', 'forward', 'reload', 'stop'] as const).map(id => (
            <button
              key={id}
              type="button"
              aria-label={id}
              title={props.driving ? id : 'take over the pointer to navigate'}
              disabled={!props.driving}
              style={navButtonStyles(!props.driving)}
              onClick={() => props.onNav(id)}
            >
              <NavIcon id={id} />
            </button>
          ))}

          <div style={ADDRESS_BAR_STYLES}>
            <LockGlyph secure={props.url.startsWith('https://')} />
            {props.driving ? (
              <input
                style={INPUT_STYLES}
                value={props.addressDraft}
                spellCheck={false}
                aria-label="address bar"
                placeholder={props.url || 'https://…'}
                onChange={event => props.onAddressDraftChange(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') props.onAddress(props.addressDraft)
                }}
              />
            ) : (
              // Read-only when the agent is driving: typing here would race it.
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                {props.url || 'about:blank'}
              </span>
            )}
          </div>

          <button
            type="button"
            aria-label="capture"
            title="save a capture"
            style={navButtonStyles(false)}
            onClick={props.onCapture}
          >
            <NavIcon id="capture" />
          </button>
          <button
            type="button"
            aria-label={props.driving ? 'resume agent' : 'take over'}
            title={props.driving ? 'hand the pointer back to the agent' : 'take over the mouse'}
            style={navButtonStyles(false, props.driving)}
            onClick={props.onToggleTakeover}
          >
            <NavIcon id="takeover" />
          </button>
        </div>
      ) : null}

      {props.challenge ? (
        <div style={challengeBannerStyles}>
          <strong>{props.challenge.vendor}</strong>
          {props.challenge.blocking ? ' is blocking the page.' : ' is present.'}
          {' '}Solve it here with your own mouse, then report the outcome.
        </div>
      ) : null}

      <div style={SCREEN_STYLES}>{props.children}</div>

      <div style={STATUS_RAIL_STYLES}>
        <span style={badgeStyles(phaseTone(props.phase))}>
          <span style={dotStyles(phaseTone(props.phase))} />
          {props.phase}
        </span>
        <span style={badgeStyles('neutral')}>{frameTierLabel(props.frameSource)}</span>
        <span style={badgeStyles('neutral')}>{props.fps > 0 ? `${props.fps} fps` : '— fps'}</span>
        {props.suppression.active ? (
          <span style={badgeStyles('attention')} title={props.suppression.reason ?? undefined}>
            suppressed
          </span>
        ) : null}
        {props.driving ? <span style={badgeStyles('attention')}>you are driving</span> : <span style={badgeStyles('neutral')}>agent driving</span>}
        {props.error ? <span style={badgeStyles('error')}>{props.error.slice(0, 60)}</span> : null}
      </div>
    </div>
  )
}

const challengeBannerStyles: CSSProperties = {
  padding: '6px 10px',
  fontSize: 11,
  lineHeight: 1.45,
  background: 'rgba(210,153,34,0.14)',
  color: '#d29922',
  borderBottom: '1px solid rgba(210,153,34,0.3)',
  flex: '0 0 auto',
}

function dotStyles(tone: 'neutral' | 'live' | 'attention' | 'error'): CSSProperties {
  const color = tone === 'live' ? '#3fb950' : tone === 'attention' ? '#d29922' : tone === 'error' ? '#f85149' : '#8a8a94'
  return { width: 6, height: 6, borderRadius: '50%', background: color, display: 'block' }
}

function LockGlyph({ secure }: { secure: boolean }): ReactNode {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flex: '0 0 auto', opacity: 0.7 }}>
      {secure ? (
        <path d="M5 7V5.2a3 3 0 0 1 6 0V7M3.8 7h8.4v6.2H3.8z" stroke="#3fb950" strokeWidth="1.3" strokeLinejoin="round" />
      ) : (
        <path d="M5 7V5.2a3 3 0 0 1 5.7-1.3M3.8 7h8.4v6.2H3.8z" stroke="#d29922" strokeWidth="1.3" strokeLinejoin="round" />
      )}
    </svg>
  )
}

export function prettyHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}
