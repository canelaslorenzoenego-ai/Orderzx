/**
 * Browser presentation for the dsh-browser tools.
 *
 * Registers `tool.call.toolview` slots for the tools that emit visual
 * `presentationMeta`, a stream-status capsule in `conversation.input.dock`, and
 * mounts the page-owned right panel that the capsule and cards both open.
 *
 * The division of labour matches dsh-android exactly, because DSH 0.1.5 offers
 * the same (limited) set of seats:
 *
 *   inline tool card  compact one-line summary — title, phase, badge, and an
 *                     "open in sidebar" cue. NO imagery inline: a 5 fps stream
 *                     thumbnail in the conversation is noise and a context sink.
 *   right panel       the live browser. Page-owned, docked by margin lease.
 *   input dock        the capsule with the monitor boot animation.
 *
 * Every registered view is wrapped in an error boundary so a throwing slot
 * component can never take down the conversation — a panel plugin that blanks
 * the user's chat is worse than no plugin.
 *
 * Nested Code Mode (PTC) calls carry NO `presentationMeta` (the harness projects
 * it only for top-level calls), so `meta-hydrate.ts` rebuilds the identical meta
 * from the settled result's durable JSON text. Standard-mode sessions are
 * untouched by that path.
 *
 * @module @dsh-community/dsh-browser/client
 */

import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { CARD_TOOLS } from '../protocol.js'
import type { HydratedMeta } from './meta-hydrate.js'
import { browserPanelStore, mountBrowserPanelHost, usePanelRequest, type PanelHost, type PanelRequest } from './panel-host.js'
import { panelAutoOpenAllowed } from './panel-dock.js'
import { StatusCapsule, installCapsuleKeyframes } from './status-capsule.js'
import { resolveBrowserMeta } from './meta-hydrate.js'
import { CardBoundary } from './card-boundary.js'
import { BootCard, BrowserCard, ChallengeCard, type BrowserCardProps } from './cards.js'

// Re-exported so the smoke suites exercise the built bundle's real exports.
export * from './wire.js'
export * from './boot-sequence.js'
export * from './panel-dock.js'
export * from './meta-hydrate.js'
export { BrowserFrame, FRAME_STYLE_CHROME, FRAME_STYLE_MINIMAL, FRAME_STYLE_FRAMELESS, FRAME_STYLE_OPTIONS, WINDOW_SHELL_STYLES, frameTierLabel, phaseTone, prettyHost, type FrameStyle } from './browser-frame.js'
export { LiveViewport, useStreamSession, normalizePointer, STALL_MIN_MS, STALL_MULTIPLIER, STATUS_POLL_MS, STREAM_PHASES, type StreamPhase, type StreamSession } from './live-viewport.js'
export { StatusCapsule, MonitorGlyph, CAPSULE_KEYFRAMES, CAPSULE_POLL_MS, capsuleStyles, autoOpenDecision, createCapsulePoller, installCapsuleKeyframes } from './status-capsule.js'
export { captionOfEvent } from '../interactions.js'
export { compatMode, PROTOCOL_VERSION } from '../compat.js'
export { browserPanelStore, createPanelStore, mountBrowserPanelHost, usePanelRequest, shouldRetractPanel, PANEL_RETRACT_IDLE_MS, PANEL_RETRACT_CHECK_MS, type PanelHost, type PanelRequest, type PanelStore } from './panel-host.js'
export { BrowserCard, BootCard, ChallengeCard, describeTarget, type BrowserCardProps, type CardTone } from './cards.js'
export {
  InlineLiveFrame, inlineLiveDecision, activitySignature,
  INLINE_IDLE_COLLAPSE_MS, INLINE_CHECK_MS, INLINE_FRAME_HEIGHT,
  dashboardZoomHeight, DASHBOARD_ZOOMS,
  type InlineMode, type InlineLiveDecision, type InlineLiveFrameProps, type DashboardZoom,
} from './inline-live.js'
export { CARD_STYLES } from './card-styles.js'
export { CardBoundary } from './card-boundary.js'
export {
  InteractionOverlay, applyInteraction, pruneOverlay, resetOverlay, OVERLAY_TTL,
  type OverlayState, type ClickPulse, type FocusRing, type GestureTrail, type ToastMessage,
} from './interaction-overlay.js'
export { DebugDrawer, SessionTabStrip, TimelineDrawer, originAvatar, type DebugDrawerProps, type SessionTabStripProps, type TimelineDrawerProps } from './session-tabs.js'
export { HomeTab, readMru, pushMru, type HomeTabProps } from './home-tab.js'
export { PANEL_NARROW_PX } from './panel-host.js'

// ── slot plumbing ───────────────────────────────────────────────────────────

/** Minimal structural face of the host's slots service. */
interface SlotsLike {
  inject(seat: string, factory: () => unknown): void
  register(entry: { name: string; key?: string; id?: string; order?: number }, component: unknown): () => void
}

type ClientContextWithSlots = ClientContext & { slots?: SlotsLike }

/**
 * Register one `tool.call.toolview` slot per tool name.
 *
 * The seat is keyed by TOOL NAME, which is why a card cannot be registered for
 * "any browser tool" — each verb needs its own entry. Registering a slot for a
 * tool that emits no `presentationMeta` renders an empty box, so only the five
 * in `CARD_TOOLS` get one.
 */
function registerCard(ctx: ClientContext, toolName: string, Card: (props: BrowserCardProps) => ReactNode, autoOpen?: (request: PanelRequest) => void): void {
  const slots = (ctx as ClientContextWithSlots).slots
  if (!slots || typeof slots.inject !== 'function') return
  slots.inject('tool.call.toolview', () =>
    slots.register({ name: 'tool.call.toolview', key: toolName }, hostSyncedCard(Card, autoOpen)),
  )
}

/**
 * Wrap a card so it hydrates meta from either source and never throws upward.
 *
 * `props.meta` is present for top-level calls and absent for nested PTC calls;
 * `hydrateMeta` resolves both to the same shape so the card body has one code
 * path.
 */
function hostSyncedCard(
  Card: (props: BrowserCardProps) => ReactNode,
  autoOpen?: (request: PanelRequest) => void,
): (props: ToolCallViewProps) => ReactNode {
  return function DshBrowserCard(props: ToolCallViewProps): ReactNode {
    // One resolution for both worlds: host-projected presentationMeta wins;
    // nested PTC calls rebuild the identical meta from the durable JSON text.
    const [resolved] = useState(() => resolveBrowserMeta(props.toolName, props.block))
    const meta = resolved?.meta
    const sessionId = String(props.sessionId ?? '')
    const open = useCallback(() => {
      const request: PanelRequest = {
        sessionId,
        ...(meta?.sessionId ? { browserSession: meta.sessionId } : {}),
        origin: 'card',
      }
      browserPanelStore.open(request)
    }, [sessionId, meta])

    return (
      <CardBoundary label={props.toolName}>
        <Card {...({ ...props, meta, openPanel: open } as BrowserCardProps)} />
        {meta && autoOpen ? <AutoOpen meta={meta} sessionId={sessionId} autoOpen={autoOpen} /> : null}
      </CardBoundary>
    )
  }
}

/**
 * Auto-open on a settled START verb.
 *
 * `openIfIdle`, never `open`: a settling `browser_start` must not replace a panel
 * the user already opened on something else. Rendered as a null component so the
 * side effect lives in an `useEffect` with correct cleanup rather than in render.
 */
function AutoOpen({ meta, sessionId, autoOpen }: { meta: HydratedMeta; sessionId: string; autoOpen: (request: PanelRequest) => void }): null {
  useEffect(() => {
    if (meta.tool !== CARD_TOOLS.start) return
    // Narrow screens: the inline live frame in the chat IS the watch surface;
    // auto-popping a sheet over the conversation is the "it covers my chat"
    // complaint. The panel still opens on an explicit tap.
    if (!panelAutoOpenAllowed(currentViewportWidth())) return
    autoOpen({ sessionId, ...(meta.sessionId ? { browserSession: meta.sessionId } : {}), origin: 'boot' })
  }, [meta, sessionId, autoOpen])
  return null
}

/** SSR-safe viewport width; servers report "wide" so gating never hides panels in tests. */
export function currentViewportWidth(): number {
  return typeof window === 'undefined' ? Number.POSITIVE_INFINITY : window.innerWidth
}

// ── capsule ─────────────────────────────────────────────────────────────────

interface InputDockProps {
  sessionId: string
}

/**
 * The chatbar capsule.
 *
 * Hides itself while the panel is open — showing both would be two indicators
 * for one thing, and the panel is strictly more informative.
 */
/** Pause between the capsule pop and the dashboard extend. */
export const AUTO_OPEN_DELAY_MS = 420

let autoOpenTimer: ReturnType<typeof setTimeout> | undefined

function hostSyncedStatusCapsule(): (props: InputDockProps) => ReactNode {
  return function DshBrowserStatusCapsule(props: InputDockProps): ReactNode {
    const open = usePanelRequest()
    useEffect(() => {
      if (typeof document !== 'undefined') installCapsuleKeyframes(document)
    }, [])
    return (
      <StatusCapsule
        sessionId={props.sessionId}
        panelOpen={open !== undefined}
        onOpen={() => browserPanelStore.open({ sessionId: props.sessionId, origin: 'capsule' })}
        onAutoOpen={() => {
          // Let the capsule's pop-in play (~320ms) BEFORE the dashboard starts
          // extending — the two animations read as one sequence, not a collision.
          // openIfIdle, never open: if the user already opened the panel (or a
          // card beat us to it), a boot must not replace what they are looking at.
          if (autoOpenTimer !== undefined) clearTimeout(autoOpenTimer)
          autoOpenTimer = setTimeout(() => {
            autoOpenTimer = undefined
            // Checked at FIRE time: the phone may have rotated / resized since
            // the capsule popped. Narrow → the inline frame is the surface.
            if (!panelAutoOpenAllowed(currentViewportWidth())) return
            browserPanelStore.openIfIdle({ sessionId: props.sessionId, origin: 'boot' })
          }, AUTO_OPEN_DELAY_MS)
        }}
      />
    )
  }
}

// ── client entry ────────────────────────────────────────────────────────────

export const name = 'dsh-browser-client'

export function apply(ctx: ClientContext): void {
  let panelHost: PanelHost | undefined

  // Cards: boot, observation, click, and the two challenge verbs.
  registerCard(ctx, CARD_TOOLS.start, BootCard, request => panelHost?.openIfIdle(request))
  registerCard(ctx, CARD_TOOLS.observe, BrowserCard)
  registerCard(ctx, CARD_TOOLS.click, BrowserCard)
  registerCard(ctx, CARD_TOOLS.challenge, ChallengeCard)
  registerCard(ctx, CARD_TOOLS.handoff, ChallengeCard, request => panelHost?.open(request))

  // Capsule in the composer dock. `order: 40` sits it after the host's own chips
  // and after dsh-android's pill (also 40) without colliding visually — the dock
  // is a flex row, so order only decides sequence.
  const slots = (ctx as ClientContextWithSlots).slots
  if (slots && typeof slots.inject === 'function') {
    slots.inject('conversation.input.dock', () =>
      slots.register({ name: 'conversation.input.dock', id: 'dsh-browser-status', order: 40 }, hostSyncedStatusCapsule()),
    )
  }

  if (typeof document !== 'undefined') {
    ctx.effect(() => {
      panelHost = mountBrowserPanelHost({
        // Theme/locale bridges are optional; the panel falls back to the
        // `--dsw-*` custom properties and its own defaults.
        ...(themeBridge(ctx) ?? {}),
      })
      return () => {
        panelHost?.dispose()
        panelHost = undefined
      }
    }, 'dsh-browser: panel host')
  }
}

/**
 * Bridge the host theme service into the panel host options.
 *
 * Reached defensively: `ctx.get` returns undefined for an absent service, and a
 * plugin that throws on a theme service it does not need would be a bad guest.
 */
function themeBridge(ctx: ClientContext): { subscribeTheme?: (l: () => void) => () => void; getColorScheme?: () => 'light' | 'dark' | undefined } | undefined {
  const get = (ctx as unknown as { get?: (name: string) => unknown }).get
  if (typeof get !== 'function') return undefined
  const theme = get.call(ctx, 'theme') as
    | { subscribe?: (listener: () => void) => () => void; getColorScheme?: () => 'light' | 'dark' | undefined }
    | undefined
  if (!theme) return undefined
  return {
    ...(typeof theme.subscribe === 'function' ? { subscribeTheme: theme.subscribe.bind(theme) } : {}),
    ...(typeof theme.getColorScheme === 'function' ? { getColorScheme: theme.getColorScheme.bind(theme) } : {}),
  }
}
