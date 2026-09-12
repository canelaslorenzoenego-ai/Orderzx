/**
 * Rebuild `BrowserMeta` from a tool result's durable JSON.
 *
 * Why this file exists: nested Code Mode (PTC) calls carry NO `presentationMeta`.
 * The harness projects `output.presentationMeta` only for top-level calls, so a
 * card rendered for a `browser_start` invoked from inside a PTC block would have
 * nothing to show. The canonical result JSON is still fully available, so the
 * identical meta is reconstructed from it.
 *
 * This is the client-side twin of `captureMeta` in src/tool-support.ts and of the
 * inline `presentationMeta` closures in src/tools.ts. Those five closures and the
 * `fromResult` switch below MUST agree field-for-field — a card that shows less in
 * PTC mode than in standard mode is a bug nobody will report, because both modes
 * look like they "worked".
 *
 * The result field names differ per tool (`session` on start, `detection.vendor`
 * on challenge, `outcome` on handoff), so `fromResult` dispatches on the tool name
 * rather than probing for every possible key. Probing would silently pick up a
 * same-named field from the wrong tool.
 *
 * @module @dsh-community/dsh-browser/client/meta-hydrate
 */

import type { BootPhase, BrowserMeta, ChallengeRecord, ToolName } from '../protocol.js'
import { BOOT_PHASES, CARD_TOOLS } from '../protocol.js'

/** Meta plus what the card needs to render a refusal or a PTC replay honestly. */
export interface HydratedMeta extends BrowserMeta {
  /** True when rebuilt from result JSON rather than delivered as presentationMeta. */
  replayed: boolean
  /** Refusal detail, so a card can say WHY instead of just "refused". */
  refusal?: { reason: string; message?: string }
  /** Handoff outcome, distinct from phase because phase collapses it. */
  outcome?: string
}

/**
 * The settled tool-result block, as delivered on `ToolCallViewProps.block`.
 *
 * Typed structurally (not via `ToolCallBlock` from dsh-client-ui-chat) because
 * that package is a type-only peer the plugin does not depend on, and because a
 * structural reader degrades gracefully across host versions: unknown shapes
 * resolve `undefined` and the cards fall back to their empty state instead of
 * throwing inside someone else's render tree.
 */
export interface SettledBlockLike {
  kind?: string
  isError?: boolean
  /** Host-projected presentationMeta (top-level calls only). */
  meta?: unknown
  /** Durable content; the canonical result rides as JSON text. */
  content?: Array<{ type?: string; text?: string }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate a wire tool name against the five card tools. */
export function cardToolOf(toolName: string): ToolName | undefined {
  const known = Object.values(CARD_TOOLS) as string[]
  return known.includes(toolName) ? (toolName as ToolName) : undefined
}

/**
 * The single meta resolution every card and the panel share.
 *
 * The host-projected `presentationMeta` ALWAYS wins (standard-mode sessions are
 * untouched by the replay path); a nested Code Mode (PTC) result — which carries
 * no projection — reconstructs the identical meta from its durable JSON text.
 * Unsettled or error blocks resolve `undefined`; this never throws.
 */
export function resolveBrowserMeta(
  toolName: string,
  block: SettledBlockLike | unknown,
): { meta: HydratedMeta; source: 'meta' | 'hydrated' } | undefined {
  if (!isRecord(block)) return undefined
  const settled = block as SettledBlockLike
  if (settled.kind !== 'tool-result' || settled.isError === true) return undefined

  const tool = cardToolOf(toolName)
  const projected = isRecord(settled.meta) ? normalizeMeta(settled.meta as Partial<BrowserMeta>, tool) : undefined
  if (projected) return { meta: { ...projected, replayed: false }, source: 'meta' }
  if (!tool) return undefined

  for (const item of Array.isArray(settled.content) ? settled.content : []) {
    if (!isRecord(item) || item.type !== 'text' || typeof item.text !== 'string') continue
    let value: unknown
    try {
      value = JSON.parse(item.text)
    } catch {
      continue
    }
    if (!isRecord(value)) continue
    const hydrated = fromResult(tool, value)
    if (hydrated) return { meta: hydrated, source: 'hydrated' }
  }
  return undefined
}

/**
 * Rebuild meta from a canonical tool result, per tool.
 *
 * Mirrors the `presentationMeta` closure registered for that same tool in
 * src/tools.ts. Keep the field mapping identical.
 */
export function fromResult(tool: ToolName, value: Record<string, unknown>): HydratedMeta | undefined {
  const ok = booleanAt(value, 'ok')
  const refused = stringAt(value, 'refused')
  const message = stringAt(value, 'message')
  const refusal = refused ? { reason: refused, ...(message ? { message } : {}) } : undefined

  switch (tool) {
    case CARD_TOOLS.start: {
      // tools.ts: { tool, phase, sessionId: record.session, url, summary }
      const sessionId = stringAt(value, 'session')
      const url = stringAt(value, 'url')
      const label = stringAt(value, 'label')
      const phase = phaseAt(value, 'phase') ?? 'streaming'
      const summary = ok === true
        ? `browser live${label ? ` · ${label}` : ''}${url ? ` · ${url}` : ''}`
        : `start refused: ${message ?? refused ?? '?'}`
      return finish({ tool, phase, ...(sessionId ? { sessionId } : {}), ...(label ? { label } : {}), ...(url ? { url } : {}), summary }, refusal)
    }

    case CARD_TOOLS.observe: {
      // tool-support.captureMeta: url/title/capturePath/viewport→width+height/inline challenge
      const url = stringAt(value, 'url')
      const title = stringAt(value, 'title')
      const capturePath = stringAt(value, 'capturePath')
      const viewport = objectAt(value, 'viewport')
      const width = numberAt(viewport, 'width')
      const height = numberAt(viewport, 'height')
      const challenge = challengeAt(value)
      return finish(
        {
          tool,
          phase: 'streaming',
          ...(url ? { url } : {}),
          ...(title ? { title } : {}),
          ...(capturePath ? { capturePath } : {}),
          ...(width !== undefined ? { width } : {}),
          ...(height !== undefined ? { height } : {}),
          ...(challenge ? { challenge } : {}),
          summary: url ? url.slice(0, 90) : 'observation',
        },
        refusal,
      )
    }

    case CARD_TOOLS.click: {
      // tools.ts: { tool, phase:'streaming', url, capturePath, summary }
      const url = stringAt(value, 'url')
      const capturePath = stringAt(value, 'capturePath')
      const target = stringAt(value, 'target') ?? 'point'
      return finish(
        {
          tool,
          phase: 'streaming',
          ...(url ? { url } : {}),
          ...(capturePath ? { capturePath } : {}),
          summary: ok === true ? `clicked ${target}` : `click refused: ${message ?? refused ?? '?'}`,
        },
        refusal,
      )
    }

    case CARD_TOOLS.challenge: {
      // tools.ts: { tool, phase:'handoff', summary } from record.detection
      const detection = objectAt(value, 'detection')
      const present = booleanAt(detection, 'present') === true
      const vendor = stringAt(detection, 'vendor')
      const blocking = booleanAt(detection, 'blocking') === true
      return finish(
        {
          tool,
          phase: 'handoff',
          ...(present && vendor
            ? {
                challenge: {
                  id: 'inline',
                  vendor: vendor as ChallengeRecord['vendor'],
                  blocking,
                  resolvedBy: 'unresolved',
                  outcome: 'pending',
                },
              }
            : {}),
          summary: present ? `challenge: ${vendor}${blocking ? ' (blocking)' : ''}` : 'no challenge',
        },
        refusal,
      )
    }

    case CARD_TOOLS.handoff: {
      // tools.ts: { tool, phase: outcome==='passed'?'streaming':'handoff', url, summary }
      const outcome = stringAt(value, 'outcome')
      const url = stringAt(value, 'url')
      return finish(
        {
          tool,
          phase: outcome === 'passed' ? 'streaming' : 'handoff',
          ...(url ? { url } : {}),
          summary: ok === true ? `handoff → ${outcome}` : `handoff refused: ${message ?? refused ?? '?'}`,
        },
        refusal,
        outcome,
      )
    }

    default:
      return undefined
  }
}

function finish(meta: BrowserMeta, refusal?: { reason: string; message?: string }, outcome?: string): HydratedMeta {
  return { ...meta, replayed: true, ...(refusal ? { refusal } : {}), ...(outcome ? { outcome } : {}) }
}

/** Read the inline challenge marker off an observe result. */
function challengeAt(value: Record<string, unknown>): BrowserMeta['challenge'] | undefined {
  const challenge = objectAt(value, 'challenge')
  if (!challenge || booleanAt(challenge, 'present') !== true) return undefined
  const vendor = stringAt(challenge, 'vendor')
  if (!vendor) return undefined
  return {
    id: 'inline',
    vendor: vendor as ChallengeRecord['vendor'],
    blocking: booleanAt(challenge, 'blocking') === true,
    resolvedBy: 'unresolved',
    outcome: 'pending',
  }
}

/**
 * Validate and clamp a candidate meta.
 *
 * Enum members are checked against the shared constants rather than trusted:
 * presentationMeta is written by this plugin, but a version skew between the host
 * bundle and the client bundle would otherwise render an unknown phase string
 * straight into the UI.
 */
export function normalizeMeta(candidate: Partial<BrowserMeta>, tool?: ToolName): BrowserMeta | undefined {
  if (!candidate || typeof candidate !== 'object') return undefined
  const resolvedTool = candidate.tool ?? tool
  if (!resolvedTool) return undefined
  const phase = candidate.phase
  if (!phase || !BOOT_PHASES.includes(phase)) return undefined
  if (typeof candidate.summary !== 'string' || candidate.summary.length === 0) return undefined

  const meta: BrowserMeta = {
    tool: resolvedTool,
    phase: phase as BootPhase,
    summary: candidate.summary,
    ...(candidate.sessionId ? { sessionId: candidate.sessionId } : {}),
    ...(candidate.label ? { label: candidate.label } : {}),
    ...(candidate.url ? { url: candidate.url } : {}),
    ...(candidate.title ? { title: candidate.title } : {}),
    ...(candidate.capturePath ? { capturePath: candidate.capturePath } : {}),
    ...(typeof candidate.width === 'number' && Number.isFinite(candidate.width) ? { width: Math.round(candidate.width) } : {}),
    ...(typeof candidate.height === 'number' && Number.isFinite(candidate.height) ? { height: Math.round(candidate.height) } : {}),
    ...(candidate.target ? { target: normalizeTarget(candidate.target) } : {}),
    ...(candidate.challenge?.vendor ? { challenge: normalizeChallenge(candidate.challenge) } : {}),
  }
  return meta
}

function normalizeTarget(target: NonNullable<BrowserMeta['target']>): NonNullable<BrowserMeta['target']> {
  const box = target.box
  return {
    ref: String(target.ref ?? ''),
    role: String(target.role ?? ''),
    name: String(target.name ?? ''),
    ...(box && Number.isFinite(box.x) && Number.isFinite(box.y) && Number.isFinite(box.w) && Number.isFinite(box.h)
      ? { box: { x: box.x, y: box.y, w: box.w, h: box.h } }
      : {}),
  }
}

function normalizeChallenge(challenge: NonNullable<BrowserMeta['challenge']>): NonNullable<BrowserMeta['challenge']> {
  return {
    id: challenge.id ?? 'inline',
    vendor: challenge.vendor,
    blocking: challenge.blocking === true,
    resolvedBy: challenge.resolvedBy ?? 'unresolved',
    outcome: challenge.outcome ?? 'pending',
  }
}

// ── accessors ───────────────────────────────────────────────────────────────

function objectAt(value: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const found = value?.[key]
  return found && typeof found === 'object' && !Array.isArray(found) ? (found as Record<string, unknown>) : undefined
}

function stringAt(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const found = value?.[key]
  return typeof found === 'string' && found.length > 0 ? found : undefined
}

function numberAt(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const found = value?.[key]
  return typeof found === 'number' && Number.isFinite(found) ? found : undefined
}

function booleanAt(value: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const found = value?.[key]
  return typeof found === 'boolean' ? found : undefined
}

function phaseAt(value: Record<string, unknown>, key: string): BootPhase | undefined {
  const found = stringAt(value, key)
  return found && (BOOT_PHASES as readonly string[]).includes(found) ? (found as BootPhase) : undefined
}

/** `https://example.com/a/very/long/path` → `example.com/a/very/lo…` */
export function shortenUrl(url: string, max = 56): string {
  let host = url
  let rest = ''
  try {
    const parsed = new URL(url)
    // about:blank, data:, chrome:// all PARSE fine — they just have no host.
    // Without this check they would render as an empty string.
    if (!parsed.host) return url.length > max ? `${url.slice(0, max - 1)}…` : url
    host = parsed.host
    rest = `${parsed.pathname}${parsed.search}`
  } catch {
    // Not an absolute URL at all: show it verbatim.
    return url.length > max ? `${url.slice(0, max - 1)}…` : url
  }
  const combined = rest && rest !== '/' ? `${host}${rest}` : host
  return combined.length > max ? `${combined.slice(0, max - 1)}…` : combined
}

/**
 * A tiny observable store so cards in one conversation share the session id.
 *
 * `browser_click` and `browser_challenge` results do not carry a sessionId, but
 * the "open panel" cue on those cards still needs one to scope the grant.
 * Remembering the most recent id from ANY card is strictly better than rendering
 * a cue that opens an unscoped panel — which on a multi-session host could attach
 * the user's mouse to the wrong browser.
 */
export interface SessionMemory {
  remember(sessionId: string): void
  current(): string | undefined
  subscribe(listener: () => void): () => void
}

export function createSessionMemory(): SessionMemory {
  let latest: string | undefined
  const listeners = new Set<() => void>()
  return {
    remember(sessionId) {
      if (!sessionId || sessionId === latest) return
      latest = sessionId
      for (const listener of [...listeners]) listener()
    },
    current: () => latest,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** Process-wide; one conversation's cards all see the same remembered session. */
export const sessionMemory = createSessionMemory()
