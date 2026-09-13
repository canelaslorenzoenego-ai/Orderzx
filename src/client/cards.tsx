/**
 * Inline tool cards.
 *
 * The action cards stay compact one-liners: their job is to say WHAT happened
 * and to be a handle into the browser. The BOOT card is different since the
 * user asked for the screen "directly in chat": it extends downward with the
 * side dashboard (see inline-live.tsx + panel-host.tsx) — the live card sits
 * BESIDE the chat (leased column / phone drawer), never inside the flow
 * the whole chrome window while the model searches, and collapses when it
 * stops. Only the CURRENT session's boot card hosts the frame; superseded
 * cards shrink back to their one-line readout.
 *
 * Three cards cover the five registered tools:
 *
 *   BootCard      browser_start — phase readout, session id, inline live frame.
 *   BrowserCard   browser_observe / browser_click — URL, action target, badges.
 *   ChallengeCard browser_challenge / browser_handoff — vendor, state, and an
 *                 explicit "agent is paused, you are needed" affordance.
 *
 * All three read `HydratedMeta`, so they render identically whether the meta came
 * from `presentationMeta` (top-level call) or was rebuilt from the result JSON
 * (nested PTC call). That equivalence is asserted in the smoke suite.
 *
 * `meta.summary` is the primary text: it is produced host-side by the same code
 * that produced the canonical result, so the card cannot drift from the truth by
 * re-deriving a sentence client-side.
 *
 * @module @dsh-community/dsh-browser/client/cards
 */

import { useEffect, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { CARD_TOOLS } from '../protocol.js'
import { CARD_STYLES } from './card-styles.js'
import { bootLabel, reduceMeta, resetBoot, type BootState } from './boot-sequence.js'

import { sessionMemory, shortenUrl, type HydratedMeta } from './meta-hydrate.js'

export interface BrowserCardProps extends ToolCallViewProps {
  meta?: HydratedMeta
  /** Opens the panel scoped to this card's browser session. */
  openPanel(): void
}

/** Remember the session id so later cards without one can still scope the panel. */
function useRememberSession(meta: HydratedMeta | undefined): void {
  const sessionId = meta?.sessionId
  useEffect(() => {
    if (sessionId) sessionMemory.remember(sessionId)
  }, [sessionId])
}

// ── boot ────────────────────────────────────────────────────────────────────

/**
 * The boot readout.
 *
 * Runs the SAME reducer the capsule and panel use (`reduceMeta`), so all three
 * surfaces agree on stage and wording.
 */
export function BootCard(props: BrowserCardProps): ReactNode {
  const meta = props.meta
  useRememberSession(meta)
  // Only the card of the CURRENT remembered session hosts the inline live
  // frame. Subscribed (not read once) so the frame appears the moment the
  // remember-effect fires, and disappears when a newer browser_start supersedes
  // this one.
  const currentSession = useSyncExternalStore(
    sessionMemory.subscribe,
    sessionMemory.current,
    sessionMemory.current,
  )

  if (!meta) return <EmptyCard label="browser_start" detail="no result yet" />

  const boot: BootState = reduceMeta(resetBoot(), meta)
  const tone: CardTone = meta.refusal ? 'refused' : boot.stage === 'live' ? 'ok' : 'busy'
  const detail = [
    meta.sessionId ? `session ${meta.sessionId.slice(0, 8)}` : null,
    meta.url ? shortenUrl(meta.url) : null,
    meta.width && meta.height ? `${meta.width}×${meta.height}` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  const liveHost =
    meta.sessionId !== undefined
    && meta.refusal === undefined
    && currentSession === meta.sessionId

  return (
    <CardRow
      tone={tone}
      onClick={props.openPanel}
      title={meta.refusal ? 'start refused' : bootLabel(boot)}
      detail={detail || meta.summary}
      cue={liveHost ? 'side' : 'open'}
      sideToggle={liveHost}
    >
      {meta.refusal ? <Badge tone="refused">{meta.refusal.reason}</Badge> : null}
      {meta.phase === 'streaming' ? <Badge tone="ok">live</Badge> : null}
    </CardRow>
  )
}

// ── observation / action ────────────────────────────────────────────────────

export function BrowserCard(props: BrowserCardProps): ReactNode {
  const meta = props.meta
  useRememberSession(meta)

  if (!meta) return <EmptyCard label={props.toolName ?? 'browser'} detail="no result yet" />

  const isClick = meta.tool === CARD_TOOLS.click
  const tone: CardTone = meta.refusal ? 'refused' : meta.challenge ? 'attention' : 'ok'
  const detail = [
    meta.url ? shortenUrl(meta.url) : null,
    meta.target ? describeTarget(meta.target) : null,
    meta.challenge ? `challenge: ${meta.challenge.vendor}` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <CardRow tone={tone} onClick={props.openPanel} title={isClick ? 'clicked' : 'observed'} detail={detail || meta.summary} cue="view">
      {meta.capturePath ? <Badge tone="neutral">capture</Badge> : null}
      {meta.challenge ? <Badge tone="attention">{meta.challenge.vendor}</Badge> : null}
      {meta.refusal ? <Badge tone="refused">{meta.refusal.reason}</Badge> : null}
    </CardRow>
  )
}

// ── challenge / handoff ─────────────────────────────────────────────────────

/**
 * The challenge card.
 *
 * Wording is explicit about WHO has to act. "awaiting-user" rendered as a neutral
 * status reads as "the agent is still working"; the truth is the agent is blocked
 * and the user is the only thing that can unblock it.
 */
export function ChallengeCard(props: BrowserCardProps): ReactNode {
  const meta = props.meta
  useRememberSession(meta)

  if (!meta) return <EmptyCard label={props.toolName ?? 'browser'} detail="no challenge data" />

  const isHandoff = meta.tool === CARD_TOOLS.handoff
  // `outcome` only exists on the replay path; a projected handoff meta collapses
  // it into `phase` (passed → streaming). Derive one answer from either source.
  const outcome = meta.outcome ?? (meta.phase === 'streaming' ? 'passed' : undefined)
  const waiting = isHandoff && outcome !== 'passed'
  const tone: CardTone = waiting ? 'attention' : meta.refusal ? 'refused' : 'ok'
  const vendor = meta.challenge?.vendor

  const title = isHandoff
    ? waiting
      ? 'your turn — agent paused'
      : `handoff → ${outcome ?? 'done'}`
    : vendor
      ? `challenge: ${vendor}`
      : 'no challenge'

  const detail = [
    meta.challenge?.blocking ? 'blocking' : null,
    meta.url ? shortenUrl(meta.url) : null,
    waiting ? 'solve it in the panel, then resume' : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <CardRow tone={tone} onClick={props.openPanel} title={title} detail={detail || meta.summary} cue={waiting ? 'solve' : 'view'} pulse={waiting}>
      {vendor ? <Badge tone={waiting ? 'attention' : 'neutral'}>{vendor}</Badge> : null}
      {meta.refusal ? <Badge tone="refused">{meta.refusal.reason}</Badge> : null}
    </CardRow>
  )
}

// ── shared row ──────────────────────────────────────────────────────────────

export type CardTone = 'ok' | 'busy' | 'attention' | 'error' | 'refused'

const TONE_COLORS: Record<CardTone, { fg: string; border: string; bg: string }> = {
  ok: { fg: '#3fb950', border: 'rgba(63,185,80,0.26)', bg: 'rgba(63,185,80,0.07)' },
  busy: { fg: '#58a6ff', border: 'rgba(88,166,255,0.26)', bg: 'rgba(88,166,255,0.07)' },
  attention: { fg: '#d29922', border: 'rgba(210,153,34,0.32)', bg: 'rgba(210,153,34,0.09)' },
  error: { fg: '#f85149', border: 'rgba(248,81,73,0.3)', bg: 'rgba(248,81,73,0.08)' },
  refused: { fg: '#8a8a94', border: 'rgba(128,128,128,0.24)', bg: 'rgba(128,128,128,0.06)' },
}

interface CardRowProps {
  tone: CardTone
  title: string
  detail: string
  cue: string
  onClick(): void
  children?: ReactNode
  pulse?: boolean
  /** Marks the row as the affordance that opens the SIDE dashboard. */
  sideToggle?: boolean
}

function CardRow(props: CardRowProps): ReactNode {
  const palette = TONE_COLORS[props.tone]
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={props.onClick}
      onKeyDown={event => {
        // Keyboard parity with the mouse: the card is the only way to reach the
        // panel from a past tool call, so it must be reachable without a pointer.
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          props.onClick()
        }
      }}
      style={{
        ...CARD_STYLES.row,
        borderColor: palette.border,
        background: palette.bg,
        ...(props.pulse ? { animation: 'dsh-browser-attention 2s ease-out infinite' } : {}),
      }}
      {...(props.sideToggle ? { 'data-dsh-side-toggle': 'true' } : {})}
      title="open the live browser panel"
    >
      <span style={{ ...CARD_STYLES.title, color: palette.fg, flex: '0 0 auto' }}>{props.title}</span>
      <span style={CARD_STYLES.detail}>{props.detail}</span>
      {props.children}
      <span style={CARD_STYLES.cue}>{props.cue} ↗</span>
    </div>
  )
}

function EmptyCard({ label, detail }: { label: string; detail: string }): ReactNode {
  return (
    <div style={{ ...CARD_STYLES.row, cursor: 'default' }}>
      <span style={CARD_STYLES.title}>{label}</span>
      <span style={CARD_STYLES.detail}>{detail}</span>
    </div>
  )
}

type BadgeTone = 'ok' | 'warn' | 'neutral' | 'attention' | 'refused'

function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }): ReactNode {
  const color: Record<BadgeTone, string> = { ok: '#3fb950', warn: '#d29922', attention: '#d29922', neutral: '#8a8a94', refused: '#f85149' }
  const fg = color[tone]
  return <span style={{ ...CARD_STYLES.badge, color: fg, border: `1px solid ${fg}55`, background: `${fg}14` }}>{children}</span>
}

/** A short human-readable description of an action target. */
export function describeTarget(target: NonNullable<HydratedMeta['target']>): string {
  const name = target.name?.trim()
  const role = target.role?.trim()
  if (name && role) return `${role} “${truncate(name, 32)}”`
  if (name) return truncate(name, 40)
  if (role) return role
  if (target.ref) return `ref ${target.ref}`
  return ''
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}
