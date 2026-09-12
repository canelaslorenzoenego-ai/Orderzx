/**
 * @dsh-community/dsh-browser — a live, stealth-capable Chrome inside a DeepSeek
 * Harness conversation.
 *
 * The pitch, in one line: the agent drives a real browser, the user watches it
 * live in a panel that extends the dashboard, and the user can grab the mouse at
 * any moment — including to solve a CAPTCHA in the very session that needs it.
 *
 * Plugin lifecycle (mirrors dsh-android's discipline):
 *   - ONE BrowserHostController owns every browser session, frame loop and
 *     pointer-ownership state for the mount. Tools hold a reference; they never
 *     own a browser.
 *   - Every tool registers through `ctx.effect`, so unloading the plugin
 *     unregisters it. The returned teardown stops the loops and closes browsers.
 *   - Optional services are reached with scoped `ctx.inject([...])`, never a
 *     `ctx.foo?.` guard: Cordis refuses the mere PROPERTY ACCESS on an
 *     undeclared service and the throw takes the whole plugin down with it.
 *     Headless and sdk profiles therefore load this plugin fine and simply get
 *     no routes, no skill and no approval prompts.
 *
 * @module @dsh-community/dsh-browser
 */

import type { Context } from '@deepseek-ai/cordis'
import type ToolRegistry from '@deepseek-ai/dsh-tools'
import { BrowserHostController, type HostEvent } from './host.js'
import { Config, resolveConfig, redactConfig } from './config.js'
import type { BrowserConfig } from './protocol.js'
import { PLUGIN_NAME, TOOL_NAMES } from './protocol.js'
import { createBrowserTools, BROWSER_TOOL_NAMES } from './tools.js'
import { installRoutes } from './routes.js'
import { AccessController } from './access.js'
import { pruneAll } from './capture-store.js'
import { registerBrowserSkill } from './skill.js'
import { resolveVisionServices } from './vision.js'
import { ChallengePipeline, hostnameOf, type SolverAdapter } from './challenge/pipeline.js'
import { buildAdapters, launchArgsForExtension, type ExtensionAdapterConfig, type TokenApiConfig } from './challenge/adapters.js'
import { configureCloak } from './engine/cloakbrowser.js'
import { configureCdpEndpoint } from './engine/cdp.js'
import './engine/index.js' // registers the builtin providers

// ── public API ──────────────────────────────────────────────────────────────

export * from './protocol.js'
export * from './json-value.js'
export * from './engine/index.js'
export { FrameLoop, MultipartFrameWriter, pngDimensions, renderSyntheticFrame, withTimeout, type FrameStats, type FrameSourceConfig } from './frames.js'
export {
  AccessController, captureDir, classifyCapturePath, isLoopbackRemoteAddress, isTrustedRequest,
  nextCapturePath, openVerifiedCapture, prepareAccessKey, profileRoot, stateRoot,
  parseCapturePayload, parseControlPayload, parseStreamPayload,
  type CaptureVerdict,
} from './access.js'
export { prune, pruneAll, saveCapture, storeSize } from './capture-store.js'
export { buildReelHtml } from './reels.js'
export {
  BrowserHostController, hostMatches, isPrivateHost,
  type ActionResult, type HostEvent, type HostSession, type PointerOwner, type Refusal,
} from './host.js'
// The route path constants are exported by the protocol star-export above;
// routes.js only owns the handlers.
export {
  Routes, installRoutes, mountRoutes,
  validateControl, type RouteHandlers, type WebServerMount,
} from './routes.js'
export { Config, DEFAULT_CONFIG, redactConfig, resolveConfig } from './config.js'
export { createBrowserTools, BROWSER_TOOL_NAMES } from './tools.js'
export {
  ACTION_SETTLE_MS, detectChallenge, flatten, observe, refusalValue, resolveSession, resolveTarget,
  toRecord, type FlatNode, type ObservationResult, type ResolvedTarget,
} from './tool-support.js'
export {
  DOM_PROBE, NO_CHALLENGE, PROOF_OF_WORK_VENDORS, SESSION_BOUND_VENDORS, detectFromResponse,
  detectFromUrl, normalizeProbe, type Detection,
} from './challenge/detector.js'
export {
  ChallengePipeline, hostnameOf, sessionBoundWarning,
  type PipelineConfig, type PipelineDeps, type SolveRequest, type SolveResult, type SolverAdapter, type Verdict,
} from './challenge/pipeline.js'
export {
  ExtensionSolverAdapter, TokenApiSolverAdapter, buildAdapters, launchArgsForExtension, noneAdapter,
  type ExtensionAdapterConfig, type TokenApiConfig,
} from './challenge/adapters.js'
export {
  BROWSER_SKILL_CONTENT, BROWSER_SKILL_DESCRIPTION, BROWSER_SKILL_NAME, BROWSER_SKILL_WHEN_TO_USE,
  registerBrowserSkill,
} from './skill.js'
export {
  IMAGE_REF_SCHEMA, imageInputActive, renderJson, renderJsonWithImage, resolveVisionServices,
  saveCaptureAttachment, type AttachmentStoreLike, type BrowserImageRef, type BrowserVisionServices,
  type LlmServiceLike, type VisionExecLike,
} from './vision.js'

// ── plugin entry ────────────────────────────────────────────────────────────

export const name = PLUGIN_NAME

/** Services this plugin's root fiber requires. */
export const inject = ['tools']

/** Cordis validates the user's YAML against this and applies defaults before `apply`. */
export { Config as default }

/**
 * rc-line source worktrees augmented the legacy `cordis` package name while the
 * published line augments `@deepseek-ai/cordis`. Keep the build structural so the
 * same source type-checks against both without changing the runtime contract.
 */
type HostContext = Context & {
  tools: ToolRegistry
}

/** Structural face of the optional `approval` service. */
interface ApprovalServiceLike {
  request?(input: { title: string; detail?: string; kind?: string }): Promise<boolean>
  ask?(input: { title: string; detail?: string; kind?: string }): Promise<boolean>
}

export function apply(ctx: Context, userConfig?: unknown): () => Promise<void> {
  const hostCtx = ctx as HostContext
  const config: BrowserConfig = resolveConfig(userConfig)

  // Push config into the provider modules BEFORE any launch. These are
  // process-level singletons because a driver's launch args cannot be threaded
  // through a per-call option bag — but they are config-only, never model-set.
  // All of these are config-only. None of them may ever come from a tool
  // argument: an executable path or an API key that a model can set is a
  // privilege escalation, not a feature.
  const licenseKey = cloakFlag(config, 'licenseKey', null)
  configureCloak({
    ...(typeof licenseKey === 'string' && licenseKey.length > 0 ? { licenseKey } : {}),
    allowBinaryDownload: cloakFlag(config, 'allowBinaryDownload', false) === true,
    humanPreset: cloakFlag(config, 'humanPreset', 'default') === 'careful' ? 'careful' : 'default',
    fingerprint: typeof cloakFlag(config, 'fingerprint', null) === 'string' ? (cloakFlag(config, 'fingerprint', null) as string) : null,
    hardened: cloakFlag(config, 'hardened', false) === true,
  })
  const cdpEndpointConfig = (config.engine as Record<string, unknown>).cdpEndpoint
  configureCdpEndpoint(typeof cdpEndpointConfig === 'string' ? cdpEndpointConfig : null)

  const access = new AccessController()
  const disposers: Array<() => void | Promise<void>> = []

  // Host events → the session log. This is what makes a browser run traceable
  // in the Trajectory view: phase transitions, frame-tier changes (including
  // every automatic stealth suppression), pointer handovers and every challenge.
  const onEvent = (event: HostEvent): void => {
    switch (event.type) {
      case 'phase':
        ctx.logger.info(`dsh-browser[${event.session}] phase → ${event.phase}${event.detail ? ` (${event.detail})` : ''}`)
        break
      case 'frame-tier':
        // Worth a warning: an automatic downgrade means the stealth posture
        // changed underneath the user, and they should be able to see why.
        ctx.logger.warn(`dsh-browser[${event.session}] frame tier ${event.from} → ${event.to}: ${event.reason}`)
        break
      case 'takeover':
        ctx.logger.info(`dsh-browser[${event.session}] pointer → ${event.owner}`)
        break
      case 'challenge':
        ctx.logger.warn(
          `dsh-browser[${event.session}] challenge ${event.record.vendor}`
          + `${event.record.blocking ? ' (blocking)' : ''} → ${event.record.outcome}/${event.record.resolvedBy}`
          + (event.record.adapter ? ` via ${event.record.adapter.name} inSession=${event.record.adapter.inSession}` : ''),
        )
        break
      case 'closed':
        ctx.logger.info(`dsh-browser[${event.session}] closed: ${event.reason}`)
        break
    }
  }

  const host = new BrowserHostController({ config, access, onEvent })

  // ── approvals ─────────────────────────────────────────────────────────────
  //
  // `ctx.approval` resolves asks before the monotonic guards in the tool
  // execution pipeline. Reached through a scoped inject so a headless profile
  // without the service still loads — and so a missing approval service FAILS
  // CLOSED on sensitive verbs rather than silently allowing them.
  let requestApproval: ((input: { title: string; detail: string; kind: string }) => Promise<boolean>) | undefined
  const approvalFiber = ctx.inject(['approval'], approvalCtx => {
    const service = (approvalCtx as Context & { approval: ApprovalServiceLike }).approval
    const method = service?.request ?? service?.ask
    if (typeof method === 'function') {
      requestApproval = input =>
        method
          .call(service, { title: input.title, detail: input.detail, kind: input.kind })
          .then(result => result === true)
          .catch(() => false)
      ctx.logger.info('dsh-browser: approval service available — sensitive actions will prompt')
    }
  })
  disposers.push(() => void approvalFiber.dispose())

  // ── challenge pipeline ────────────────────────────────────────────────────
  const adapters: Map<string, SolverAdapter> = buildAdapters({
    adapter: config.challenge.adapter,
    extension: extensionConfigOf(config),
    tokenApi: tokenApiConfigOf(config),
  })

  const pipeline = new ChallengePipeline({
    config: {
      autoSolver: config.challenge.autoSolver,
      adapter: config.challenge.adapter,
      allowedDomains: config.challenge.allowedDomains as string[],
      handoffByDefault: config.challenge.handoffByDefault,
      handoffTimeoutMs: config.challenge.handoffTimeoutMs,
    },
    adapters,
    // The handoff tier delegates to the host controller, which owns the pause,
    // the frame suppression and the pointer handover.
    handoff: async record => {
      const sessionId = host.activeSessionId()
      if (!sessionId) return 'abandoned'
      const result = await host.beginHandoff(sessionId, record)
      return result.ok ? result.outcome : 'abandoned'
    },
    // Tier 3 on a new domain is a mandatory one-shot approval, on top of the
    // config allowlist. Both are required; neither alone is enough.
    approveDomain: async (domain, vendor, adapter) => {
      if (!requestApproval) return false
      return requestApproval({
        kind: 'browser-challenge-solver',
        title: `Automated CAPTCHA solving on ${domain}`,
        detail:
          `The agent hit a ${vendor} challenge on ${domain} and wants to use the '${adapter}' solver.\n\n`
          + 'This sends the challenge to a third-party solving service using your own credentials. '
          + 'Only approve this for sites you own or are authorised to test.\n\n'
          + 'Declining hands the challenge to you in the panel instead, which is the recommended path.',
      })
    },
    audit: record => {
      // Every tier-3 attempt is logged, including refusals and failures. A
      // solver that runs without leaving a trace is not auditable tooling.
      ctx.logger.info(`dsh-browser challenge audit: ${JSON.stringify(record)}`)
    },
  })

  // ── tools ─────────────────────────────────────────────────────────────────
  const vision = resolveVisionServices(ctx)
  const tools = createBrowserTools(host, {
    vision,
    challenge: pipeline,
    ...(requestApproval ? { requestApproval } : {}),
  })

  for (const [key, tool] of Object.entries(tools)) {
    disposers.push(ctx.effect(() => hostCtx.tools.register(tool), `${PLUGIN_NAME}:${key}`))
  }

  // ── playbook ──────────────────────────────────────────────────────────────
  disposers.push(registerBrowserSkill(ctx))

  // ── signed loopback routes ────────────────────────────────────────────────
  installRoutes(ctx, host, access)

  const posture = redactConfig(config)
  ctx.logger.info(
    `dsh-browser mounted (${BROWSER_TOOL_NAMES.join(' + ')}); engine=${posture.engine?.toString?.() ?? config.engine.provider}, `
    + `frames=${config.frames.source}@${config.frames.maxFps}fps, humanize=${config.engine.humanize}, `
    + `headless=${config.engine.headless}, solver=${config.challenge.autoSolver}`,
  )
  void TOOL_NAMES

  return async () => {
    for (const dispose of disposers.reverse()) await dispose()
    await host.dispose()
    // Final sweep: a long session at 5 fps writes a lot of JPEGs into tmp.
    await pruneAll(0).catch(() => undefined)
  }
}

// ── config readers ──────────────────────────────────────────────────────────

function cloakFlag(config: BrowserConfig, key: string, fallback: unknown): unknown {
  const cloak = (config.engine as Record<string, unknown>).cloak
  if (typeof cloak !== 'object' || cloak === null) return fallback
  const value = (cloak as Record<string, unknown>)[key]
  return value === undefined ? fallback : value
}

function adapterConfig(config: BrowserConfig): Record<string, unknown> {
  const value = (config.challenge as Record<string, unknown>).adapterConfig
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function extensionConfigOf(config: BrowserConfig): Partial<ExtensionAdapterConfig> {
  const raw = adapterConfig(config)
  return {
    extensionPath: typeof raw.extensionPath === 'string' ? raw.extensionPath : null,
    waitMs: typeof raw.waitMs === 'number' ? raw.waitMs : 60_000,
  }
}

function tokenApiConfigOf(config: BrowserConfig): Partial<TokenApiConfig> {
  const raw = adapterConfig(config)
  return {
    flavor: config.challenge.adapter === 'capsolver-api' ? 'capsolver' : 'twocaptcha',
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : null,
    endpoint: typeof raw.endpoint === 'string' ? raw.endpoint : null,
    timeoutMs: typeof raw.timeoutMs === 'number' ? raw.timeoutMs : 180_000,
    // Deliberately excludes the session-bound vendors: a remote token for
    // Turnstile/reCAPTCHA-v3/DataDome/PerimeterX/Kasada is usually rejected, so
    // the default configuration will not even attempt them and falls through to
    // handoff. Adding one requires editing this list, which means reading it.
    handles: ['recaptcha-v2', 'hcaptcha', 'funcaptcha', 'geetest'],
  }
}


