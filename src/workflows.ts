/**
 * Workflow record → replay primitives.
 *
 * Pure functions and types only — the host owns I/O and the engines own
 * input, and everything testable lives here so the static suites cover the
 * semantics without a browser.
 *
 * The recorder's contract, inherited from the interaction trace: typed TEXT
 * is only ever captured from the panel's control channel during an explicit,
 * user-armed recording, and anything typed into a password-shaped field is
 * replaced by a required `{{variable}}` — secrets are never written to disk.
 *
 * @module @dsh-community/dsh-browser/workflows
 */

/** What the element at a recorded click point looked like, for identity-first replay. */
export interface ElementIdentity {
  tag: string
  type?: string
  role?: string
  aria?: string
  text?: string
  placeholder?: string
  name?: string
}

export type WorkflowStep =
  | { kind: 'goto'; url: string }
  | { kind: 'click'; x: number; y: number; identity?: ElementIdentity; secretTarget?: boolean }
  | { kind: 'type'; text?: string; variable?: string }
  | { kind: 'press'; key: string }
  | { kind: 'scroll'; deltaX: number; deltaY: number }

export interface Workflow {
  name: string
  createdAt: number
  startUrl: string
  steps: WorkflowStep[]
  /** Variables the replay requires (secret fields, user-declared). */
  variables: string[]
}

/** Hard caps — a workflow is a demonstration, not a session transcript. */
export const MAX_WORKFLOW_STEPS = 500
export const MAX_WORKFLOW_NAME = 40

/** Filesystem-safe, human-recognizable. Empty string when nothing survives. */
export function sanitizeWorkflowName(raw: string): string {
  return raw
    .trim()
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, MAX_WORKFLOW_NAME)
}

/**
 * Feed one control-channel key event into the step list.
 *
 * Printable characters coalesce into a single `type` step (the panel sends
 * one event per keystroke); everything else (Enter, Tab, arrows) becomes a
 * `press`. Returns a NEW array — recorders must not mutate saved workflows.
 */
export function appendKeyEvent(steps: WorkflowStep[], key: string, text: string | undefined, secretTarget: boolean): WorkflowStep[] {
  const next = [...steps]
  if (text && text.length > 0) {
    const last = next[next.length - 1]
    if (last && last.kind === 'type' && ((last.variable !== undefined) === secretTarget)) {
      if (last.variable !== undefined) return next // secret text is NEVER accumulated
      next[next.length - 1] = { kind: 'type', text: ((last.text ?? '') + text).slice(0, 4000) }
      return next
    }
    if (secretTarget) {
      next.push({ kind: 'type', variable: uniqueVariable(next, 'password') })
      return next
    }
    next.push({ kind: 'type', text: text.slice(0, 4000) })
    return next
  }
  next.push({ kind: 'press', key: key.slice(0, 32) })
  return next
}

function uniqueVariable(steps: WorkflowStep[], base: string): string {
  const taken = new Set(listVariableNames(steps))
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}_${n}`)) n += 1
  return `${base}_${n}`
}

/** Every variable a replay must supply, in first-use order. */
export function listVariableNames(steps: WorkflowStep[]): string[] {
  const names: string[] = []
  for (const step of steps) {
    if (step.kind === 'type' && step.variable && !names.includes(step.variable)) names.push(step.variable)
    for (const match of inlineVariables(step)) {
      if (!names.includes(match)) names.push(match)
    }
  }
  return names
}

const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g

/** `{{var}}` placeholders inside a goto URL or literal type text. */
export function inlineVariables(step: WorkflowStep): string[] {
  const source = step.kind === 'goto' ? step.url : step.kind === 'type' ? (step.text ?? '') : ''
  const names: string[] = []
  for (const match of source.matchAll(VARIABLE_PATTERN)) {
    const name = match[1]
    if (name && !names.includes(name)) names.push(name)
  }
  return names
}

export interface ResolvedWorkflow {
  steps: WorkflowStep[]
  missing: string[]
}

/**
 * Substitute variables for replay. Missing ones are REPORTED, not defaulted —
 * a replay that silently types an empty password is worse than one that stops.
 */
export function resolveVariables(steps: WorkflowStep[], vars: Record<string, string>): ResolvedWorkflow {
  const missing: string[] = []
  for (const name of listVariableNames(steps)) {
    if (typeof vars[name] !== 'string' || vars[name].length === 0) missing.push(name)
  }
  const resolved = steps.map(step => {
    if (step.kind === 'type') {
      if (step.variable !== undefined) return { kind: 'type' as const, text: vars[step.variable] ?? '' }
      if (step.text) return { kind: 'type' as const, text: substitute(step.text, vars) }
    }
    if (step.kind === 'goto') return { kind: 'goto' as const, url: substitute(step.url, vars) }
    return step
  })
  return { steps: resolved, missing }
}

function substitute(source: string, vars: Record<string, string>): string {
  return source.replace(VARIABLE_PATTERN, (whole, name: string) => (typeof vars[name] === 'string' ? vars[name] : whole))
}

/**
 * Page-world probe for identity-first replay: finds the element that best
 * matches the recorded identity and returns its current center in normalized
 * viewport fractions (or null). Text/aria/placeholder matching is exact-ish
 * and deliberately conservative — when in doubt it returns null and the
 * caller falls back to the recorded coordinates.
 */
export function identityProbeScript(identity: ElementIdentity): string {
  return `(() => {
    const wanted = ${JSON.stringify(identity)}
    const tag = (wanted.tag || '').toLowerCase()
    const candidates = Array.from(document.querySelectorAll(tag && tag !== 'a' && tag !== 'div' && tag !== 'span' ? tag : '*'))
    let best = null
    let bestScore = 0
    for (const el of candidates) {
      const rect = el.getBoundingClientRect()
      if (rect.width < 2 || rect.height < 2) continue
      let score = 0
      if (wanted.aria && el.getAttribute('aria-label') === wanted.aria) score += 5
      if (wanted.placeholder && el.getAttribute('placeholder') === wanted.placeholder) score += 5
      if (wanted.name && el.getAttribute('name') === wanted.name) score += 4
      if (wanted.role && el.getAttribute('role') === wanted.role) score += 3
      if (wanted.type && (el.getAttribute('type') || '') === wanted.type) score += 2
      if (wanted.text) {
        const own = (el.textContent || '').trim().slice(0, 60)
        if (own === wanted.text) score += 4
        else if (own.includes(wanted.text)) score += 1
      }
      if (score > bestScore) { bestScore = score; best = el }
    }
    if (!best || bestScore < 4) return null
    const r = best.getBoundingClientRect()
    return {
      x: (r.x + r.width / 2) / window.innerWidth,
      y: (r.y + r.height / 2) / window.innerHeight,
      px: r.x + r.width / 2,
      py: r.y + r.height / 2,
    }
  })()`
}

/** Probe the recorder runs at click time to capture what was clicked. */
export function identityCaptureScript(px: number, py: number): string {
  return `(() => {
    const el = document.elementFromPoint(${px}, ${py})
    if (!el) return null
    const pick = (node) => {
      const out = { tag: node.tagName ? String(node.tagName).toLowerCase() : '' }
      const type = node.getAttribute && node.getAttribute('type'); if (type) out.type = type
      const role = node.getAttribute && node.getAttribute('role'); if (role) out.role = role
      const aria = node.getAttribute && node.getAttribute('aria-label'); if (aria) out.aria = String(aria).slice(0, 80)
      const placeholder = node.getAttribute && node.getAttribute('placeholder'); if (placeholder) out.placeholder = String(placeholder).slice(0, 80)
      const name = node.getAttribute && node.getAttribute('name'); if (name) out.name = String(name).slice(0, 80)
      const text = node.textContent ? String(node.textContent).trim().slice(0, 60) : ''
      if (text) out.text = text
      return out
    }
    // An icon inside a button identifies as the BUTTON; walk up one hop when
    // the hit node itself has nothing to match on.
    let identity = pick(el)
    if (!identity.aria && !identity.text && !identity.placeholder && el.parentElement) identity = pick(el.parentElement)
    const isSecret = identity.type === 'password'
    return { identity, isSecret }
  })()`
}

// ── replay orchestrator ─────────────────────────────────────────────────────

/** The structural page surface the replay loop needs — engines satisfy it as-is. */
export interface ReplayPage {
  viewport(): { width: number; height: number }
  goto(url: string, opts?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' }): Promise<void>
  evaluateIsolated<T>(script: string): Promise<T | undefined>
  input: {
    click(x: number, y: number): Promise<void>
    typeText(text: string): Promise<void>
    pressKey(key: string): Promise<void>
    scroll(deltaX: number, deltaY: number): Promise<void>
  }
}

export interface ReplayProgress {
  index: number
  total: number
  step: WorkflowStep
  ok: boolean
  detail?: string
}

export interface ReplayResult {
  replayed: number
  fallbacks: number
  cancelled: boolean
  /** 1-based step number when the run stopped on an error. */
  failedAt?: number
  error?: string
}

/**
 * Run resolved workflow steps against a page, humanized and cancellable.
 *
 * Shared by foreground `browser_workflow run` and background `browser_task`
 * jobs so both get the same identity-first targeting, the same coordinate
 * fallback accounting and the same abort semantics. Cancellation is checked
 * BETWEEN steps — a step in flight always finishes, like a human lifting
 * their finger off the mouse.
 */
export async function replayWorkflowSteps(
  page: ReplayPage,
  steps: WorkflowStep[],
  opts: { signal?: AbortSignal; onStep?: (progress: ReplayProgress) => void; paceMs?: number } = {},
): Promise<ReplayResult> {
  const pace = opts.paceMs ?? 120
  let replayed = 0
  let fallbacks = 0
  for (const [index, step] of steps.entries()) {
    if (opts.signal?.aborted) return { replayed, fallbacks, cancelled: true }
    try {
      switch (step.kind) {
        case 'goto':
          await page.goto(step.url, { waitUntil: 'domcontentloaded' })
          break
        case 'click': {
          let center: { x: number; y: number; px?: number; py?: number } | null = null
          if (step.identity) {
            try {
              center = (await page.evaluateIsolated<{ x: number; y: number; px?: number; py?: number } | null>(identityProbeScript(step.identity))) ?? null
            } catch {
              center = null
            }
          }
          const viewport = page.viewport()
          // Prefer the probe's CSS-pixel center: denormalizing x/y through
          // page.viewport() only matches when both sides share the same basis,
          // and an attached browser's window is whatever size the user has.
          if (center && Number.isFinite(center.px) && Number.isFinite(center.py)) {
            await page.input.click(Math.round(center.px as number), Math.round(center.py as number))
          } else if (center && Number.isFinite(center.x) && Number.isFinite(center.y)) {
            await page.input.click(Math.round(center.x * viewport.width), Math.round(center.y * viewport.height))
          } else {
            fallbacks += 1
            await page.input.click(Math.round(step.x * viewport.width), Math.round(step.y * viewport.height))
          }
          break
        }
        case 'type':
          await page.input.typeText(step.text ?? '')
          break
        case 'press':
          await page.input.pressKey(step.key)
          break
        case 'scroll':
          await page.input.scroll(step.deltaX, step.deltaY)
          break
      }
      replayed += 1
      opts.onStep?.({ index, total: steps.length, step, ok: true })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      opts.onStep?.({ index, total: steps.length, step, ok: false, detail })
      return { replayed, fallbacks, cancelled: false, failedAt: index + 1, error: detail }
    }
    // Breathe between steps — a replay should look like the human recording it
    // came from, not a macro firing at the event loop. paceMs: 0 for tests.
    if (pace > 0 && index < steps.length - 1) {
      await new Promise(resolve => setTimeout(resolve, pace + Math.round(Math.random() * 160)))
    }
  }
  return { replayed, fallbacks, cancelled: false }
}
