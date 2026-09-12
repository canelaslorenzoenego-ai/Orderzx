/**
 * Shared runtime for the browser tool families.
 *
 * Schemas, result shaping, session resolution, the capture store and the
 * observation builder live here so the tool files stay about verbs rather than
 * plumbing. Re-exported from `tools.ts` so `./tools.js` is the one import path
 * the sibling families use (the dsh-android convention).
 *
 * One contract worth stating up front, because it shapes every tool below:
 *
 *   `execute` returns ONLY the canonical JSON value. Never content blocks.
 *   The registry snapshots it as lossless JSON, validates it against
 *   `output.schema`, freezes it, and hands it to `output.render`.
 *
 * Pixels therefore reach the model in exactly two ways: an `image` field inside
 * the canonical value (which `renderJsonWithImage` turns into a block), and
 * `output.presentationMeta` (which the client's card and panel replay). Bytes on
 * disk are referenced by path; the client re-mints a signed capability at render
 * time rather than the tool embedding a URL that would expire mid-session.
 *
 * @module @dsh-community/dsh-browser/tool-support
 */

import type { JsonValue } from './json-value.js'
import type { BrowserHostController, Refusal } from './host.js'
import type { EnginePage } from './engine/types.js'
import type { BrowserMeta, ChallengeRecord } from './protocol.js'
import { saveCaptureAttachment, imageInputActive, type BrowserImageRef, type BrowserVisionServices, type VisionExecLike } from './vision.js'
import { DOM_PROBE, detectFromUrl, normalizeProbe, type Detection } from './challenge/detector.js'
import {
  CLEANUP_SCRIPT,
  MARK_NAME_LENGTH,
  MAX_MARKS,
  buildOverlayScript,
  selectMarks,
  setMarks,
  MARK_ROLES,
  type Mark,
  type MarkBox,
} from './marks.js'

/** Milliseconds to let a page settle after an action before capturing. */
export const ACTION_SETTLE_MS = 320
/** Cap on how much a11y tree text we will put in a tool result. */
export const MAX_SNAPSHOT_NODES = 400
export const MAX_NAME_LENGTH = 120

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

// ── schemas ─────────────────────────────────────────────────────────────────

/** Optional session selector. Omitted means "the active session". */
export const sessionSchema = {
  type: 'string',
  description:
    'Browser session: an id from browser_start, a sub-agent LABEL (`browser_start({ label: "researcher" })` → '
    + '`session: "researcher"`), or a unique id prefix. Omit to use the active session. Pass it explicitly whenever '
    + 'more than one browser is live — the active one may belong to another agent.',
} as const

/** Optional element ref. */
export const refSchema = {
  type: 'string',
  description:
    'Element ref from the most recent browser_observe (e.g. "e12"). Refs are per-snapshot: after any '
    + 'navigation or page change they are dead and you must observe again. A stale ref returns E_STALE_REF.',
} as const

/** The `image` field carried by capture-producing results. */
export const imageResultSchema = {
  type: 'object',
  additionalProperties: false,
  description: 'Durable attachment reference, present only when the routed model declares image input.',
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', required: true },
    bytes: { type: 'number', required: true },
    width: { type: 'number', required: true },
    height: { type: 'number', required: true },
    name: { type: 'string' },
  },
} as const

export const challengeSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'Bot-detection challenge detected on this page, when any. `vendor: unknown` still means a real widget '
    + 'we could not name — treat it as blocking and call browser_challenge.',
  properties: {
    present: { type: 'boolean', required: true },
    vendor: { type: 'string', required: true },
    blocking: { type: 'boolean', required: true },
    solved: { type: 'boolean' },
    sitekey: { type: 'string' },
  },
} as const

/** Flattened a11y node as it appears in a tool result. */
export interface FlatNode {
  ref: string
  role: string
  name: string
  value?: string
  disabled?: boolean
  checked?: boolean
  depth: number
}

export const elementsSchema = {
  type: 'array',
  required: true,
  description:
    'Interactive and readable elements, flattened with a depth field. Use `ref` with browser_click / '
    + 'browser_type. This is the cheap observer — prefer it over asking for pixels.',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ref: { type: 'string', required: true },
      role: { type: 'string', required: true },
      name: { type: 'string', required: true },
      value: { type: 'string' },
      disabled: { type: 'boolean' },
      checked: { type: 'boolean' },
      depth: { type: 'number', required: true },
    },
  },
} as const

// ── session resolution ──────────────────────────────────────────────────────

export type ResolvedTarget = { ok: true; sessionId: string; page: EnginePage } | (Refusal & { ok: false })

/**
 * Resolve `session?` to a live page, gated on pointer ownership and handoff state.
 *
 * Every acting tool calls this first. Centralising the gate is what makes the
 * "a human is driving" refusal consistent across all 18 verbs instead of
 * something each one has to remember.
 */
export function resolveTarget(host: BrowserHostController, session?: string): ResolvedTarget {
  const gate = host.gate(session)
  if (!gate.ok) return gate
  const page = gate.session.browser.activePage()
  if (!page) {
    return { ok: false, refused: 'no-session', message: 'the session has no active page; call browser_start or browser_tabs to create one' }
  }
  return { ok: true, sessionId: gate.session.id, page }
}

/** Same, but for tools that legitimately work without an active page (status, stop). */
export function resolveSession(host: BrowserHostController, session?: string): { ok: true; sessionId: string } | (Refusal & { ok: false }) {
  const id = session ?? host.activeSessionId()
  if (!id || !host.hasSession(id)) {
    return { ok: false, refused: 'no-session', message: 'no browser session; call browser_start first' }
  }
  return { ok: true, sessionId: id }
}

// ── observation ─────────────────────────────────────────────────────────────

export interface ObservationResult {
  url: string
  title: string
  elements: FlatNode[]
  elementCount: number
  truncated: boolean
  challenge: Detection
  viewport: { width: number; height: number }
  capturePath?: string
  image?: BrowserImageRef
}

/**
 * Build one observation: a11y tree + challenge probe + optional capture.
 *
 * Order matters. The challenge probe runs BEFORE the capture, because if a
 * blocking challenge is up the screenshot is of the interstitial — still worth
 * taking, but the model should read `challenge` first rather than spend a
 * vision pass on a "Verifying you are human" spinner.
 */
export async function observe(
  host: BrowserHostController,
  sessionId: string,
  page: EnginePage,
  vision: BrowserVisionServices,
  exec: VisionExecLike,
  options: { capture?: boolean } = {},
): Promise<ObservationResult> {
  const challenge = await detectChallenge(page)
  const snapshot = await page.snapshot({ maxNodes: MAX_SNAPSHOT_NODES, maxNameLength: MAX_NAME_LENGTH }).catch(() => undefined)

  const elements: FlatNode[] = []
  if (snapshot) flatten(snapshot.nodes, 0, elements)

  rememberElements(sessionId, elements)

  const result: ObservationResult = {
    url: snapshot?.url ?? page.url(),
    title: snapshot?.title ?? '',
    elements,
    elementCount: elements.length,
    truncated: snapshot?.truncated ?? false,
    challenge,
    viewport: page.viewport(),
  }

  if (options.capture !== false) {
    const jpeg = await page.capture({ format: 'jpeg', quality: host.config.frames.jpegQuality }).catch(() => undefined)
    if (jpeg && jpeg.byteLength > 0) {
      const saved = await host.saveCapture(sessionId, jpeg, 'jpg').catch(() => undefined)
      if (saved) result.capturePath = saved.path
      // Attach only when the routed model can actually receive it.
      if (await imageInputActive(vision, exec)) {
        const ref = await saveCaptureAttachment(vision, {
          data: jpeg,
          width: result.viewport.width,
          height: result.viewport.height,
          mediaType: 'image/jpeg',
          name: `browser-${sessionId}-${Date.now()}.jpg`,
        })
        if (ref) result.image = ref
      }
    }
  }

  if (challenge.present && challenge.blocking) {
    host.recordChallenge(sessionId, toRecord(challenge, result.url))
  }
  return result
}

/** Cap on live box queries per see — each is a locator round-trip. */
export const BOX_QUERY_CAP = 120

export interface SeeResult {
  url: string
  title: string
  /** Numbered interactive elements, document order, drawn ON the screenshot. */
  marks: Mark[]
  markCount: number
  /** Interactive candidates that existed before the mark cap / visibility filter. */
  candidateCount: number
  challenge: Detection
  viewport: { width: number; height: number }
  capturePath?: string
  image?: BrowserImageRef
}

/**
 * Build one SEE: set-of-marks screenshot + the mark → ref table.
 *
 * Same degrade-don't-refuse contract as observe(): the canonical JSON (marks,
 * url, challenge) is always returned; the image block rides along only when the
 * routed model can receive it. A model with no vision still gets value — the
 * mark table is a filtered, visibility-checked element list, and `mark` works
 * as a click alias regardless of who looked at the picture.
 *
 * The overlay is injected through the isolated world and removed immediately
 * after the capture — the ONLY thing between inject and cleanup is one
 * `page.capture()`, so the numbered frame flashes on the live stream for a few
 * hundred ms (a feature: the user sees exactly what the model was shown) and
 * never survives the call.
 */
export async function see(
  host: BrowserHostController,
  sessionId: string,
  page: EnginePage,
  vision: BrowserVisionServices,
  exec: VisionExecLike,
): Promise<SeeResult> {
  const challenge = await detectChallenge(page)
  const snapshot = await page.snapshot({ maxNodes: MAX_SNAPSHOT_NODES, maxNameLength: MAX_NAME_LENGTH }).catch(() => undefined)
  const elements: FlatNode[] = []
  if (snapshot) flatten(snapshot.nodes, 0, elements)
  const viewport = page.viewport()

  const candidates = elements.filter(node => MARK_ROLES.has(node.role) && node.disabled !== true)
  const boxes = new Map<string, MarkBox | undefined>()
  for (const candidate of candidates.slice(0, BOX_QUERY_CAP)) {
    boxes.set(candidate.ref, await page.boxOf(candidate.ref).catch(() => undefined))
  }
  const marks = selectMarks(candidates, boxes, viewport, MAX_MARKS)
  setMarks(sessionId, marks)
  rememberElements(sessionId, elements)

  const result: SeeResult = {
    url: snapshot?.url ?? page.url(),
    title: snapshot?.title ?? '',
    marks,
    markCount: marks.length,
    candidateCount: candidates.length,
    challenge,
    viewport,
  }

  if (marks.length > 0) await page.evaluateIsolated(buildOverlayScript(marks)).catch(() => undefined)
  const jpeg = await page.capture({ format: 'jpeg', quality: host.config.frames.jpegQuality }).catch(() => undefined)
  if (marks.length > 0) await page.evaluateIsolated(CLEANUP_SCRIPT).catch(() => undefined)

  if (jpeg && jpeg.byteLength > 0) {
    const saved = await host.saveCapture(sessionId, jpeg, 'jpg').catch(() => undefined)
    if (saved) result.capturePath = saved.path
    if (await imageInputActive(vision, exec)) {
      const ref = await saveCaptureAttachment(vision, {
        data: jpeg,
        width: viewport.width,
        height: viewport.height,
        mediaType: 'image/jpeg',
        name: `browser-see-${sessionId}-${Date.now()}.jpg`,
      })
      if (ref) result.image = ref
    }
  }

  if (challenge.present && challenge.blocking) {
    host.recordChallenge(sessionId, toRecord(challenge, result.url))
  }
  return result
}

/** The mark-table half of a see result, as the text a model reads. */
export function marksTableText(marks: Mark[]): string {
  return marks
    .map(m => `[${m.mark}] ${m.role}${m.name ? ` "${m.name}"` : ''} @ ${Math.round(m.box.x)},${Math.round(m.box.y)} ${Math.round(m.box.width)}x${Math.round(m.box.height)} (ref ${m.ref})`)
    .join('\n')
}

// ── self-healing refs ───────────────────────────────────────────────────────

/**
 * The last observed element list per session — the memory self-healing needs.
 *
 * When a ref dies (the page re-rendered, an SPA route changed the tree), the
 * honest old behaviour is E_STALE_REF. That is still the FLOOR, but a page that
 * merely re-rendered the same button should not cost the model a whole observe
 * round-trip: we remember what the stale ref USED to be (role + accessible
 * name) and look for one exact role+name match in a fresh snapshot. Zero or
 * two-plus matches = no heal, fail loudly — guessing between candidates is how
 * a bot clicks "Delete" instead of "Cancel".
 */
const elementsCache = new Map<string, FlatNode[]>()

export function rememberElements(sessionId: string, elements: FlatNode[]): void {
  elementsCache.set(sessionId, elements)
  if (elementsCache.size > 32) {
    const oldest = elementsCache.keys().next().value
    if (oldest !== undefined) elementsCache.delete(oldest)
  }
}

/**
 * Try to re-find a dead ref. Returns the fresh ref, or undefined when the
 * element genuinely is gone (or was never observed through this plugin).
 */
export async function healRef(sessionId: string, page: EnginePage, staleRef: string): Promise<string | undefined> {
  const old = elementsCache.get(sessionId)?.find(node => node.ref === staleRef)
  if (!old || old.name.length === 0) return undefined
  const snapshot = await page.snapshot({ maxNodes: MAX_SNAPSHOT_NODES, maxNameLength: MAX_NAME_LENGTH }).catch(() => undefined)
  if (!snapshot) return undefined
  const fresh: FlatNode[] = []
  flatten(snapshot.nodes, 0, fresh)
  rememberElements(sessionId, fresh)
  const matches = fresh.filter(node => node.role === old.role && node.name === old.name && node.disabled !== true)
  return matches.length === 1 ? matches[0]?.ref : undefined
}

export interface RefBoxResult {
  ref: string
  box?: { x: number; y: number; width: number; height: number }
  /** The original ref was dead and one exact role+name match replaced it. */
  healedFrom?: string
}

/**
 * boxOf with one self-heal attempt folded in. Throws nothing: a dead ref that
 * cannot heal comes back as `{ box: undefined }` and the caller writes its own
 * "observe again" message. Both engine failure shapes are covered: a thrown
 * E_STALE_REF (ref map no longer knows the ref) and a resolved-but-boxless ref
 * (element hidden or detached since the snapshot).
 */
export async function resolveRefBox(page: EnginePage, sessionId: string, ref: string): Promise<RefBoxResult> {
  const first = await page.boxOf(ref).catch(() => undefined)
  if (first) return { ref, box: first }
  const healed = await healRef(sessionId, page, ref)
  if (!healed || healed === ref) return { ref, box: undefined }
  const box = await page.boxOf(healed).catch(() => undefined)
  return box ? { ref: healed, box, healedFrom: ref } : { ref, box: undefined }
}

export { MARK_NAME_LENGTH, MAX_MARKS, MAX_MARKS as SEE_MAX_MARKS }
export { resolveMark, clearMarks, MARK_ROLES } from './marks.js'
export type { Mark, MarkBox, MarkCandidate } from './marks.js'

/**
 * Run the DOM challenge probe in an isolated world.
 *
 * Never throws: a page mid-navigation will reject the evaluation, and that is
 * not a challenge, it is just a page that is not ready.
 */
export async function detectChallenge(page: EnginePage): Promise<Detection> {
  const fromUrl = detectFromUrl(page.url())
  if (fromUrl) return fromUrl
  try {
    const raw = await page.evaluateIsolated<unknown>(DOM_PROBE)
    return normalizeProbe(raw)
  } catch {
    return { present: false, vendor: 'unknown', blocking: false, signal: 'none' }
  }
}

export function toRecord(detection: Detection, url: string): ChallengeRecord {
  return {
    id: `ch-${Date.now().toString(36)}`,
    vendor: detection.vendor,
    blocking: detection.blocking,
    url,
    at: Date.now(),
    resolvedBy: 'unresolved',
    outcome: 'pending',
  }
}

/** Depth-first flatten of the a11y tree, skipping purely structural nodes. */
export function flatten(nodes: Array<{ ref: string; role: string; name: string; value?: string; disabled?: boolean; checked?: boolean; children?: unknown[] }>, depth: number, out: FlatNode[]): void {
  for (const node of nodes) {
    const interesting = node.name.length > 0 || INTERACTIVE_ROLES.has(node.role) || node.value !== undefined
    if (interesting && out.length < MAX_SNAPSHOT_NODES) {
      out.push({
        ref: node.ref,
        role: node.role,
        name: node.name,
        ...(node.value === undefined ? {} : { value: node.value }),
        ...(node.disabled === undefined ? {} : { disabled: node.disabled }),
        ...(node.checked === undefined ? {} : { checked: node.checked }),
        depth,
      })
    }
    const children = node.children as typeof nodes | undefined
    if (children && children.length > 0 && depth < 24) flatten(children, depth + 1, out)
  }
}

/** Roles worth surfacing even when they have no accessible name. */
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option',
  'menuitem', 'tab', 'switch', 'slider', 'spinbutton', 'searchbox', 'menuitemcheckbox',
])

// ── presentationMeta ────────────────────────────────────────────────────────

/**
 * Project the durable card data for a capture-producing result.
 *
 * Must be reconstructible from the canonical value alone, because nested PTC
 * (Code-mode) calls carry NO presentationMeta — the harness projects it only for
 * top-level calls. `client/meta-hydrate.ts` rebuilds this same shape from the
 * settled result text so PTC sessions render identical cards.
 */
export function captureMeta(value: JsonValue, summary: string): BrowserMeta {
  const record = (value ?? {}) as Record<string, unknown>
  const meta: BrowserMeta = { tool: 'browser_observe', phase: 'streaming', summary }
  if (typeof record.url === 'string') meta.url = record.url
  if (typeof record.title === 'string') meta.title = record.title
  if (typeof record.capturePath === 'string') meta.capturePath = record.capturePath
  const viewport = record.viewport as { width?: unknown; height?: unknown } | undefined
  if (typeof viewport?.width === 'number') meta.width = viewport.width
  if (typeof viewport?.height === 'number') meta.height = viewport.height
  const challenge = record.challenge as { present?: unknown; vendor?: unknown; blocking?: unknown } | undefined
  if (challenge?.present === true && typeof challenge.vendor === 'string') {
    meta.challenge = {
      id: 'inline',
      vendor: challenge.vendor as ChallengeRecord['vendor'],
      blocking: challenge.blocking === true,
      resolvedBy: 'unresolved',
      outcome: 'pending',
    }
  }
  return meta
}

/** Render a typed refusal as a domain outcome rather than an infrastructure error. */
export function refusalValue(refusal: Refusal): JsonValue {
  return {
    ok: false,
    refused: refusal.refused,
    ...(refusal.owner === undefined ? {} : { owner: refusal.owner }),
    message: refusal.message,
  }
}
