/**
 * Model-facing tools.
 *
 * 21 verbs, in the order they are registered. The shape follows dsh-android's
 * conventions exactly:
 *
 *  - Tools ALWAYS register. On a host with no browser driver, no display, or a
 *    missing optional package, each `execute` throws a clear explanatory error.
 *    A machine must load the plugin and be told why, not silently lose verbs.
 *  - `execute` returns ONE canonical JSON value. Refusals (a human owns the
 *    pointer, a handoff is pending, policy said no) are DOMAIN OUTCOMES in that
 *    value, not throws — the model can read `{ ok: false, refused: 'pointer-owned' }`
 *    and decide to wait. Throwing would present a normal state as a failure.
 *  - Infrastructure failures throw. A launch timeout, a dead CDP session, a
 *    full disk — those are `isError`.
 *  - `exec.signal` is honored everywhere: cancelling the tool call cancels the
 *    work. It does NOT cancel the frame loop, which the panel is still watching;
 *    the controller owns that lifetime, not the call.
 *
 * @module @dsh-community/dsh-browser/tools
 */

import { mkdir } from 'node:fs/promises'
import { join, resolve as resolvePath } from 'node:path'
import { profileRoot } from './access.js'
import { ACT_CACHE_TTL_MS, actCacheKey, parseActCache, type ActCacheEntry } from './act-cache.js'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from './json-value.js'
import type { BrowserHostController } from './host.js'
import { probeEngine } from './engine/index.js'
import { FRAME_SOURCES, TOOL_NAMES } from './protocol.js'
import type { FrameSource } from './protocol.js'
import { redactConfig } from './config.js'
import type { ChallengePipeline, Verdict } from './challenge/pipeline.js'
import { sessionBoundWarning } from './challenge/pipeline.js'
import {
  ACTION_SETTLE_MS,
  captureMeta,
  challengeSchema,
  detectChallenge,
  elementsSchema,
  errorMessage,
  imageResultSchema,
  observe,
  see,
  marksTableText,
  resolveMark,
  clearMarks,
  resolveRefBox,
  validateSchema,
  refSchema,
  refusalValue,
  resolveSession,
  resolveTarget,
  sessionSchema,
  sleep,
  toRecord,
} from './tool-support.js'
import { imageInputActive, renderJson, renderJsonWithImage, saveCaptureAttachment, type BrowserVisionServices } from './vision.js'

/** Registered tool names, in registration order. */
export const BROWSER_TOOL_NAMES = Object.values(TOOL_NAMES) as string[]

export interface BrowserToolsOptions {
  vision: BrowserVisionServices
  challenge: ChallengePipeline
  /** Ask the harness for a one-shot approval. Absent on hosts without the policy service. */
  requestApproval?: (input: { title: string; detail: string; kind: string }) => Promise<boolean>
}

/** Verbs that need an approval before dispatch, when policy enables it. */
const SENSITIVE_VERBS = new Set(['pay', 'payment', 'purchase', 'buy', 'order', 'checkout', 'publish', 'post', 'delete', 'remove', 'send', 'submit', 'install', 'transfer', 'password', 'security', 'logout', 'subscribe', 'cancel'])

export function createBrowserTools(host: BrowserHostController, options: BrowserToolsOptions): Record<string, ToolDefinition> {
  const { vision, challenge } = options

  /** Does this element look like it does something irreversible? */
  function isSensitiveTarget(name: string, role: string): boolean {
    const haystack = `${role} ${name}`.toLowerCase()
    return [...SENSITIVE_VERBS].some(verb => haystack.includes(verb))
  }

  // ── act → deterministic cache ─────────────────────────────────────────────
  //
  // Ui.Vision's other half, at our honest scale: cache the RESOLUTION (role +
  // accessible name), never coordinates or refs, and verify it against the
  // live tree on every reuse. A hit is a re-found element, not a replay of a
  // dead one. Disk lives under the profile root, same trust boundary as the
  // cookie jar and the workflows.
  let actCacheMap: Map<string, ActCacheEntry> | undefined
  const actCacheFile = (): string => join(profileRoot(), 'act-cache.json')
  async function actCache(): Promise<Map<string, ActCacheEntry>> {
    if (actCacheMap) return actCacheMap
    let raw = ''
    try {
      raw = await (await import('node:fs/promises')).readFile(actCacheFile(), 'utf8')
    } catch { /* first run: an empty cache */ }
    actCacheMap = new Map(Object.entries(parseActCache(raw)))
    return actCacheMap
  }
  async function actCacheSave(map: Map<string, ActCacheEntry>): Promise<void> {
    try {
      const { mkdir, writeFile } = await import('node:fs/promises')
      await mkdir(profileRoot(), { recursive: true })
      await writeFile(actCacheFile(), JSON.stringify(Object.fromEntries(map)), 'utf8')
    } catch { /* a cache that cannot write stays in memory */ }
  }

  /** One line on the session timeline. Never include typed text or full URLs with query strings. */
  function acted(sessionId: string, tool: string, summary: string, ok = true, refused?: string): void {
    host.recordAction(sessionId, {
      ts: Date.now(),
      tool,
      summary: summary.slice(0, 120),
      ok,
      ...(refused ? { refused } : {}),
    })
  }

  async function gateSensitive(name: string, role: string, url: string): Promise<{ allowed: boolean; reason?: string }> {
    if (!host.config.policy.approvalForSensitiveActions) return { allowed: true }
    if (!isSensitiveTarget(name, role)) return { allowed: true }
    if (!options.requestApproval) {
      // No policy service on this host. Fail closed on sensitive verbs rather
      // than fail open: a harness that cannot ask cannot consent.
      return { allowed: false, reason: `this action looks sensitive ("${name}") and no approval service is available to confirm it` }
    }
    const approved = await options.requestApproval({
      kind: 'browser-sensitive-action',
      title: `Browser action: ${name || role}`,
      detail: `The agent wants to activate "${name || role}" on ${url}. This looks like a payment, publish, delete, send or account-security action.`,
    })
    return approved ? { allowed: true } : { allowed: false, reason: 'the user declined this action' }
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  const browserStart = defineTool({
    name: TOOL_NAMES.start,
    description:
      'Launch the browser and start the live stream. The panel opens and the user can watch — and take over the '
      + 'mouse — from that moment. Omit `url` to start on a blank tab. Returns the session id every other tool '
      + 'takes, plus the stealth posture actually achieved (read `stealth.gaps`; do not assume you are invisible). '
      + 'On a host with no driver installed this throws with the install command rather than failing silently.',
    parameters: {
      url: { type: 'string', description: 'http(s) URL to open after launch. Private/loopback hosts are refused unless explicitly allowed in policy.' },
      profile: { type: 'string', description: 'Persistent profile name. Cookies and logins survive across browser_start calls. Default "default".' },
      headless: { type: 'boolean', description: 'Override the configured headless setting for this session only.' },
      provider: { type: 'string', description: 'Override the engine provider for this session: patchright | cloakbrowser | playwright-core | cdp.' },
      label: { type: 'string', description: 'Sub-agent name for this browser (max 40 chars). Every later tool can then target it with `session: "<label>"`. Labels are unique per live session; a duplicate gets a numeric suffix.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          session: { type: 'string' },
          label: { type: 'string' },
          phase: { type: 'string' },
          url: { type: 'string' },
          stealth: {
            type: 'object',
            additionalProperties: false,
            properties: {
              provider: { type: 'string', required: true },
              humanize: { type: 'boolean', required: true },
              applied: { type: 'array', required: true, items: { type: 'string' } },
              gaps: { type: 'array', required: true, items: { type: 'string' } },
            },
          },
          refused: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: renderJson,
      presentationMeta: (_args: unknown, value: JsonValue): JsonValue => {
        const record = (value ?? {}) as Record<string, unknown>
        return {
          tool: TOOL_NAMES.start,
          phase: typeof record.phase === 'string' ? record.phase : 'streaming',
          ...(typeof record.session === 'string' ? { sessionId: record.session } : {}),
          ...(typeof record.url === 'string' ? { url: record.url } : {}),
          ...(typeof record.label === 'string' ? { label: record.label } : {}),
          summary: record.ok === true ? `browser live${typeof record.label === 'string' ? ` · ${record.label}` : ''}${typeof record.url === 'string' ? ` · ${record.url}` : ''}` : `start refused: ${record.message ?? record.refused ?? '?'}`,
        }
      },
    },
    async execute(args, exec) {
      const result = await host.start({
        ...(args.url === undefined ? {} : { url: args.url }),
        ...(args.profile === undefined ? {} : { profile: args.profile }),
        ...(args.headless === undefined ? {} : { headless: args.headless }),
        ...(args.provider === undefined ? {} : { provider: args.provider as never }),
        ...(args.label === undefined ? {} : { label: args.label }),
        signal: exec.signal,
      })
      if (!result.ok) return refusalValue(result) as never
      const posture = result.posture
      acted(result.session, TOOL_NAMES.start, `start${result.label ? ` "${result.label}"` : ''}${args.url ? ` → ${args.url}` : ''}`)
      return {
        ok: true,
        session: result.session,
        ...(result.label === null ? {} : { label: result.label }),
        phase: result.phase,
        url: args.url ?? 'about:blank',
        stealth: {
          provider: posture.provider,
          humanize: posture.humanize,
          applied: posture.applied,
          gaps: posture.gaps,
        },
      } as never
    },
  })

  const browserStop = defineTool({
    name: TOOL_NAMES.stop,
    description:
      'Close the browser and stop the stream. The persistent profile keeps its cookies, so a later browser_start '
      + 'is still logged in. Refused while a human owns the pointer — ask them to resume first, or they lose '
      + 'whatever they were doing mid-form.',
    parameters: { session: sessionSchema },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, message: { type: 'string' }, refused: { type: 'string' } } },
      render: renderJson,
    },
    async execute(args) {
      const resolved = resolveSession(host, args.session)
      if (!resolved.ok) return refusalValue(resolved) as never
      const session = host.session(resolved.sessionId)
      if (session?.owner === 'user') {
        return { ok: false, refused: 'pointer-owned', message: 'a human is driving this session; they must resume before it can be closed' } as never
      }
      const result = await host.stop(resolved.sessionId)
      return (result.ok ? { ok: true, message: 'browser closed; profile cookies retained' } : refusalValue(result)) as never
    },
  })

  const browserStatus = defineTool({
    name: TOOL_NAMES.status,
    description:
      'Read the runtime state without acting: phase, tabs, frame transport and fps, pointer ownership, any pending '
      + 'challenge, the engine probe result, and the effective (redacted) config. Call this when a tool returns '
      + '`refused: pointer-owned` to see whether the human is still driving, and at the start of a task to find out '
      + 'what stealth posture you actually have.',
    parameters: { session: sessionSchema },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          phase: { type: 'string', required: true },
          engine: { type: 'object', additionalProperties: true },
          status: { type: 'object', additionalProperties: true },
          config: { type: 'object', additionalProperties: true },
        },
      },
      render: renderJson,
    },
    async execute(args) {
      const provider = host.config.engine.provider
      const probe = await probeEngine(provider)
      const id = args.session ?? host.activeSessionId()
      return {
        phase: id ? (host.status(id).phase ?? 'idle') : 'idle',
        engine: { configured: provider, available: probe.available, reason: probe.reason ?? null, detail: (probe as { detail?: string }).detail ?? null },
        status: id ? host.status(id) : { phase: 'idle', sessions: host.listSessions() },
        // Redacted: this is model-facing, so it can end up in a prompt, a session
        // log and a screenshot. Credentials must not be able to take that path.
        config: redactConfig(host.config),
      } as never
    },
  })

  // ── observation ───────────────────────────────────────────────────────────

  const browserObserve = defineTool({
    name: TOOL_NAMES.observe,
    description:
      'The default observer. Returns URL, title, and the accessibility tree flattened to interactive elements with '
      + 'refs you can click — plus a `challenge` field when a bot-detection widget is present. On an image-capable '
      + 'model the screenshot itself comes back as an image block; on a text-only route the same call returns the '
      + 'tree alone. Pass capture:false to skip pixels entirely (~150 ms, and no capture added to the detection '
      + 'surface). Refs are per-snapshot: after any navigation, observe again.',
    parameters: {
      session: sessionSchema,
      capture: { type: 'boolean', description: 'Default true. Set false for a text-only observation — cheaper and quieter.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
          elements: elementsSchema,
          elementCount: { type: 'number', required: true },
          truncated: { type: 'boolean', required: true },
          challenge: challengeSchema,
          viewport: {
            type: 'object', additionalProperties: false,
            properties: { width: { type: 'number', required: true }, height: { type: 'number', required: true } },
          },
          capturePath: { type: 'string' },
          image: imageResultSchema,
          ok: { type: 'boolean' },
          refused: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: renderJsonWithImage,
      presentationMeta: (_args: unknown, value: JsonValue): JsonValue => {
        const record = (value ?? {}) as Record<string, unknown>
        const url = typeof record.url === 'string' ? record.url : ''
        return captureMeta(value, url ? url.slice(0, 90) : 'observation') as unknown as JsonValue
      },
    },
    async execute(args, exec) {
      const target = resolveTarget(host, args.session)
      if (!target.ok) return refusalValue(target) as never
      const result = await observe(host, target.sessionId, target.page, vision, exec, { capture: args.capture !== false })
      return result as never
    },
  })

  const browserSee = defineTool({
    name: TOOL_NAMES.see,
    description:
      'Look at the page the way a vision model should: a screenshot with every interactive element NUMBERED ON IT '
      + '(set-of-marks), plus the mark → ref table. Use this when names in the a11y tree are ambiguous or missing '
      + '(icon buttons, canvas UIs, dense product grids, image-heavy pages) — you can then act by `mark` number. '
      + 'Marks alias refs and die with them: after any navigation, see again. On a text-only route this degrades to '
      + 'the mark table alone, which is still a visibility-filtered element list.',
    parameters: {
      session: sessionSchema,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
          marks: {
            type: 'array',
            required: true,
            description: 'Numbered interactive elements in document order. `mark` is what you pass to browser_click/browser_type; `ref` is the equivalent snapshot ref.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                mark: { type: 'number', required: true },
                ref: { type: 'string', required: true },
                role: { type: 'string', required: true },
                name: { type: 'string', required: true },
                box: {
                  type: 'object', additionalProperties: false,
                  properties: {
                    x: { type: 'number', required: true }, y: { type: 'number', required: true },
                    width: { type: 'number', required: true }, height: { type: 'number', required: true },
                  },
                },
              },
            },
          },
          markCount: { type: 'number', required: true },
          candidateCount: { type: 'number', required: true },
          challenge: challengeSchema,
          viewport: {
            type: 'object', additionalProperties: false,
            properties: { width: { type: 'number', required: true }, height: { type: 'number', required: true } },
          },
          capturePath: { type: 'string' },
          image: imageResultSchema,
          ok: { type: 'boolean' },
          refused: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args: unknown, value: JsonValue): Array<{ type: 'text'; text: string }> => {
        const record = (value ?? {}) as Record<string, unknown>
        const marks = Array.isArray(record.marks) ? record.marks : []
        const text = marks.length > 0
          ? `Marks on the screenshot (pass \`mark\` to browser_click / browser_type):\n${marksTableText(marks as never)}`
          : 'No interactive elements were visible to mark.'
        return renderJsonWithImage(_args, { ...record, marksText: text })
      },
      presentationMeta: (_args: unknown, value: JsonValue): JsonValue => {
        const record = (value ?? {}) as Record<string, unknown>
        return captureMeta(value, `see — ${String(record.markCount ?? 0)} marks`) as unknown as JsonValue
      },
    },
    async execute(args, exec) {
      const target = resolveTarget(host, args.session)
      if (!target.ok) return refusalValue(target) as never
      const result = await see(host, target.sessionId, target.page, vision, exec)
      return { ...result, ok: true } as never
    },
  })

  // ── actions ───────────────────────────────────────────────────────────────

  const browserClick = defineTool({
    name: TOOL_NAMES.click,
    description:
      'Click an element by ref, or a point by normalized 0..1 coordinates. Humanized: the pointer travels a curved '
      + 'path with an occasional overshoot-and-correct, dwells before pressing, and holds the button for a realistic '
      + 'interval. Returns the post-action URL, title and a fresh challenge probe so you can verify without a second '
      + 'observe. Sensitive targets (pay, publish, delete, send, account security) trigger a one-shot user approval.',
    parameters: {
      session: sessionSchema,
      ref: refSchema,
      mark: { type: 'number', description: 'Mark number from the most recent browser_see — an alias for that element\'s ref. Mutually exclusive with ref and x/y.' },
      x: { type: 'number', description: 'Normalized 0..1 horizontal position. Use with y when there is no ref (canvas, video player, a widget the a11y tree cannot see).' },
      y: { type: 'number', description: 'Normalized 0..1 vertical position.' },
      button: { type: 'string', description: 'left (default) | right | middle.' },
      doubleClick: { type: 'boolean' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          url: { type: 'string' },
          title: { type: 'string' },
          target: { type: 'string' },
          healedFrom: { type: 'string', description: 'Present when the given ref was dead and self-healed to this one (same role + accessible name, unique match).' },
          point: { type: 'object', additionalProperties: false, properties: { x: { type: 'number' }, y: { type: 'number' } } },
          navigated: { type: 'boolean' },
          challenge: challengeSchema,
          capturePath: { type: 'string' },
          image: imageResultSchema,
          refused: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: renderJsonWithImage,
      presentationMeta: (_args: unknown, value: JsonValue): JsonValue => {
        const record = (value ?? {}) as Record<string, unknown>
        return {
          tool: TOOL_NAMES.click,
          phase: 'streaming',
          url: record.url,
          capturePath: record.capturePath,
          summary: record.ok === true ? `clicked ${record.target ?? 'point'}` : `click refused: ${record.message ?? record.refused ?? '?'}`,
        } as never
      },
    },
    async execute(args, exec) {
      const target = resolveTarget(host, args.session)
      if (!target.ok) return refusalValue(target) as never
      const { page, sessionId } = target

      // A mark is only ever an alias for a ref: resolve it first, then let the
      // ref path do its normal staleness check. A mark from before a navigation
      // fails exactly like a stale ref — it can never silently click something new.
      if (typeof args.mark === 'number' && typeof args.ref !== 'string') {
        const aliased = resolveMark(sessionId, args.mark)
        if (!aliased) {
          return { ok: false, message: `mark ${args.mark} is unknown — marks come from the most recent browser_see and die on navigation; see again` } as never
        }
        ;(args as { ref?: string }).ref = aliased
      }

      const hasRef = typeof args.ref === 'string' && args.ref.length > 0
      const hasPoint = typeof args.x === 'number' && typeof args.y === 'number'
      if (!hasRef && !hasPoint) {
        return { ok: false, message: 'pass `ref` (from browser_observe), `mark` (from browser_see), or normalized `x`/`y`' } as never
      }
      if (hasRef && hasPoint) {
        return { ok: false, message: 'pass exactly one of `ref` or `x`/`y`, not both — they can disagree and the wrong one would win' } as never
      }
      if (hasPoint && (args.x! < 0 || args.x! > 1 || args.y! < 0 || args.y! > 1)) {
        return { ok: false, message: 'x and y must be normalized 0..1 fractions of the viewport, not pixels' } as never
      }

      const beforeUrl = page.url()
      let point: { x: number; y: number }
      let label: string

      let refBox: { x: number; y: number; width: number; height: number } | undefined
      let healedFrom: string | undefined
      if (hasRef) {
        const resolved = await resolveRefBox(page, sessionId, args.ref!)
        if (!resolved.box) return { ok: false, message: `ref ${args.ref} has no box on screen — it may be scrolled out of view or hidden; scroll or observe again` } as never
        if (resolved.healedFrom) {
          // Self-healed: same role + same accessible name, one exact match in a
          // fresh snapshot. Say so in the result and the timeline — a silent
          // substitution would be indistinguishable from a bug.
          healedFrom = resolved.healedFrom
          host.record(sessionId, 'agent', { type: 'note', text: `self-healed ref ${resolved.healedFrom} → ${resolved.ref}` })
        }
        refBox = resolved.box
        point = { x: resolved.box.x + resolved.box.width / 2, y: resolved.box.y + resolved.box.height / 2 }
        label = resolved.ref
      } else {
        const viewport = page.viewport()
        point = { x: args.x! * viewport.width, y: args.y! * viewport.height }
        label = `point(${args.x!.toFixed(3)}, ${args.y!.toFixed(3)})`
      }

      if (hasRef) {
        const snapshot = await page.snapshot({ maxNodes: MAX_NODES_FOR_LABEL }).catch(() => undefined)
        const named = snapshot ? findName(snapshot.nodes, args.ref!) : undefined
        if (named) label = `${args.ref} · ${named.role} "${named.name}"`
        const gate = await gateSensitive(named?.name ?? '', named?.role ?? '', beforeUrl)
        if (!gate.allowed) return { ok: false, refused: 'policy', message: gate.reason } as never
      }

      const button = (args.button ?? 'left') as 'left' | 'right' | 'middle'
      // Show the gesture BEFORE it lands: outline the element the model picked,
      // then click — so the panel reads as "looked here, clicked there".
      const vp = page.viewport()
      if (hasRef && refBox) {
        host.record(sessionId, 'agent', {
          type: 'focus', ref: args.ref!, label,
          box: { x: refBox.x, y: refBox.y, width: refBox.width, height: refBox.height },
        })
      }
      host.record(sessionId, 'agent', {
        type: 'click',
        x: vp.width > 0 ? point.x / vp.width : 0,
        y: vp.height > 0 ? point.y / vp.height : 0,
        button,
        ...(hasRef ? { ref: args.ref!, label } : { label }),
      })
      await page.input.click(point.x, point.y, { button, clickCount: args.doubleClick ? 2 : 1 })
      await sleep(ACTION_SETTLE_MS, exec.signal).catch(() => undefined)

      const challenge = await detectChallenge(page)
      if (challenge.present && challenge.blocking) host.recordChallenge(sessionId, toRecord(challenge, page.url()))
      const after = await captureAfter(host, sessionId, page, vision, exec)
      acted(sessionId, TOOL_NAMES.click, `click ${label}`)

      return {
        ok: true,
        url: page.url(),
        target: label,
        ...(healedFrom === undefined ? {} : { healedFrom }),
        point: { x: Math.round(point.x), y: Math.round(point.y) },
        navigated: beforeUrl !== page.url(),
        challenge,
        // `after` carries title (and capturePath/image when produced); listing
        // title again before the spread would be overwritten silently.
        ...after,
      } as never
    },
  })

  const browserType = defineTool({
    name: TOOL_NAMES.type,
    description:
      'Type text into the focused element or a ref. Humanized per keystroke with a realistic inter-key interval '
      + 'distribution (longer after spaces and punctuation, longer for shift reach, occasional hesitation) — not a '
      + 'fixed delay. `clear: true` empties the field first. Use `insert: true` only for bulk paste-like content '
      + '(a token, a long body): it is one synthetic input event and is detectably non-human.',
    parameters: {
      session: sessionSchema,
      ref: refSchema,
      text: { type: 'string', required: true, description: 'Text to type. Never echo a password back in your reply.' },
      mark: { type: 'number', description: 'Mark number from the most recent browser_see — an alias for that field\'s ref.' },
      clear: { type: 'boolean', description: 'Select-all and delete before typing. Default true when a ref is given.' },
      insert: { type: 'boolean', description: 'Bulk insert instead of per-key events. Detectably non-human — reserve for paste.' },
      pressEnter: { type: 'boolean' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          ref: { type: 'string' },
          characters: { type: 'number' },
          durationMs: { type: 'number' },
          value: { type: 'string', description: 'The field value after typing, when readable. Redacted for password fields.' },
          redacted: { type: 'boolean' },
          url: { type: 'string' },
          challenge: challengeSchema,
          refused: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: renderJson,
    },
    async execute(args, exec) {
      const target = resolveTarget(host, args.session)
      if (!target.ok) return refusalValue(target) as never
      const { page, sessionId } = target

      if (typeof args.text !== 'string' || args.text.length === 0) return { ok: false, message: 'text is required and must be non-empty' } as never
      if (args.text.length > 20_000) return { ok: false, message: 'text is over 20 000 characters — use insert:true or split the input' } as never

      // Same mark → ref alias as browser_click: resolve before anything reads args.ref.
      if (typeof args.mark === 'number' && !args.ref) {
        const aliased = resolveMark(sessionId, args.mark)
        if (!aliased) {
          return { ok: false, message: `mark ${args.mark} is unknown — marks come from the most recent browser_see and die on navigation; see again` } as never
        }
        ;(args as { ref?: string }).ref = aliased
      }

      let isSecret = false
      if (args.ref) {
        const resolved = await resolveRefBox(page, sessionId, args.ref)
        if (resolved.healedFrom) {
          host.record(sessionId, 'agent', { type: 'note', text: `self-healed ref ${resolved.healedFrom} → ${resolved.ref}` })
          ;(args as { ref?: string }).ref = resolved.ref
        }
        const box = resolved.box
        if (!box) return { ok: false, message: `stale or invisible ref ${args.ref}; observe again` } as never
        host.record(sessionId, 'agent', { type: 'focus', ref: args.ref, box: { x: box.x, y: box.y, width: box.width, height: box.height } })
        // Click to focus (humanized) before typing — a real user clicks the field.
        const tvp = page.viewport()
        host.record(sessionId, 'agent', { type: 'click', x: tvp.width > 0 ? (box.x + box.width / 2) / tvp.width : 0, y: tvp.height > 0 ? (box.y + box.height / 2) / tvp.height : 0, button: 'left', ref: args.ref })
        await page.input.click(box.x + box.width / 2, box.y + box.height / 2)
        isSecret = await page
          .evaluateIsolated<boolean>(
            `(() => { const el = document.activeElement; return !!(el && (el.type === 'password' || el.getAttribute('autocomplete') === 'current-password' || el.getAttribute('data-sensitive') === 'true')); })()`,
          )
          .catch(() => false)
        if (args.clear !== false) {
          await page.input.pressKey('ControlOrMeta+a').catch(() => undefined)
          await page.input.pressKey('Delete').catch(() => undefined)
        }
      }

      const started = Date.now()
      if (args.insert) await page.input.typeText(args.text, { insert: true })
      else await page.input.typeText(args.text)
      if (args.pressEnter) await page.input.pressKey('Enter')
      const durationMs = Date.now() - started
      // Length only, never the text — the trace reaches the panel and the log.
      host.record(sessionId, 'agent', { type: 'type', characters: args.text.length, secret: isSecret, ...(args.ref ? { ref: args.ref } : {}) })
      await sleep(ACTION_SETTLE_MS, exec.signal).catch(() => undefined)

      let value: string | undefined
      if (!isSecret) {
        value = await page
          .evaluateIsolated<string>(`(() => { const el = document.activeElement; return el && 'value' in el ? String(el.value) : ''; })()`)
          .catch(() => undefined)
        if (typeof value === 'string' && value.length > 200) value = `${value.slice(0, 200)}…`
      }

      const challenge = await detectChallenge(page)
      if (challenge.present && challenge.blocking) host.recordChallenge(sessionId, toRecord(challenge, page.url()))

      acted(sessionId, TOOL_NAMES.type, `typed ${args.text.length} chars${isSecret ? ' (secret)' : ''}${args.ref ? ` into ${args.ref}` : ''}`)
      return {
        ok: true,
        ...(args.ref === undefined ? {} : { ref: args.ref }),
        characters: args.text.length,
        durationMs,
        // Never return a secret to the model: it would land in the session log,
        // the trajectory view, and possibly a screenshot.
        ...(isSecret ? { redacted: true } : value === undefined ? {} : { value }),
        url: page.url(),
        challenge,
      } as never
    },
  })

  const browserPress = defineTool({
    name: TOOL_NAMES.press,
    description: 'Press a key or combination: Enter, Tab, Escape, ArrowDown, PageDown, ControlOrMeta+a, Control+c.',
    parameters: { session: sessionSchema, key: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, key: { type: 'string' }, url: { type: 'string' }, refused: { type: 'string' }, message: { type: 'string' } } }, render: renderJson },
    async execute(args, exec) {
      const target = resolveTarget(host, args.session)
      if (!target.ok) return refusalValue(target) as never
      if (typeof args.key !== 'string' || args.key.length === 0 || args.key.length > 32) {
        return { ok: false, message: 'key must be a 1–32 character key name or combination' } as never
      }
      await target.page.input.pressKey(args.key)
      await sleep(ACTION_SETTLE_MS, exec.signal).catch(() => undefined)
      host.record(target.sessionId, 'agent', { type: 'key', key: args.key })
      acted(target.sessionId, TOOL_NAMES.press, `key ${args.key}`)
      return { ok: true, key: args.key, url: target.page.url() } as never
    },
  })

  const browserScroll = defineTool({
    name: TOOL_NAMES.scroll,
    description:
      'Scroll the page or an element. Humanized: the gesture is broken into several wheel events that decay in size, '
      + 'with slight horizontal drift and an occasional small counter-scroll — one big wheel event is a signature. '
      + 'Use `direction`+`amount` for a natural scroll, or `deltaY` in pixels for a precise one.',
    parameters: {
      session: sessionSchema,
      direction: { type: 'string', description: 'up | down | left | right. Default down.' },
      amount: { type: 'number', description: 'Roughly how many "viewport steps" to scroll. Default 1.' },
      deltaY: { type: 'number', description: 'Exact pixel delta. Overrides direction/amount.' },
      ref: { type: 'string', description: 'Scroll within this element instead of the page.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, scrollY: { type: 'number' }, url: { type: 'string' }, challenge: challengeSchema, refused: { type: 'string' }, message: { type: 'string' } } }, render: renderJson },
    async execute(args, exec) {
      const target = resolveTarget(host, args.session)
      if (!target.ok) return refusalValue(target) as never
      const { page, sessionId } = target
      const viewport = page.viewport()

      let deltaY: number
      if (typeof args.deltaY === 'number') deltaY = args.deltaY
      else {
        const amount = Math.max(0.1, Math.min(10, args.amount ?? 1))
        const direction = args.direction ?? 'down'
        deltaY = direction === 'up' ? -viewport.height * amount : direction === 'down' ? viewport.height * amount : 0
        if (direction === 'left' || direction === 'right') {
          const deltaX = (direction === 'left' ? -1 : 1) * viewport.width * amount
          await page.input.scroll(deltaX, 0)
          await sleep(ACTION_SETTLE_MS, exec.signal).catch(() => undefined)
          host.record(sessionId, 'agent', { type: 'scroll', deltaX, deltaY: 0 })
          acted(sessionId, TOOL_NAMES.scroll, `scroll ${direction} ×${amount}`)
          return { ok: true, scrollY: await scrollPosition(page), url: page.url(), challenge: await detectChallenge(page) } as never
        }
      }

      if (args.ref) {
        const box = await page.boxOf(args.ref).catch(() => undefined)
        if (box) await page.input.pointerMove(box.x + box.width / 2, box.y + box.height / 2)
      }
      await page.input.scroll(0, deltaY)
      await sleep(ACTION_SETTLE_MS, exec.signal).catch(() => undefined)
      host.record(sessionId, 'agent', { type: 'scroll', deltaX: 0, deltaY })
      acted(sessionId, TOOL_NAMES.scroll, `scroll ${deltaY > 0 ? 'down' : deltaY < 0 ? 'up' : ''} ${Math.round(Math.abs(deltaY))}px`)
      const challenge = await detectChallenge(page)
      if (challenge.present && challenge.blocking) host.recordChallenge(sessionId, toRecord(challenge, page.url()))
      return { ok: true, scrollY: await scrollPosition(page), url: page.url(), challenge } as never
    },
  })

  const browserNavigate = defineTool({
    name: TOOL_NAMES.navigate,
    description:
      'Go to a URL, or back / forward / reload / stop. Paced: a dwell is inserted between navigations because an '
      + 'agent that navigates every 400 ms for 30 pages is a signature no driver can hide. Private, loopback and '
      + 'link-local hosts are refused (the harness sandbox does not govern network visibility, so this is the SSRF '
      + 'boundary).',
    parameters: {
      session: sessionSchema,
      url: { type: 'string', description: 'http(s) URL. Exactly one of url or action.' },
      action: { type: 'string', description: 'back | forward | reload | stop.' },
      waitUntil: { type: 'string', description: 'domcontentloaded (default) | load | networkidle.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, url: { type: 'string' }, title: { type: 'string' }, challenge: challengeSchema, refused: { type: 'string' }, message: { type: 'string' } } }, render: renderJson },
    async execute(args, exec) {
      const target = resolveTarget(host, args.session)
      if (!target.ok) return refusalValue(target) as never
      const { page, sessionId } = target
      const hasUrl = typeof args.url === 'string' && args.url.length > 0
      const hasAction = typeof args.action === 'string' && args.action.length > 0
      if (hasUrl === hasAction) return { ok: false, message: 'pass exactly one of `url` or `action`' } as never

      if (hasUrl) {
        const result = await host.navigate(sessionId, args.url!, exec.signal)
        if (!result.ok) return refusalValue(result) as never
        clearMarks(sessionId)
        acted(sessionId, TOOL_NAMES.navigate, `navigate → ${args.url!.slice(0, 80)}`)
      } else {
        await page.navigate(args.action as 'back' | 'forward' | 'reload' | 'stop' as never)
        await sleep(ACTION_SETTLE_MS, exec.signal).catch(() => undefined)
        clearMarks(sessionId)
        host.record(sessionId, 'agent', { type: 'navigate', url: page.url(), action: args.action as 'back' | 'forward' | 'reload' | 'stop' })
        acted(sessionId, TOOL_NAMES.navigate, `navigate ${args.action}`)
      }
      const challenge = await detectChallenge(page)
      if (challenge.present && challenge.blocking) host.recordChallenge(sessionId, toRecord(challenge, page.url()))
      return { ok: true, url: page.url(), title: await page.title().catch(() => ''), challenge } as never
    },
  })

  const browserTabs = defineTool({
    name: TOOL_NAMES.tabs,
    description: 'List tabs, open a new one, select one, or close one. The selected tab is what every other tool acts on and what the panel streams.',
    parameters: {
      session: sessionSchema,
      action: { type: 'string', description: 'list (default) | new | select | close.' },
      index: { type: 'number', description: 'Tab index for select/close.' },
      url: { type: 'string', description: 'URL for `new`.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, active: { type: 'number' }, tabs: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } }, refused: { type: 'string' }, message: { type: 'string' } } }, render: renderJson },
    async execute(args, exec) {
      const resolved = resolveSession(host, args.session)
      if (!resolved.ok) return refusalValue(resolved) as never
      const session = host.session(resolved.sessionId)!
      // Tab management does not need the pointer — but it does need the gate, so
      // a human mid-takeover is not surprised by a tab closing under them.
      if (session.owner !== 'agent') {
        return { ok: false, refused: 'pointer-owned', message: 'a human owns this session; tab changes would surprise them' } as never
      }
      const action = args.action ?? 'list'
      const list = async () => {
        const pages = session.browser.pages()
        const active = session.browser.activePage()
        const tabs = await Promise.all(
          pages.map(async (tab, index) => ({ index, id: tab.id, url: tab.url(), title: await tab.title().catch(() => ''), active: tab.id === active?.id })),
        )
        return { ok: true as const, active: Math.max(0, tabs.findIndex(t => t.active)), tabs }
      }

      if (action === 'list') return (await list()) as never
      if (action === 'new') {
        host.record(session.id, 'agent', { type: 'tab', action: 'new' })
        acted(session.id, TOOL_NAMES.tabs, `tab new${args.url ? ` → ${args.url.slice(0, 60)}` : ''}`)
        const page = await session.browser.newPage()
        await host.syncDesktopView(session.id, page)
        clearMarks(session.id)
        if (args.url) {
          const nav = await host.navigate(session.id, args.url, exec.signal)
          if (!nav.ok) return refusalValue(nav) as never
        }
        void page
        return (await list()) as never
      }
      if (action === 'select' || action === 'close') {
        const pages = session.browser.pages()
        const index = args.index ?? 0
        const target = pages[index]
        if (!target) return { ok: false, message: `no tab at index ${index} (${pages.length} open)` } as never
        if (action === 'close') await target.close()
        else {
          await session.browser.selectPage(target.id)
          await host.syncDesktopView(session.id, target)
        }
        clearMarks(session.id)
        host.record(session.id, 'agent', { type: 'tab', action, index })
        acted(session.id, TOOL_NAMES.tabs, `tab ${action} #${index}`)
        await session.frames.nudge(() => session.browser.activePage())
        return (await list()) as never
      }
      return { ok: false, message: `unknown action '${action}'; use list | new | select | close` } as never
    },
  })

  const browserFillForm = defineTool({
    name: TOOL_NAMES.fillForm,
    description:
      'Fill several fields in one call, by ref. Each field is clicked and typed with the same humanization as '
      + 'browser_type, with a realistic gap between fields. Returns per-field results so a single validation error '
      + 'does not hide which field caused it. Submitting is a SEPARATE decision: `submit: true` clicks the submit '
      + 'ref and is treated as a sensitive action.',
    parameters: {
      session: sessionSchema,
      fields: {
        type: 'array', required: true,
        description: 'Fields to fill, in order.',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            ref: { type: 'string', required: true },
            value: { type: 'string', required: true },
            clear: { type: 'boolean' },
          },
        },
      },
      submitRef: { type: 'string', description: 'Ref to click after filling. Treated as a sensitive action.' },
      verify: { type: 'boolean', description: 'Read every field back after filling and report per-field expected-vs-actual. Default true — turn it off only for fields that transform input (masks, autocorrect).' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, filled: { type: 'number' }, failed: { type: 'number' }, verified: { type: 'number' }, mismatched: { type: 'number' }, results: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } }, submitted: { type: 'boolean' }, url: { type: 'string' }, challenge: challengeSchema, refused: { type: 'string' }, message: { type: 'string' } } }, render: renderJson },
    async execute(args, exec) {
      const target = resolveTarget(host, args.session)
      if (!target.ok) return refusalValue(target) as never
      const { page, sessionId } = target
      if (!Array.isArray(args.fields) || args.fields.length === 0) return { ok: false, message: 'fields must be a non-empty array' } as never
      if (args.fields.length > 40) return { ok: false, message: 'at most 40 fields per call; split the form' } as never

      const results: Array<Record<string, unknown>> = []
      let filled = 0
      for (const field of args.fields as Array<{ ref: string; value: string; clear?: boolean }>) {
        if (typeof field?.ref !== 'string' || typeof field?.value !== 'string') {
          results.push({ ref: field?.ref ?? null, ok: false, message: 'each field needs a string ref and value' })
          continue
        }
        const box = await page.boxOf(field.ref).catch(() => undefined)
        if (!box) {
          results.push({ ref: field.ref, ok: false, message: 'stale or invisible ref' })
          continue
        }
        await page.input.click(box.x + box.width / 2, box.y + box.height / 2)
        if (field.clear !== false) {
          await page.input.pressKey('ControlOrMeta+a').catch(() => undefined)
          await page.input.pressKey('Delete').catch(() => undefined)
        }
        await page.input.typeText(field.value)
        // Gap between fields. Humans do not fill a form at machine cadence.
        await sleep(180 + Math.random() * 420, exec.signal).catch(() => undefined)
        filled += 1
        results.push({ ref: field.ref, ok: true, characters: field.value.length, expected: field.value })
      }

      // Form strategy: filling is half the job. Read every field back through an
      // isolated-world value probe so a silent mask, autocomplete or formatter
      // surfaces as a mismatch instead of a confident "filled".
      let verified = 0
      let mismatched = 0
      if (args.verify !== false) {
        for (const entry of results) {
          if (entry.ok !== true || typeof entry.ref !== 'string' || typeof entry.expected !== 'string') continue
          const actual = await page.inputValue(entry.ref).catch(() => undefined)
          if (actual === undefined) continue
          entry.actual = actual
          if (actual === entry.expected) { entry.verified = true; verified += 1 } else { entry.verified = false; mismatched += 1 }
        }
      }

      let submitted = false
      if (args.submitRef && filled > 0) {
        const box = await page.boxOf(args.submitRef).catch(() => undefined)
        if (!box) {
          results.push({ ref: args.submitRef, ok: false, message: 'submit ref is stale or invisible; nothing was submitted' })
        } else {
          const gate = await gateSensitive('submit form', 'button', page.url())
          if (!gate.allowed) {
            results.push({ ref: args.submitRef, ok: false, message: gate.reason ?? 'not approved' })
          } else {
            await page.input.click(box.x + box.width / 2, box.y + box.height / 2)
            submitted = true
            await sleep(ACTION_SETTLE_MS * 3, exec.signal).catch(() => undefined)
          }
        }
      }

      const challenge = await detectChallenge(page)
      if (challenge.present && challenge.blocking) host.recordChallenge(sessionId, toRecord(challenge, page.url()))
      return { ok: filled > 0, filled, failed: results.length - filled, verified, mismatched, results, submitted, url: page.url(), challenge } as never
    },
  })

  const browserExtract = defineTool({
    name: TOOL_NAMES.extract,
    description:
      'Pull structured data out of the current page against a JSON schema you supply. Uses the a11y tree and page '
      + 'text, not a second model call, so it is cheap and deterministic. For anything the tree cannot express '
      + '(values baked into a canvas or an image) use browser_observe with capture on an image-capable model instead.',
    parameters: {
      session: sessionSchema,
      instruction: { type: 'string', required: true, description: 'What to extract, in plain language.' },
      selector: { type: 'string', description: 'Optional CSS selector to scope extraction to a subtree.' },
      schema: { type: 'object', additionalProperties: true, description: 'Optional JSON-schema CONTRACT for your own structured attempt. Pass it together with `data`; this tool validates before anything downstream trusts it.' },
      data: { type: 'object', additionalProperties: true, description: 'Your structured attempt, shaped to `schema`. On violation the tool returns the exact paths plus a DEEPER text pass to repair against — one round-trip, not three.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, url: { type: 'string' }, text: { type: 'string' }, elements: elementsSchema, validated: { type: 'boolean' }, data: { type: 'object', additionalProperties: true }, violations: { type: 'array', items: { type: 'string' } }, siteTools: { type: 'boolean' }, refused: { type: 'string' }, message: { type: 'string' } } }, render: renderJson },
    async execute(args, exec) {
      const target = resolveTarget(host, args.session)
      if (!target.ok) return refusalValue(target) as never
      void exec
      const result = await observe(host, target.sessionId, target.page, vision, exec, { capture: false })
      // Bounded text: an unbounded page body would blow the context budget and
      // the harness would truncate it somewhere we cannot see.
      const slice = (limit: number) => target.page
        .evaluateIsolated<string>(
          `(() => { const root = document.querySelector(${JSON.stringify(args.selector ?? 'body')}) || document.body; return (root.innerText || '').slice(0, ${limit}); })()`,
        )
        .catch(() => '')
      const text = await slice(24000)

      // The schema is a CONTRACT on the model's own structured attempt: validate
      // before anything downstream trusts it, and on violation answer with the
      // exact paths plus a deeper text pass — repair in one round-trip.
      if (args.schema && typeof args.schema === 'object') {
        if (!args.data || typeof args.data !== 'object') {
          return { ok: false, message: '`schema` requires a `data` object to validate — pass your structured attempt alongside the contract', violations: ['$: no data supplied'], text, elements: result.elements } as never
        }
        const violations = validateSchema(args.data, args.schema as Record<string, unknown>)
        if (violations.length === 0) {
          return { ok: true, url: result.url, instruction: args.instruction, validated: true, data: args.data, siteTools: result.siteTools === true } as never
        }
        const deeper = await slice(48000)
        return { ok: false, url: result.url, instruction: args.instruction, validated: false, violations, text: deeper, elements: result.elements, message: `data violates the schema in ${violations.length} place(s); repair against the violations and the deeper text pass` } as never
      }
      return { ok: true, url: result.url, instruction: args.instruction, text, elements: result.elements, siteTools: result.siteTools === true } as never
    },
  })

  const browserAct = defineTool({
    name: TOOL_NAMES.act,
    description:
      'Act on the page from a plain-language instruction — one call instead of observe-then-click. Deterministic, not '
      + 'a second model: the instruction is matched against the live accessibility tree by role and accessible name, '
      + 'so "click the Sign in button" and "type hello into search" resolve without an extra LLM round-trip and '
      + 'without any network call. When the match is not confident it does NOT guess — it returns the ranked '
      + 'candidates and you pick a ref. Verbs: click/tap/press/select, type/fill/enter/write … into …, scroll, '
      + 'open/goto/navigate, check/uncheck. Sensitive targets still gate on approval. '
      + 'Confident resolutions are cached by (page, instruction) and IDENTITY-VERIFIED against the live tree on '
      + 'reuse: a repeat call that re-finds exactly one match replays deterministically (`cache: "hit"`); anything '
      + 'else falls through to normal scoring (`cache: "miss"` / `"new"`). The cache can never act on a stale element.',
    parameters: {
      session: sessionSchema,
      instruction: { type: 'string', required: true, description: 'What to do, e.g. `click "Sign in"`, `type hunter2 into password`, `scroll down`, `open https://example.com`.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          /** The verb that was parsed out of the instruction. */
          action: { type: 'string' },
          /** Resolved ref, when a specific element was acted on. */
          ref: { type: 'string' },
          matched: { type: 'string', description: 'Human-readable description of what was acted on.' },
          /** Ranked candidates when the match was not confident — pick one and call the specific tool. */
          candidates: { type: 'array', items: { type: 'object', additionalProperties: true } },
          /** hit = identity-verified replay of a cached resolution; miss = entry existed but did not verify; new = just cached. */
          cache: { type: 'string' },
          url: { type: 'string' },
          challenge: challengeSchema,
          refused: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: renderJson,
      presentationMeta: (_args: unknown, value: JsonValue): JsonValue => {
        const record = (value ?? {}) as Record<string, unknown>
        return {
          tool: TOOL_NAMES.act,
          phase: 'streaming',
          url: record.url,
          summary: record.ok === true
            ? `act · ${record.matched ?? record.action ?? 'done'}`
            : record.candidates
              ? `act ambiguous — ${String((record.candidates as unknown[]).length)} candidates`
              : `act refused: ${record.message ?? record.refused ?? '?'}`,
        } as never
      },
    },
    async execute(args, exec) {
      const target = resolveTarget(host, args.session)
      if (!target.ok) return refusalValue(target) as never
      const { page, sessionId } = target

      if (typeof args.instruction !== 'string' || args.instruction.trim().length === 0) {
        return { ok: false, message: 'instruction is required' } as never
      }
      const instruction = args.instruction.trim()
      const parsed = parseActInstruction(instruction)
      if (!parsed) {
        return {
          ok: false,
          message: 'could not parse a verb from that instruction — start it with click, type, scroll, open, or check',
        } as never
      }

      // Navigation and scroll need no element match.
      if (parsed.verb === 'open') {
        const url = parsed.text
        if (!url) return { ok: false, action: 'open', message: 'open needs a URL in the instruction' } as never
        const result = await host.navigate(sessionId, url, exec.signal)
        if (!result.ok) return refusalValue(result) as never
        acted(sessionId, TOOL_NAMES.act, `act open ${url.slice(0, 60)}`)
        const challenge = await detectChallenge(page)
        return { ok: true, action: 'open', matched: url, url: page.url(), challenge } as never
      }
      if (parsed.verb === 'scroll') {
        const viewport = page.viewport()
        const direction = parsed.direction ?? 'down'
        const deltaX = direction === 'left' ? -viewport.width : direction === 'right' ? viewport.width : 0
        const deltaY = direction === 'up' ? -viewport.height : direction === 'down' ? viewport.height : 0
        await page.input.scroll(deltaX, deltaY)
        await sleep(ACTION_SETTLE_MS, exec.signal).catch(() => undefined)
        host.record(sessionId, 'agent', { type: 'scroll', deltaX, deltaY })
        acted(sessionId, TOOL_NAMES.act, `act scroll ${direction}`)
        return { ok: true, action: 'scroll', matched: `scrolled ${direction}`, url: page.url(), challenge: await detectChallenge(page) } as never
      }

      // Element verbs: observe, rank the tree against the instruction's target.
      const observation = await observe(host, sessionId, page, vision, exec, { capture: false })
      const target2 = parsed.target
      // Deterministic cache: same page pattern + same instruction, resolved by
      // identity against the LIVE tree. A hit requires exactly one match — the
      // cache speeds resolution up, it never guesses in place of the gate.
      const cacheKey = actCacheKey(page.url(), instruction)
      const cache = await actCache()
      const entry = cache.get(cacheKey)
      let cachedNode: (typeof observation.elements)[number] | undefined
      if (entry && Date.now() - entry.savedAt < ACT_CACHE_TTL_MS) {
        const matches = observation.elements.filter(el => el.role === entry.role && el.name === entry.name)
        if (matches.length === 1) cachedNode = matches[0]
      }
      const cacheState: 'hit' | 'miss' | undefined = cachedNode ? 'hit' : entry ? 'miss' : undefined
      const ranked = cachedNode ? [{ node: cachedNode, score: 1 }] : rankElements(observation.elements, target2, parsed.verb)
      if (ranked.length === 0) {
        return {
          ok: false,
          action: parsed.verb,
          message: `no interactive element matches "${target2}"`,
          url: page.url(),
        } as never
      }
      const best = ranked[0]!
      // Confidence gate: if the top two are nearly tied, refuse to guess and hand
      // the model the ranked list — acting on the wrong element is worse than a
      // second call.
      const runnerUp = ranked[1]
      if (best.score < ACT_MIN_SCORE || (runnerUp && runnerUp.score > 0 && best.score - runnerUp.score < ACT_MARGIN)) {
        acted(sessionId, TOOL_NAMES.act, `act ${parsed.verb} "${target2}" — ambiguous`, false, 'ambiguous')
        return {
          ok: false,
          action: parsed.verb,
          message: `"${target2}" is ambiguous — pick one of these refs and call the specific tool`,
          candidates: ranked.slice(0, 6).map(entry => ({ ref: entry.node.ref, role: entry.node.role, name: entry.node.name, score: Math.round(entry.score * 100) / 100 })),
          url: page.url(),
        } as never
      }

      const node = best.node
      const box = await page.boxOf(node.ref)
      if (!box) {
        return { ok: false, action: parsed.verb, ref: node.ref, message: `${node.ref} has no box on screen; scroll or observe again` } as never
      }
      // Cache the resolution only past the confidence gate AND the box check:
      // an element that matched but is not on screen is not a resolution worth
      // repeating.
      const rememberResolution = async (): Promise<string> => {
        const mark = cacheState === 'hit' ? 'hit' : entry ? 'miss' : 'new'
        cache.set(cacheKey, {
          role: node.role,
          name: node.name,
          verb: parsed.verb,
          savedAt: Date.now(),
          hits: cacheState === 'hit' ? (entry?.hits ?? 0) + 1 : 0,
        })
        await actCacheSave(cache)
        return mark
      }

      if (parsed.verb === 'type') {
        const secret = /password|passwd|secret|otp|cvv|card/i.test(`${node.name} ${node.role}`)
        host.record(sessionId, 'agent', { type: 'focus', ref: node.ref, label: node.name, box: { x: box.x, y: box.y, width: box.width, height: box.height } })
        const tvp = page.viewport()
        host.record(sessionId, 'agent', { type: 'click', x: tvp.width > 0 ? (box.x + box.width / 2) / tvp.width : 0, y: tvp.height > 0 ? (box.y + box.height / 2) / tvp.height : 0, button: 'left', ref: node.ref })
        await page.input.click(box.x + box.width / 2, box.y + box.height / 2)
        await page.input.typeText(parsed.text ?? '')
        if (parsed.pressEnter) await page.input.pressKey('Enter').catch(() => undefined)
        await sleep(ACTION_SETTLE_MS, exec.signal).catch(() => undefined)
        host.record(sessionId, 'agent', { type: 'type', characters: (parsed.text ?? '').length, secret, ref: node.ref, label: node.name })
        acted(sessionId, TOOL_NAMES.act, `act type ${parsed.text?.length ?? 0} chars into ${node.ref}`)
        const challenge = await detectChallenge(page)
        if (challenge.present && challenge.blocking) host.recordChallenge(sessionId, toRecord(challenge, page.url()))
        return { ok: true, action: 'type', ref: node.ref, matched: `${node.role} "${node.name}"`, url: page.url(), challenge, cache: await rememberResolution() } as never
      }

      // click / tap / select / check
      const gate = await gateSensitive(node.name, node.role, page.url())
      if (!gate.allowed) {
        acted(sessionId, TOOL_NAMES.act, `act ${parsed.verb} "${node.name}"`, false, 'policy')
        return { ok: false, action: parsed.verb, refused: 'policy', message: gate.reason } as never
      }
      const vp2 = page.viewport()
      host.record(sessionId, 'agent', { type: 'focus', ref: node.ref, label: node.name, box: { x: box.x, y: box.y, width: box.width, height: box.height } })
      host.record(sessionId, 'agent', {
        type: 'click',
        x: vp2.width > 0 ? (box.x + box.width / 2) / vp2.width : 0,
        y: vp2.height > 0 ? (box.y + box.height / 2) / vp2.height : 0,
        button: 'left',
        ref: node.ref,
        label: `${node.ref} · ${node.role} "${node.name}"`,
      })
      await page.input.click(box.x + box.width / 2, box.y + box.height / 2)
      await sleep(ACTION_SETTLE_MS, exec.signal).catch(() => undefined)
      const challenge = await detectChallenge(page)
      if (challenge.present && challenge.blocking) host.recordChallenge(sessionId, toRecord(challenge, page.url()))
      acted(sessionId, TOOL_NAMES.act, `act ${parsed.verb} ${node.ref} "${node.name}"`)
      return { ok: true, action: parsed.verb, ref: node.ref, matched: `${node.role} "${node.name}"`, url: page.url(), challenge, cache: await rememberResolution() } as never
    },
  })

  const browserWait = defineTool({
    name: TOOL_NAMES.wait,
    description:
      'Wait for a condition instead of re-observing in a loop. `ms` for a plain settle, `text` for content to appear, '
      + '`urlIncludes` for a navigation, `challengeCleared` for a bot-detection widget to go away. Always cheaper than '
      + 'polling browser_observe.',
    parameters: {
      session: sessionSchema,
      ms: { type: 'number', description: 'Plain wait, capped at 60 000.' },
      text: { type: 'string', description: 'Wait until this text is present.' },
      urlIncludes: { type: 'string' },
      challengeCleared: { type: 'boolean', description: 'Wait until no blocking challenge remains.' },
      timeoutMs: { type: 'number', description: 'Default 30 000, max 120 000.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, matched: { type: 'boolean' }, waitedMs: { type: 'number' }, url: { type: 'string' }, challenge: challengeSchema, refused: { type: 'string' }, message: { type: 'string' } } }, render: renderJson },
    async execute(args, exec) {
      const target = resolveTarget(host, args.session)
      if (!target.ok) return refusalValue(target) as never
      const { page } = target
      const started = Date.now()

      if (typeof args.ms === 'number') {
        const capped = Math.max(0, Math.min(60_000, args.ms))
        await sleep(capped, exec.signal).catch(() => undefined)
        return { ok: true, matched: true, waitedMs: Date.now() - started, url: page.url(), challenge: await detectChallenge(page) } as never
      }

      const timeout = Math.max(500, Math.min(120_000, args.timeoutMs ?? 30_000))
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        if (exec.signal?.aborted) return { ok: false, matched: false, waitedMs: Date.now() - started, message: 'aborted' } as never
        if (args.urlIncludes && page.url().includes(args.urlIncludes)) {
          return { ok: true, matched: true, waitedMs: Date.now() - started, url: page.url(), challenge: await detectChallenge(page) } as never
        }
        if (args.text) {
          const found = await page.evaluateIsolated<boolean>(`(() => (document.body?.innerText || '').includes(${JSON.stringify(args.text)}))()`).catch(() => false)
          if (found) return { ok: true, matched: true, waitedMs: Date.now() - started, url: page.url(), challenge: await detectChallenge(page) } as never
        }
        if (args.challengeCleared) {
          const detection = await detectChallenge(page)
          if (!detection.present || !detection.blocking) {
            return { ok: true, matched: true, waitedMs: Date.now() - started, url: page.url(), challenge: detection } as never
          }
        }
        await sleep(500, exec.signal).catch(() => undefined)
      }
      return { ok: true, matched: false, waitedMs: Date.now() - started, url: page.url(), challenge: await detectChallenge(page), message: 'timed out' } as never
    },
  })

  const browserEvaluate = defineTool({
    name: TOOL_NAMES.evaluate,
    description:
      'Run JavaScript in the page and return a JSON-serializable result. GATED OFF by default '
      + '(policy.allowEvaluate). Prefer browser_observe and the acting tools: a raw evaluate is a main-world '
      + 'execution that undoes the isolation the stealth posture depends on, and `element.click()` from here is a '
      + 'signature that humanized input exists to avoid.',
    parameters: { session: sessionSchema, script: { type: 'string', required: true, description: 'An expression or IIFE returning a JSON-serializable value.' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, result: { type: 'object', additionalProperties: true }, refused: { type: 'string' }, message: { type: 'string' } } }, render: renderJson },
    async execute(args) {
      if (!host.config.policy.allowEvaluate) {
        return {
          ok: false,
          refused: 'policy',
          message: 'browser_evaluate is disabled by policy.allowEvaluate. This is a config gate, not an approval: enabling it trusts the model with arbitrary page JavaScript. Use browser_observe and the acting tools instead.',
        } as never
      }
      const target = resolveTarget(host, args.session)
      if (!target.ok) return refusalValue(target) as never
      if (typeof args.script !== 'string' || args.script.length === 0 || args.script.length > 32_000) {
        return { ok: false, message: 'script must be 1–32 000 characters' } as never
      }
      const result = await target.page.evaluateIsolated<unknown>(args.script).catch(error => ({ __error: errorMessage(error) }))
      return { ok: true, result: (result ?? null) as JsonValue } as never
    },
  })

  // ── challenge ─────────────────────────────────────────────────────────────

  const browserChallenge = defineTool({
    name: TOOL_NAMES.challenge,
    description:
      'Report the bot-detection challenge on the current page and what the pipeline recommends. Returns vendor, '
      + 'whether navigation is actually blocked, the sitekey when there is one, and a `verdict` telling you the next '
      + 'action. Read this BEFORE retrying anything: retrying a blocked page is always the wrong move, and on '
      + 'session-bound vendors (Turnstile, reCAPTCHA v3, DataDome, PerimeterX, Kasada) a remotely minted token is '
      + 'usually rejected even when valid.',
    parameters: { session: sessionSchema },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          detection: challengeSchema,
          verdict: { type: 'string', required: true },
          action: { type: 'string', required: true },
          tier: { type: 'string' },
          sessionBound: { type: 'boolean' },
          warning: { type: 'string' },
          history: { type: 'array', items: { type: 'object', additionalProperties: true } },
          refused: { type: 'string' }, message: { type: 'string' },
        },
      },
      render: renderJson,
      presentationMeta: (_args: unknown, value: JsonValue): JsonValue => {
        const record = (value ?? {}) as Record<string, unknown>
        const detection = (record.detection ?? {}) as Record<string, unknown>
        const present = detection.present === true && typeof detection.vendor === 'string'
        return {
          tool: TOOL_NAMES.challenge,
          phase: 'handoff',
          // The inline challenge marker drives the card's vendor badge. It must
          // be present HERE as well as in client/meta-hydrate's replay, or PTC
          // sessions would render a richer card than standard ones — the twin
          // sync smoke asserts both sides produce identical meta.
          ...(present
            ? {
                challenge: {
                  id: 'inline',
                  vendor: detection.vendor,
                  blocking: detection.blocking === true,
                  resolvedBy: 'unresolved',
                  outcome: 'pending',
                },
              }
            : {}),
          summary: present ? `challenge: ${detection.vendor}${detection.blocking ? ' (blocking)' : ''}` : 'no challenge',
        } as never
      },
    },
    async execute(args, exec) {
      const target = resolveTarget(host, args.session)
      if (!target.ok) return refusalValue(target) as never
      const detection = await detectChallenge(target.page)
      if (!detection.present) {
        return { ok: true, detection, verdict: 'no challenge detected on this page', action: 'none', history: [] } as never
      }
      // Evaluate without running the handoff: this tool REPORTS, browser_handoff ACTS.
      const verdict: Verdict = await challenge.evaluate(detection, target.page.url(), target.page, exec.signal).catch(error => ({
        action: 'blocked' as const,
        record: toRecord(detection, target.page.url()),
        reason: errorMessage(error),
        tier: 'classify' as const,
      }))
      return {
        ok: true,
        detection,
        verdict: describeVerdict(verdict),
        action: verdict.action,
        tier: 'tier' in verdict ? verdict.tier : undefined,
        sessionBound: SESSION_BOUND.has(detection.vendor),
        warning: sessionBoundWarning(detection.vendor) ?? undefined,
        history: challenge.history.slice(-5),
      } as never
    },
  })

  const browserHandoff = defineTool({
    name: TOOL_NAMES.handoff,
    description:
      'Hand the current challenge to the human and WAIT. Pauses the agent, suppresses the persistent frame transport, '
      + 'moves the pointer to the user, focuses the panel on the widget, and blocks until they report an outcome (or '
      + 'the timeout fires). This is the recommended path and the one most likely to succeed: they solve it in THIS '
      + 'session, with this fingerprint and this IP. Returns outcome: passed | failed | abandoned | timeout. Do not '
      + 'retry the blocked action instead of calling this.',
    parameters: {
      session: sessionSchema,
      note: { type: 'string', description: 'Shown to the user in the panel: what you were trying to do and what you need from them.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          outcome: { type: 'string' },
          vendor: { type: 'string' },
          waitedMs: { type: 'number' },
          url: { type: 'string' },
          nextStep: { type: 'string' },
          refused: { type: 'string' }, message: { type: 'string' },
        },
      },
      render: renderJson,
      presentationMeta: (_args: unknown, value: JsonValue): JsonValue => {
        const record = (value ?? {}) as Record<string, unknown>
        return {
          tool: TOOL_NAMES.handoff,
          phase: record.outcome === 'passed' ? 'streaming' : 'handoff',
          url: record.url,
          summary: record.ok === true ? `handoff → ${record.outcome}` : `handoff refused: ${record.message ?? record.refused ?? '?'}`,
        } as never
      },
    },
    async execute(args, exec) {
      const target = resolveTarget(host, args.session)
      if (!target.ok) return refusalValue(target) as never
      const { page, sessionId } = target
      const detection = await detectChallenge(page)
      if (!detection.present) {
        return { ok: true, outcome: 'passed', vendor: 'none', waitedMs: 0, url: page.url(), nextStep: 'no challenge present — continue the task' } as never
      }
      const record = toRecord(detection, page.url())
      const started = Date.now()
      const result = await challenge.runHandoff(record, detection).catch(error => {
        void error
        return { ...record, outcome: 'abandoned' as const, resolvedBy: 'unresolved' as const }
      })
      void sessionId
      void args.note
      const outcome = result.outcome
      return {
        ok: true,
        outcome,
        vendor: detection.vendor,
        waitedMs: Date.now() - started,
        url: page.url(),
        nextStep:
          outcome === 'passed'
            ? 'the human cleared it; observe again and continue'
            : outcome === 'timeout'
              ? 'nobody resolved it in time — report this to the user rather than retrying'
              : 'the challenge was not cleared — report this to the user; retrying will make the score worse',
      } as never
    },
  })

  const browserTakeover = defineTool({
    name: TOOL_NAMES.takeover,
    description:
      'Give the pointer to the human without a challenge being involved — they want to log in, pick a seat, or handle '
      + 'a 2FA prompt. Blocks until they resume (or the timeout fires). While they own the pointer every other '
      + 'browser_* tool returns `refused: pointer-owned`; that is a normal state, so wait rather than queueing actions '
      + 'or opening a second session to get around it.',
    parameters: {
      session: sessionSchema,
      reason: { type: 'string', required: true, description: 'Shown to the user in the panel.' },
      timeoutMs: { type: 'number', description: 'Default 300 000, max 1 800 000.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, resumed: { type: 'boolean' }, waitedMs: { type: 'number' }, url: { type: 'string' }, refused: { type: 'string' }, message: { type: 'string' } } }, render: renderJson },
    async execute(args, exec) {
      const resolved = resolveSession(host, args.session)
      if (!resolved.ok) return refusalValue(resolved) as never
      const started = Date.now()
      const began = await host.beginTakeover(resolved.sessionId, 'user')
      if (!began.ok) return refusalValue(began) as never
      const timeout = Math.max(5_000, Math.min(1_800_000, args.timeoutMs ?? 300_000))
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        if (exec.signal?.aborted) break
        if (!host.takeoverActive(resolved.sessionId)) break
        await sleep(500, exec.signal).catch(() => undefined)
      }
      const resumed = !host.takeoverActive(resolved.sessionId)
      const session = host.session(resolved.sessionId)
      return {
        ok: true,
        resumed,
        waitedMs: Date.now() - started,
        url: session?.browser.activePage()?.url() ?? '',
        ...(resumed ? {} : { message: 'still in takeover when this call ended; the human can resume at any time and your next tool call will succeed' }),
      } as never
    },
  })

  // ── autonomous task ───────────────────────────────────────────────────────

  const browserTask = defineTool({
    name: TOOL_NAMES.task,
    description:
      'Run a SAVED WORKFLOW as a cancellable BACKGROUND job and get a job handle back: the steps replay with '
      + 'humanized input while the conversation continues, progress streams to the panel timeline, and '
      + '`action: cancel` stops it between steps. One running job per session — one pointer, one driver. '
      + 'HONEST SCALE: a natural-language `goal` without a workflow is refused, because an autonomous goal loop '
      + 'needs the harness job runtime (ctx.jobs) this build does not inject yet; demonstrate once with '
      + 'browser_workflow and replay it here as many times as you like. status/list inspect jobs.',
    parameters: {
      session: sessionSchema,
      action: { type: 'string', enum: ['start', 'status', 'cancel', 'list'], required: true, description: 'start = background job from a saved workflow; status/cancel/list manage jobs.' },
      workflow: { type: 'string', description: 'start: saved workflow name (browser_workflow action:list).' },
      vars: { type: 'object', additionalProperties: true, description: 'start: values for the workflow\'s {{variables}} — missing ones refuse the job.' },
      job: { type: 'string', description: 'status/cancel: the job id start returned.' },
      goal: { type: 'string', description: 'Not honored yet — see the honesty note. Pass `workflow` instead.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          job: { type: 'string' },
          steps: { type: 'number' },
          jobs: { type: 'array', items: { type: 'object', additionalProperties: true } },
          id: { type: 'string' },
          workflowName: { type: 'string' },
          status: { type: 'string' },
          stepsDone: { type: 'number' },
          stepsTotal: { type: 'number' },
          fallbacks: { type: 'number' },
          error: { type: 'string' },
          refused: { type: 'string' }, message: { type: 'string' },
        },
      },
      render: renderJson,
    },
    async execute(args) {
      const resolved = resolveSession(host, args.session)
      if (!resolved.ok) return refusalValue(resolved) as never
      const action = String(args.action)
      if (action === 'list') {
        return { ok: true, jobs: host.listJobs(resolved.sessionId) } as never
      }
      if (action === 'status') {
        const jobs = host.listJobs(resolved.sessionId)
        const one = typeof args.job === 'string' ? jobs.find(entry => entry.id === args.job) : (jobs.find(entry => entry.status === 'running') ?? jobs[0])
        if (!one) return { ok: false, message: 'no jobs on this session yet — start one with action:start' } as never
        return { ok: true, id: one.id, workflowName: one.workflow, status: one.status, stepsDone: one.stepsDone, stepsTotal: one.stepsTotal, fallbacks: one.fallbacks, ...(one.error ? { error: one.error } : {}) } as never
      }
      if (action === 'cancel') {
        if (typeof args.job !== 'string' || args.job.length === 0) return { ok: false, message: 'cancel needs the job id from start' } as never
        return (await host.cancelJob(resolved.sessionId, args.job)) as never
      }
      if (action === 'start') {
        if (typeof args.workflow !== 'string') {
          if (typeof args.goal === 'string' && args.goal.trim().length > 0) {
            return { ok: false, refused: 'policy', message: 'autonomous goal loops need the harness job runtime (ctx.jobs); until then a task is a SAVED WORKFLOW replayed in the background — record one with browser_workflow, then start it here' } as never
          }
          return { ok: false, message: 'start needs the saved workflow `name` (browser_workflow action:list)' } as never
        }
        const gate = host.gate(resolved.sessionId)
        if (!gate.ok) return refusalValue(gate) as never
        const vars = (args.vars && typeof args.vars === 'object' ? args.vars : {}) as Record<string, string>
        const result = await host.startJob(resolved.sessionId, args.workflow, vars)
        if (result.ok) acted(resolved.sessionId, TOOL_NAMES.task, `job ${result.job ?? '?'} started: ${args.workflow} (${result.steps ?? 0} steps)`)
        return result as never
      }
      return { ok: false, message: 'action must be one of start/status/cancel/list' } as never
    },
  })

  const browserDesktopView = defineTool({
    name: TOOL_NAMES.desktopView,
    description:
      'Ask the site for its DESKTOP layout — the automation equivalent of Chrome-for-Android\'s "Request desktop site". '
      + 'Swaps the UA string AND the UA client hints (sec-ch-ua-mobile: ?0, Windows platform) so headers, JS API and UA '
      + 'never contradict each other, drops touch emulation where the device had it, widens the viewport to 1366x768, '
      + 'applies to every tab of the session, and reloads the active tab so the server actually sees the new UA. '
      + 'Use it when the mobile layout buries the control you need (hamburger menus, app-store interstitials, touch-only '
      + 'widgets). Refused mid-challenge — re-fingerprinting during a bot probe is exactly what the probe is scoring.',
    parameters: {
      session: sessionSchema,
      enabled: { type: 'boolean', required: true, description: 'true = desktop layout, false = restore the device layout.' },
      reload: { type: 'boolean', description: 'Reload the active tab after toggling. Default true — without a new request the server keeps serving the HTML it already chose. Pass false only when you will navigate yourself next.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          enabled: { type: 'boolean' },
          refused: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: renderJson,
    },
    async execute(args) {
      const resolved = resolveSession(host, args.session)
      if (!resolved.ok) return refusalValue(resolved) as never
      if (typeof args.enabled !== 'boolean') {
        return { ok: false, message: '`enabled` is required and must be a boolean — this tool never guesses which way you want the layout' } as never
      }
      const enabled = args.enabled === true
      const result = await host.setDesktopView(resolved.sessionId, enabled, { reload: args.reload !== false })
      if (result.ok) {
        if (args.reload !== false) clearMarks(resolved.sessionId)
        acted(resolved.sessionId, TOOL_NAMES.desktopView, `desktop view ${enabled ? 'on' : 'off'}`)
        return { ok: true, enabled } as never
      }
      return refusalValue(result) as never
    },
  })

  const browserCookies = defineTool({
    name: TOOL_NAMES.cookies,
    description:
      'Read or clear browser cookies for the session profile — METADATA only (name, domain, flags, expiry). '
      + 'Cookie VALUES never leave the browser: they are credentials, and surfacing them in a conversation would '
      + 'turn the transcript into a credential dump. Use it to check whether a login persisted, which trackers a '
      + 'site planted, or to reset one domain. `clear` requires an explicit `domain` — there is no wipe-everything '
      + 'mode (that would be a profile-wide logout).',
    parameters: {
      session: sessionSchema,
      action: { type: 'string', enum: ['list', 'clear'], description: 'list (default) or clear.' },
      domain: { type: 'string', description: 'Domain filter (suffix match). REQUIRED for `clear`.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          cookies: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                domain: { type: 'string', required: true },
                path: { type: 'string' },
                expires: { type: 'number', description: 'Unix seconds; -1 for session cookies.' },
                httpOnly: { type: 'boolean' },
                secure: { type: 'boolean' },
              },
            },
          },
          count: { type: 'number' },
          cleared: { type: 'number' },
          refused: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: renderJson,
    },
    async execute(args) {
      const resolved = resolveSession(host, args.session)
      if (!resolved.ok) return refusalValue(resolved) as never
      const action = (args.action ?? 'list') as string
      if (action === 'clear') {
        const domain = String(args.domain ?? '').trim()
        if (domain.length === 0) {
          return { ok: false, message: 'clear requires an explicit `domain` — there is no wipe-everything mode (that would be a profile-wide logout)' } as never
        }
        const result = await host.clearCookies(resolved.sessionId, domain)
        if (!result.ok) return refusalValue(result) as never
        acted(resolved.sessionId, TOOL_NAMES.cookies, `cookies cleared on ${domain}`)
        return { ok: true, cleared: result.cleared } as never
      }
      const result = await host.listCookies(resolved.sessionId, args.domain === undefined ? undefined : String(args.domain))
      if (!result.ok) return refusalValue(result) as never
      return { ok: true, cookies: result.cookies, count: result.cookies.length } as never
    },
  })

  const browserFiles = defineTool({
    name: TOOL_NAMES.files,
    description:
      'Upload local files into a file input, or save a download the page offers. '
      + 'UPLOAD FENCE: paths must live under the browser profile root — a model-named path '
      + 'never reaches setInputFiles unchecked, so a prompt injection cannot exfiltrate arbitrary disks into a '
      + 'website. Stage files there first (your own tooling) or widen the root deliberately. '
      + 'DOWNLOAD: arms a download listener, clicks the ref, streams into <profile>/downloads/<session>/ and answers '
      + 'with size + suggested filename; the bytes stay on this machine.',
    parameters: {
      session: sessionSchema,
      action: { type: 'string', enum: ['upload', 'download'], required: true, description: 'upload = set input files; download = click and save.' },
      ref: refSchema,
      paths: { type: 'array', items: { type: 'string' }, description: 'upload: file paths under the profile root.' },
      timeoutMs: { type: 'number', description: 'download: how long to wait for the download event. Default 20000.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          uploaded: { type: 'number' },
          path: { type: 'string' },
          bytes: { type: 'number' },
          suggested: { type: 'string' },
          refused: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: renderJson,
    },
    async execute(args) {
      const resolved = resolveSession(host, args.session)
      if (!resolved.ok) return refusalValue(resolved) as never
      const gate = host.gate(resolved.sessionId)
      if (!gate.ok) return refusalValue(gate) as never
      const page = gate.session.browser.activePage()
      if (!page) return { ok: false, message: 'no active page' } as never
      const action = String(args.action)
      if (action === 'upload') {
        const refs = typeof args.ref === 'string' ? args.ref : undefined
        const paths = Array.isArray(args.paths) ? (args.paths as string[]) : []
        if (!refs) return { ok: false, message: 'upload needs the file input `ref`' } as never
        if (paths.length === 0 || paths.length > 10) return { ok: false, message: 'upload needs 1..10 paths' } as never
        const root = resolvePath(profileRoot())
        const clean: string[] = []
        for (const raw of paths) {
          const abs = resolvePath(String(raw))
          if (abs !== root && !abs.startsWith(root + '/')) {
            return { ok: false, message: `upload fence: ${String(raw)} is outside the browser profile root — stage it there first or widen the root deliberately` } as never
          }
          clean.push(abs)
        }
        await page.setFiles(refs, clean)
        acted(resolved.sessionId, TOOL_NAMES.files, `upload ${clean.length} file(s)`)
        return { ok: true, uploaded: clean.length } as never
      }
      if (action === 'download') {
        const refs = typeof args.ref === 'string' ? args.ref : undefined
        if (!refs) return { ok: false, message: 'download needs the ref that triggers it' } as never
        const dir = join(profileRoot(), 'downloads', resolved.sessionId)
        await mkdir(dir, { recursive: true })
        const timeout = typeof args.timeoutMs === 'number' ? args.timeoutMs : 20_000
        // Save under a temp name first: suggestedFilename() is only known after
        // the event fires, and a site-controlled filename must never become a path.
        const tmp = join(dir, `dl-${Date.now().toString(36)}.part`)
        const { bytes, suggested } = await page.downloadByClick(refs, tmp, timeout)
        const safe = suggested.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'download.bin'
        const finalPath = join(dir, safe)
        const { rename, unlink } = await import('node:fs/promises')
        await rename(tmp, finalPath).catch(async () => { await unlink(tmp).catch(() => undefined); throw new Error('could not finalize download path') })
        acted(resolved.sessionId, TOOL_NAMES.files, `download ${safe}`)
        return { ok: true, path: finalPath, bytes, suggested: safe } as never
      }
      return { ok: false, message: 'action must be upload or download' } as never
    },
  })

  const browserWorkflow = defineTool({
    name: TOOL_NAMES.workflow,
    description:
      'Record a human demonstration once, replay it on demand. '
      + 'start/stop arms recording of HUMAN gestures — the user takes over the pointer and demonstrates; stop saves a '
      + 'plain-JSON step list under the browser profile (inspectable, hand-editable, reusable by name). '
      + 'run replays with humanized input: identity-first element matching (role/name/placeholder), normalized-coordinate '
      + 'fallback when the page shifted. list shows saved workflows; delete removes one. '
      + 'SECRETS: anything typed into a password-shaped field is never stored — it becomes a required {{variable}} '
      + 'you pass to run via vars.',
    parameters: {
      session: sessionSchema,
      action: { type: 'string', enum: ['start', 'stop', 'list', 'run', 'delete'], required: true, description: 'start/stop = record; run = replay; list/delete manage saved workflows.' },
      name: { type: 'string', description: 'Workflow name (start: optional label; run/delete: required).' },
      vars: { type: 'object', additionalProperties: true, description: 'run: values for the workflow\'s {{variables}} — secrets go here at replay time, never into the saved file.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, name: { type: 'string' }, steps: { type: 'number' }, variables: { type: 'array', items: { type: 'string' } }, truncated: { type: 'boolean' }, workflows: { type: 'array', items: { type: 'object', additionalProperties: true } }, replayed: { type: 'number' }, fallbacks: { type: 'number' }, refused: { type: 'string' }, message: { type: 'string' } } }, render: renderJson },
    async execute(args) {
      const action = String(args.action)
      const name = typeof args.name === 'string' ? args.name : undefined
      if (action === 'list') {
        const workflows = await host.listWorkflows()
        return { ok: true, workflows } as never
      }
      if (action === 'delete') {
        if (!name) return { ok: false, message: 'delete needs the workflow `name`' } as never
        return (await host.deleteWorkflow(name)) as never
      }
      const resolved = resolveSession(host, args.session)
      if (!resolved.ok) return refusalValue(resolved) as never
      if (action === 'start') {
        // No gate() here on purpose: recording REQUIRES the user to own the
        // pointer, which is exactly when gate() refuses. setRecording enforces it.
        const result = await host.setRecording(resolved.sessionId, true, name)
        if (result.ok) acted(resolved.sessionId, TOOL_NAMES.workflow, `recording started as ${result.name ?? 'workflow'}`)
        return result as never
      }
      if (action === 'stop') {
        const result = await host.setRecording(resolved.sessionId, false, name)
        if (result.ok) acted(resolved.sessionId, TOOL_NAMES.workflow, `saved ${result.name ?? 'workflow'} — ${result.steps ?? 0} step(s)`)
        return result as never
      }
      if (action === 'run') {
        if (!name) return { ok: false, message: 'run needs the workflow `name` — see action:list' } as never
        const gate = host.gate(resolved.sessionId)
        if (!gate.ok) return refusalValue(gate) as never
        const vars = (args.vars && typeof args.vars === 'object' ? args.vars : {}) as Record<string, string>
        const result = await host.runWorkflow(resolved.sessionId, name, vars)
        if (result.ok) acted(resolved.sessionId, TOOL_NAMES.workflow, `replayed ${name} — ${result.replayed ?? 0} step(s), ${result.fallbacks ?? 0} coord fallback(s)`)
        return result as never
      }
      return { ok: false, message: 'action must be one of start/stop/list/run/delete' } as never
    },
  })

  // Keyed by WIRE NAME, not by local variable: consumers (the host entry's
  // effect labels, the smoke suites, third-party composition) all think in
  // `browser_click`, never `browserClick`.
  const all = [
    browserStart, browserStop, browserStatus, browserObserve, browserSee, browserClick, browserType, browserPress,
    browserScroll, browserNavigate, browserTabs, browserFillForm, browserExtract, browserWait,
    browserEvaluate, browserChallenge, browserHandoff, browserTakeover, browserTask, browserAct, browserDesktopView,
    browserCookies,
    browserFiles,
    browserWorkflow,
  ]
  return Object.fromEntries(all.map(tool => [tool.name, tool]))
}

// ── helpers ─────────────────────────────────────────────────────────────────

const MAX_NODES_FOR_LABEL = 200

/** Vendors where a remote token is likely to be rejected. Mirrors detector.ts. */
const SESSION_BOUND = new Set([
  'cloudflare-turnstile', 'cloudflare-managed', 'recaptcha-v3', 'recaptcha-enterprise',
  'datadome', 'perimeterx', 'kasada', 'akamai',
])

interface NameResult { role: string; name: string }

function findName(nodes: Array<{ ref: string; role: string; name: string; children?: unknown[] }>, ref: string): NameResult | undefined {
  for (const node of nodes) {
    if (node.ref === ref) return { role: node.role, name: node.name }
    const children = node.children as typeof nodes | undefined
    if (children) {
      const found = findName(children, ref)
      if (found) return found
    }
  }
  return undefined
}

// ── browser_act: deterministic instruction → element resolution ─────────────

/** A match this weak is a guess, not an act. */
const ACT_MIN_SCORE = 0.34
/** Top-two within this distance is ambiguous — return candidates, never pick. */
const ACT_MARGIN = 0.08

interface ParsedAct {
  verb: 'click' | 'type' | 'scroll' | 'open' | 'check'
  /** The element descriptor, e.g. `Sign in` from `click "Sign in"`. */
  target: string
  /** Text payload for `type`. */
  text?: string
  direction?: 'up' | 'down' | 'left' | 'right'
  pressEnter?: boolean
}

const ACT_VERBS: Record<string, ParsedAct['verb']> = {
  click: 'click', tap: 'click', press: 'click', hit: 'click', select: 'click', choose: 'click',
  type: 'type', fill: 'type', enter: 'type', write: 'type', input: 'type',
  scroll: 'scroll', swipe: 'scroll',
  open: 'open', goto: 'open', navigate: 'open', visit: 'open', load: 'open',
  check: 'check', uncheck: 'check', tick: 'check', toggle: 'check',
}

/**
 * Parse `click "Sign in"`, `type hunter2 into password`, `scroll down`,
 * `open https://…`.
 *
 * Deliberately small and deterministic — this is string parsing, not an LLM.
 * Anything it cannot parse returns undefined and the tool tells the model to
 * use a specific verb instead of guessing.
 */
export function parseActInstruction(instruction: string): ParsedAct | undefined {
  const text = instruction.trim().replace(/\s+/g, ' ')
  const first = text.split(' ')[0]?.toLowerCase().replace(/[^a-z]/g, '') ?? ''
  const verb = ACT_VERBS[first]
  if (!verb) return undefined
  const rest = text.slice(text.indexOf(' ') + 1).trim()

  if (verb === 'scroll' || first === 'swipe') {
    const direction = /\bup\b/i.test(rest) ? 'up' : /\bleft\b/i.test(rest) ? 'left' : /\bright\b/i.test(rest) ? 'right' : 'down'
    return { verb: 'scroll', target: direction, direction }
  }
  if (verb === 'open') {
    const url = rest.match(/https?:\/\/\S+/i)?.[0] ?? rest
    return { verb: 'open', target: url, text: url }
  }
  if (verb === 'type') {
    // `type TEXT into FIELD` | `type TEXT in FIELD` | `fill FIELD with TEXT`
    const intoMatch = rest.match(/^(.*?)(?:\s+into\s+|\s+in\s+)(.+)$/i)
    if (intomatch(intoMatch)) {
      const pressEnter = /and press enter|then enter|press enter|submit/i.test(rest)
      const payload = intoMatch![1]!.trim().replace(/\s+(?:and|then)?\s*(?:press enter|press the enter key|submit|hit enter)\s*$/i, '')
      const field = intoMatch![2]!.trim().replace(/\s+(?:and|then)\s+(?:press enter|submit|hit enter|go|click .*)$/i, '')
      return { verb: 'type', target: field, text: unquote(payload), pressEnter }
    }
    const withMatch = rest.match(/^(.*?)(?:\s+with\s+)(.+)$/i)
    if (withMatch) {
      const pressEnter = /press enter|submit/i.test(rest)
      // Keep the trailing "and press enter" clause OUT of the typed text.
      const payload = withMatch[2]!.trim().replace(/\s+(?:and|then)?\s*(?:press enter|press the enter key|submit|hit enter)\s*$/i, '')
      return { verb: 'type', target: withMatch[1]!.trim(), text: unquote(payload), pressEnter }
    }
    // No field named: type into whatever is focused.
    return { verb: 'type', target: '', text: unquote(rest), pressEnter: /press enter|submit/i.test(rest) }
  }
  // click / check: target is the quoted or trailing noun phrase.
  return { verb, target: unquote(rest) }
}

function intomatch(match: RegExpMatchArray | null): boolean {
  return !!match && !!match[1] && !!match[2]
}

function unquote(value: string): string {
  const quoted = value.match(/^["'“](.*)["'”]$/s) ?? value.match(/["'“](.*?)["'”]/s)
  return (quoted ? quoted[1]! : value).trim()
}

function tokenize(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length > 1)
}

const STOPWORDS = new Set(['the', 'a', 'an', 'button', 'link', 'that', 'this', 'with', 'into', 'on', 'in', 'at', 'to', 'and', 'for', 'of', 'it', 'is'])

/**
 * Rank interactive elements against a target phrase.
 *
 * Score blends: token overlap on the accessible name (weighted highest — it is
 * what the user reads), a role-name match, a substring match on the raw name,
 * and a small preference for elements near the top of the tree. Purely lexical
 * and stable: the same page and instruction always rank the same way, which is
 * the property a refusal-to-guess confidence gate needs.
 */
export function rankElements(
  elements: Array<{ ref: string; role: string; name: string; value?: string }>,
  target: string,
  verb: string,
): Array<{ node: { ref: string; role: string; name: string }; score: number }> {
  const wanted = tokenize(target).filter(token => !STOPWORDS.has(token))
  if (wanted.length === 0) {
    // No usable tokens (e.g. `type into the focused field`): nothing to rank on.
    return []
  }
  const raw = target.toLowerCase()
  const wantsInput = verb === 'type' || verb === 'check'
  const scored: Array<{ node: { ref: string; role: string; name: string }; score: number }> = []

  for (const [index, node] of elements.entries()) {
    const name = node.name ?? ''
    const value = node.value ?? ''
    const haystack = `${name} ${value}`.toLowerCase()
    const nameTokens = tokenize(`${name} ${value}`).filter(token => !STOPWORDS.has(token))
    const role = node.role.toLowerCase()

    let score = 0
    // Token overlap.
    let hits = 0
    for (const token of wanted) if (nameTokens.includes(token)) hits += 1
    if (wanted.length > 0) score += 0.62 * (hits / wanted.length)
    // Exact substring on the readable name is the strongest signal.
    if (raw.length > 1 && haystack.includes(raw)) score += 0.3
    else {
      // Partial: longest wanted token appearing verbatim.
      const longest = wanted.reduce((a, b) => (b.length > a.length ? b : a), '')
      if (longest.length > 2 && haystack.includes(longest)) score += 0.12
    }
    // Role alignment with the verb.
    const isField = /textbox|searchbox|combobox|input|textarea|spinbutton/.test(role)
    const isButton = /button|link|menuitem|tab|checkbox|radio|option|switch/.test(role)
    if (wantsInput && isField) score += 0.12
    else if (!wantsInput && isButton) score += 0.1
    else if (wantsInput && !isField) score -= 0.05
    // Word-boundary match on any wanted token (catches "Sign in" vs "signin").
    if (wanted.some(token => new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(haystack))) score += 0.04
    // Mild top-of-page preference, bounded so it never flips a real name match.
    score += Math.max(0, 0.02 - index * 0.0002)

    if (score > 0) scored.push({ node: { ref: node.ref, role: node.role, name }, score })
  }

  scored.sort((a, b) => b.score - a.score)
  return scored
}

async function scrollPosition(page: { evaluateIsolated<T>(fn: string): Promise<T> }): Promise<number> {
  return page.evaluateIsolated<number>('(() => window.scrollY || 0)()').catch(() => 0)
}

/** Capture after an action settled, so the model can verify without a second observe. */
async function captureAfter(
  host: BrowserHostController,
  sessionId: string,
  page: { capture(o?: { format?: 'png' | 'jpeg'; quality?: number }): Promise<Uint8Array>; title(): Promise<string>; viewport(): { width: number; height: number } },
  vision: BrowserVisionServices,
  exec: { signal?: AbortSignal; agent?: unknown },
): Promise<{ title: string; capturePath?: string; image?: unknown }> {
  const title = await page.title().catch(() => '')
  const jpeg = await page.capture({ format: 'jpeg', quality: host.config.frames.jpegQuality }).catch(() => undefined)
  if (!jpeg || jpeg.byteLength === 0) return { title }
  const saved = await host.saveCapture(sessionId, jpeg, 'jpg').catch(() => undefined)
  const out: { title: string; capturePath?: string; image?: unknown } = { title }
  if (saved) out.capturePath = saved.path
  if (await imageInputActive(vision, exec as never)) {
    const ref = await saveCaptureAttachment(vision, {
      data: jpeg,
      width: page.viewport().width,
      height: page.viewport().height,
      mediaType: 'image/jpeg',
      name: `browser-action-${Date.now()}.jpg`,
    })
    if (ref) out.image = ref
  }
  return out
}

function describeVerdict(verdict: Verdict): string {
  switch (verdict.action) {
    case 'none': return 'no challenge detected'
    case 'continue': return verdict.reason
    case 'handoff': return `call browser_handoff — a human should solve this ${verdict.record.vendor} in the panel`
    case 'solved': return `solved by ${verdict.record.adapter?.name ?? 'adapter'} in ${verdict.latencyMs} ms (inSession: ${verdict.inSession})`
    case 'blocked': return verdict.reason
    default: return 'unknown verdict'
  }
}

export { FRAME_SOURCES }
export type { FrameSource }
