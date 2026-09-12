/**
 * The boot sequence state machine.
 *
 * This is the thing the user actually asked for, and it is worth being precise
 * about because it is a sequence, not a status indicator:
 *
 *   1. CAPSULE — a small monitor animation in the chatbar dock, spinning up.
 *   2. EXTEND  — the dashboard extends: the panel host slides in and takes width.
 *   3. LIVE    — the frame stream connects and the browser is on screen.
 *
 * The host publishes `BootPhase` transitions (launching → warming-profile →
 * applying-stealth → ready → streaming). Those are the *cause*; the three stages
 * above are the *presentation*. Mapping one to the other in a pure function is
 * what keeps the animation correct under the two conditions that break naive
 * implementations:
 *
 *   - **Out-of-order / skipped phases.** A warm start skips `launching` entirely
 *     and lands on `ready`. The stage machine must not get stuck waiting for a
 *     phase it will never see.
 *   - **Replays.** The Trajectory view can replay a settled session, so the same
 *     phase sequence arrives instantly with no browser behind it. Stages must
 *     advance monotonically and never re-animate.
 *
 * Stages therefore only ever move FORWARD, except on an explicit reset (a new
 * session, or an error the user dismisses).
 *
 * Everything here is pure — no timers, no DOM, no React — so the smoke suite can
 * drive a whole boot with an array of phases and assert the stage timeline.
 *
 * @module @dsh-community/dsh-browser/client/boot-sequence
 */

import { BOOT_PHASES } from '../protocol.js'
import type { BootPhase } from '../protocol.js'

/** The three presentation stages. */
export const BOOT_STAGES = ['capsule', 'extend', 'live'] as const
export type BootStage = (typeof BOOT_STAGES)[number]

/** A stage index, so "only forward" is a number comparison. */
export const STAGE_INDEX: Record<BootStage, number> = { capsule: 0, extend: 1, live: 2 }

/** Sub-steps within a stage, for the capsule's own animation. */
export const CAPSULE_STEPS = ['spinning-up', 'warming', 'hardening', 'connecting'] as const
export type CapsuleStep = (typeof CAPSULE_STEPS)[number]

/** Which host phase maps to which capsule sub-step. */
const PHASE_TO_STEP: Partial<Record<BootPhase, CapsuleStep>> = {
  launching: 'spinning-up',
  'warming-profile': 'warming',
  'applying-stealth': 'hardening',
  ready: 'connecting',
  navigating: 'connecting',
  streaming: 'connecting',
}

/**
 * The whole observable state of a boot.
 *
 * `stage` drives layout, `step` drives the capsule's animation, `paused` and
 * `challenge` drive the banner, `owner` drives whether input is forwarded.
 */
export interface BootState {
  stage: BootStage
  step: CapsuleStep
  phase: BootPhase
  /** True while the panel is mid-slide-in. The host panel animates off this. */
  extending: boolean
  /** The stream connected at least once, so a drop is a RECONNECT not a boot. */
  hasConnected: boolean
  /** A human owns the pointer. */
  owner: 'agent' | 'user' | null
  /** A challenge is awaiting the human. */
  challenge: { vendor: string; blocking: boolean; id: string } | null
  error: string | null
  /** Monotonic; used to key animations so a replay does not restart them. */
  revision: number
}

export const IDLE_BOOT_STATE: BootState = {
  stage: 'capsule',
  step: 'spinning-up',
  phase: 'idle',
  extending: false,
  hasConnected: false,
  owner: null,
  challenge: null,
  error: null,
  revision: 0,
}

/**
 * Advance the boot state from a host phase.
 *
 * Pure and total: every `BootPhase` produces a state, including the ones that
 * mean "something went wrong". Never throws.
 */
export function reducePhase(state: BootState, phase: BootPhase): BootState {
  const next: BootState = { ...state, phase }

  switch (phase) {
    case 'idle':
      // A fresh idle is a reset; an idle after `closing` is a completed shutdown.
      return { ...IDLE_BOOT_STATE, revision: state.revision }

    case 'launching':
    case 'warming-profile':
    case 'applying-stealth':
      // Stage 1: the capsule animates. The panel is not open yet.
      return {
        ...next,
        stage: atLeast(state.stage, 'capsule'),
        step: PHASE_TO_STEP[phase] ?? state.step,
        extending: false,
        error: null,
        revision: state.revision + 1,
      }

    case 'ready':
      // Stage 2: the dashboard is extended (width lease claimed). The slide-in
      // ANIMATION is owned by the panel's mount, not by this reducer: with the
      // capsule-triggered auto-open the panel is already on screen during
      // 'launching', so setting `extending` here would play the 180ms transform
      // OUT to translateX(100%) and then bounce back in — a visible glitch.
      // Mount paints off-screen, a rAF clears it, and the panel slides in once.
      return {
        ...next,
        stage: atLeast(state.stage, 'extend'),
        step: 'connecting',
        extending: false,
        error: null,
        revision: state.revision + 1,
      }

    case 'navigating':
      // Already live or about to be; keep the stage, keep the spinner.
      return { ...next, stage: atLeast(state.stage, 'extend'), step: 'connecting' }

    case 'streaming':
      // Stage 3: frames. `hasConnected` makes a later drop a reconnect.
      return {
        ...next,
        stage: 'live',
        step: 'connecting',
        extending: false,
        hasConnected: true,
        error: null,
        revision: state.revision + 1,
      }

    case 'paused':
      return { ...next, stage: atLeast(state.stage, 'live'), extending: false }

    case 'handoff':
    case 'takeover':
      // The human owns the pointer. The stage stays `live` — they need to SEE it
      // to do anything — but ownership flips so input starts forwarding.
      return {
        ...next,
        stage: 'live',
        extending: false,
        owner: 'user',
        revision: state.revision + 1,
      }

    case 'closing':
      return { ...next, extending: false, owner: null, challenge: null }

    case 'error':
      return {
        ...next,
        // Do not collapse the panel on error: the user needs to read what
        // happened, and the last frame is often the explanation.
        extending: false,
        owner: null,
        revision: state.revision + 1,
      }

    default:
      return next
  }
}

/** Fold a `/status` response into the boot state. */
export function reduceStatus(
  state: BootState,
  status: {
    phase: BootPhase
    takeover?: { since: number; by: 'user' | 'agent-handoff' }
    challenge?: { id: string; vendor: string; blocking: boolean; state?: string }
    error?: { message: string }
  },
): BootState {
  let next = reducePhase(state, status.phase)
  next = {
    ...next,
    owner: status.takeover ? 'user' : next.phase === 'takeover' || next.phase === 'handoff' ? 'user' : 'agent',
    challenge:
      status.challenge && status.challenge.state !== 'resolved'
        ? { id: status.challenge.id, vendor: status.challenge.vendor, blocking: status.challenge.blocking }
        : null,
    error: status.error?.message ?? next.error,
  }
  // No further owner fixups: the ternary above already derives ownership from
  // (explicit takeover, phase) on every status poll. An extra "hand back the
  // pointer" clause here once clobbered a live `takeover` field the moment the
  // phase returned to streaming — the panel showed the agent driving while the
  // user held the mouse.
  return next
}

/** The panel finished sliding in. */
export function reduceExtended(state: BootState): BootState {
  return state.extending ? { ...state, extending: false } : state
}

/** The stream dropped. Distinct from an error: we keep the last frame. */
export function reduceDisconnected(state: BootState, reason: string): BootState {
  return { ...state, error: state.hasConnected ? null : reason, step: 'connecting' }
}

/** A new session, or the user dismissed an error. */
export function resetBoot(revision = 0): BootState {
  return { ...IDLE_BOOT_STATE, revision }
}

// ── derived presentation ────────────────────────────────────────────────────

/**
 * The capsule's one-line label.
 *
 * Kept here rather than in the component so the copy is testable and so the
 * capsule and the panel header cannot disagree about what phase means.
 */
export function bootLabel(state: BootState): string {
  if (state.error) return 'browser error'
  if (state.challenge) return `${state.challenge.vendor} — needs you`
  if (state.owner === 'user') return 'you are driving'
  switch (state.phase) {
    case 'idle': return 'browser idle'
    case 'launching': return 'starting chrome…'
    case 'warming-profile': return 'warming profile…'
    case 'applying-stealth': return 'applying stealth…'
    case 'ready': return 'connecting stream…'
    case 'navigating': return 'navigating…'
    case 'streaming': return 'live'
    case 'paused': return 'paused'
    case 'handoff': return 'captcha — needs you'
    case 'takeover': return 'you are driving'
    case 'closing': return 'closing…'
    case 'error': return 'browser error'
    default: return 'browser'
  }
}

/** Capsule dot colour. `null` means "do not render a capsule at all". */
export function capsuleTone(state: BootState): 'busy' | 'live' | 'attention' | 'error' | null {
  if (state.error) return 'error'
  if (state.challenge) return 'attention'
  if (state.owner === 'user') return 'attention'
  if (state.phase === 'idle' || state.phase === 'closing') return null
  if (state.stage === 'live' && state.phase === 'streaming') return 'live'
  return 'busy'
}

/**
 * Should the panel be open?
 *
 * Mirrors dsh-android's `openIfIdle` discipline: a boot opens the panel once,
 * but a later phase transition must never replace a panel the user deliberately
 * closed or repointed. The caller owns that decision; this only answers "is this
 * phase a start verb settling".
 */
export function shouldAutoOpen(previous: BootPhase, next: BootPhase): boolean {
  // Only a transition INTO `ready`/`streaming` from a pre-live phase auto-opens.
  const wasPreLive = previous === 'idle' || previous === 'launching' || previous === 'warming-profile' || previous === 'applying-stealth'
  const isLive = next === 'ready' || next === 'streaming'
  return wasPreLive && isLive
}

/** Stages only ever advance. */
function atLeast(current: BootStage, minimum: BootStage): BootStage {
  return STAGE_INDEX[current] >= STAGE_INDEX[minimum] ? current : minimum
}

/**
 * The capsule's monitor glyph animation frame, 0..3.
 *
 * A tiny CRT monitor with a sweeping scanline. Four frames is enough to read as
 * motion at the capsule's size and cheap enough to drive from a CSS animation
 * instead of JS — this function exists for the SVG-in-attribute case where CSS
 * keyframes cannot reach inside a data URI.
 */
export function monitorGlyphFrame(step: CapsuleStep, tick: number): number {
  const speed = step === 'spinning-up' ? 1 : step === 'warming' ? 2 : step === 'hardening' ? 3 : 4
  return (tick * speed) % 4
}

/**
 * Fold a card's `presentationMeta` into the boot state.
 *
 * The card, the capsule and the panel must agree on wording: a card reading
 * "browser live" while the capsule says "starting" would look broken even though
 * both are true of different moments. Routing all three through this one reducer
 * is what guarantees they cannot disagree.
 *
 * Pure and total — never throws on a partial or unknown meta.
 */
export function reduceMeta(state: BootState, meta: {
  phase?: BootPhase
  url?: string | null
  title?: string | null
  summary?: string | null
  sessionId?: string | null
  challenge?: { vendor?: string | null; blocking?: boolean | null; id?: string | null } | null
}): BootState {
  let next = state
  const phase = meta.phase
  if (typeof phase === 'string' && BOOT_PHASES.includes(phase as BootPhase)) {
    next = reducePhase(next, phase as BootPhase)
  }
  if (meta.challenge && meta.challenge.vendor) {
    next = {
      ...next,
      challenge: {
        vendor: meta.challenge.vendor,
        blocking: meta.challenge.blocking === true,
        id: meta.challenge.id ?? 'inline',
      },
    }
  } else if (next.challenge && next.challenge.id === 'inline') {
    // The inline challenge marker came from a card, not from /status; clear it
    // when a later card reports none, but never clear a host-reported one.
    next = { ...next, challenge: null }
  }
  return next
}
