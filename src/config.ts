/**
 * Cordis config schema and defaults.
 *
 * Exporting `Config` makes Cordis validate the user's YAML against this shape
 * and apply `default` before `apply(ctx, config)` runs — so nothing downstream
 * has to defend against a half-specified config object.
 *
 * Two rules this file exists to enforce:
 *
 *  1. **Paths and credentials come from config only.** `userDataDir`,
 *     `extensionPath`, `apiKey`, `cdpEndpoint` are never tool arguments. A model
 *     that can set an executable path can run arbitrary code with the harness's
 *     privileges; a model that can read `apiKey` has exfiltrated a paid account.
 *  2. **Dangerous defaults are off.** `allowEvaluate: false`,
 *     `autoSolver: 'off'`, `allowBinaryDownload: false`, `source: 'screenshot'`.
 *     Each one has a comment saying what turning it on costs.
 *
 * @module @dsh-community/dsh-browser/config
 */

import { DEFAULT_CONFIG } from './protocol.js'
import type { BrowserConfig } from './protocol.js'

/**
 * Descriptive spec of every config key: type, default, and what it costs to
 * flip. Kept as a plain object because cordis 4 validates plugin config through
 * Standard Schema (see `Config` below), not through a declarative schema type —
 * but the descriptions are the documentation, so they stay machine-readable.
 */
export const CONFIG_SPEC = {
  engine: {
    provider: {
      type: 'string',
      default: DEFAULT_CONFIG.engine.provider,
      description:
        'Browser driver. `patchright` (default) is a source-patched Playwright that suppresses CDP/Runtime tells and falls back to unpatched playwright-core when absent. '
        + '`cloakbrowser` is a Chromium fork with fingerprint patches and engine-level humanization. `cdp` attaches to a browser you launched yourself. '
        + '`playwright-core` is the same adapter as patchright with the intent documented.',
    },
    channel: { type: 'string', default: DEFAULT_CONFIG.engine.channel, description: 'chrome | chromium | msedge. A real browser channel gives a real TLS fingerprint.' },
    headless: {
      type: 'boolean',
      default: DEFAULT_CONFIG.engine.headless,
      description:
        'Default false. Headless measurably scores worse than headed on most detector benches, and the whole point of this plugin is that a human can watch and take over — which needs a display anyway. '
        + 'Set true only for unattended runs on a host with no display.',
    },
    humanize: { type: 'boolean', default: DEFAULT_CONFIG.engine.humanize, description: 'Bezier mouse paths, per-key timing distribution, decelerating scroll. Off means raw driver input, which is trivially detectable.' },
    userDataDir: {
      type: 'string',
      default: null as unknown as string,
      nullable: true,
      description: 'ABSOLUTE path to a persistent profile. Config only — never a tool argument. Default: <DSH_HOME>/browser-profiles/default.',
    },
    proxy: { type: 'string', default: null as unknown as string, nullable: true, description: 'http://user:pass@host:port or socks5://… Redacted in status output.' },
    geoip: { type: 'boolean', default: DEFAULT_CONFIG.engine.geoip, description: 'Derive timezone/locale from the proxy exit IP. Mismatched geo is a common detection signal.' },
    viewport: {
      width: { type: 'number', default: DEFAULT_CONFIG.engine.viewport.width },
      height: { type: 'number', default: DEFAULT_CONFIG.engine.viewport.height },
      description: 'CSS pixels. Avoid exotic sizes: a 3840x2160 viewport on a laptop fingerprint is inconsistent.',
    },
    launchTimeoutMs: { type: 'number', default: DEFAULT_CONFIG.engine.launchTimeoutMs },
    idleTimeoutMs: { type: 'number', default: DEFAULT_CONFIG.engine.idleTimeoutMs, description: 'Reap a session after this much inactivity. 0 disables. Never reaps while a human is driving or watching.' },
    maxSessions: { type: 'number', default: DEFAULT_CONFIG.engine.maxSessions, description: 'LRU-evicts idle sessions beyond this.' },
    cdpEndpoint: { type: 'string', default: null as unknown as string, nullable: true, description: 'For engine.provider: cdp. ATTACHING HANDS THIS PLUGIN A BROWSER THAT MAY HOLD YOUR REAL COOKIES AND PASSWORDS.' },
    cloak: {
      licenseKey: { type: 'string', default: null as unknown as string, nullable: true, description: 'CloakBrowser Pro binary. Vendor numbers are gated to this tier.' },
      allowBinaryDownload: {
        type: 'boolean',
        default: false,
        description: 'CloakBrowser fetches a Chromium fork binary on first run. That is a network download of an executable, so it is an explicit opt-in.',
      },
      humanPreset: { type: 'string', default: 'default', description: 'default | careful.' },
      fingerprint: { type: 'string', default: null as unknown as string, nullable: true, description: 'Named fingerprint profile id, applied as a binary flag (not CDP emulation).' },
      hardened: { type: 'boolean', default: false, description: 'Adds HTTP/1.1 fallback and WebRTC IP policy. Costs throughput; needed by some sites that HTTP/2-fingerprint the client.' },
    },
  },
  frames: {
    source: {
      type: 'string',
      default: DEFAULT_CONFIG.frames.source,
      description:
        'screenshot (default, on-demand capture, lowest tell, 2–6 fps) | screencast (persistent CDP session, 10–25 fps, LOUD Layer-1 tell — auto-suppressed on challenge pages) | '
        + 'dom (no capture, synthetic a11y render, zero tell, works for text-only models) | mirror (reserved; needs a native helper, not bundled).',
    },
    maxFps: { type: 'number', default: DEFAULT_CONFIG.frames.maxFps, description: 'Higher fps means more CDP calls, which means more detection surface. 5 is the sweet spot.' },
    jpegQuality: { type: 'number', default: DEFAULT_CONFIG.frames.jpegQuality },
    suppressOnChallenge: {
      type: 'boolean',
      default: DEFAULT_CONFIG.frames.suppressOnChallenge,
      description: 'Drop the persistent transport whenever a challenge widget is present. That is exactly when the site is scoring us. Leave this on.',
    },
    captureTimeoutMs: { type: 'number', default: DEFAULT_CONFIG.frames.captureTimeoutMs },
  },
  challenge: {
    autoSolver: {
      type: 'string',
      default: DEFAULT_CONFIG.challenge.autoSolver,
      description:
        'off (default) or adapter. Tier 3 is opt-in because it is the only tier with real abuse potential, and because on session-bound vendors it usually fails anyway.',
    },
    adapter: {
      type: 'string',
      default: null as unknown as string,
      nullable: true,
      description:
        'capsolver-extension (IN-SESSION: the solver runs inside our browser, so the token is minted where it is consumed — the only defensible tier-3 mode) | '
        + 'token-api (REMOTE: a token minted on someone else\'s browser and IP, injected here. Frequently rejected on strict configurations.)',
    },
    adapterConfig: {
      extensionPath: { type: 'string', default: null as unknown as string, nullable: true, description: 'ABSOLUTE path to an unpacked solver extension you downloaded from your own provider account. This plugin never downloads it.' },
      apiKey: { type: 'string', default: null as unknown as string, nullable: true, description: 'Your own solver-service key. Config only; redacted everywhere; sent only to the configured endpoint.' },
      endpoint: { type: 'string', default: null as unknown as string, nullable: true, description: 'Override for a self-hosted or proxying solver endpoint.' },
      waitMs: { type: 'number', default: 60_000 },
      timeoutMs: { type: 'number', default: 180_000 },
    },
    allowedDomains: {
      type: 'array',
      default: DEFAULT_CONFIG.challenge.allowedDomains as unknown as string[],
      description: 'Tier 3 only ever runs for a domain on this list, AND only after a one-shot approval prompt. Empty means never.',
    },
    handoffByDefault: { type: 'boolean', default: DEFAULT_CONFIG.challenge.handoffByDefault, description: 'Pause and hand the challenge to the human in the panel. This is the recommended path and the one most likely to succeed.' },
    handoffTimeoutMs: { type: 'number', default: DEFAULT_CONFIG.challenge.handoffTimeoutMs },
  },
  policy: {
    approvalForSensitiveActions: {
      type: 'boolean',
      default: DEFAULT_CONFIG.policy.approvalForSensitiveActions,
      description: 'Mandatory one-shot DSH approval before payment, purchase, publish, delete, account-security, send, install or transfer actions.',
    },
    allowEvaluate: {
      type: 'boolean',
      default: DEFAULT_CONFIG.policy.allowEvaluate,
      description: 'browser_evaluate runs arbitrary page JavaScript. This is a CONFIG GATE, not an approval — enabling it trusts the model with the page context. Compose with the harness permission policy for stricter control.',
    },
    allowedDomains: { type: 'array', default: DEFAULT_CONFIG.policy.allowedDomains as unknown as string[], description: 'When non-empty, navigation is restricted to these hosts.' },
    deniedDomains: { type: 'array', default: DEFAULT_CONFIG.policy.deniedDomains as unknown as string[], description: 'Always refused. Checked before the allow list.' },
    maxTaskSteps: { type: 'number', default: DEFAULT_CONFIG.policy.maxTaskSteps },
    taskTimeoutMs: { type: 'number', default: DEFAULT_CONFIG.policy.taskTimeoutMs },
  },
}

/** Merge a partial user config over the defaults, deeply. */
export function resolveConfig(user: unknown): BrowserConfig {
  const base = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as BrowserConfig
  if (typeof user !== 'object' || user === null) return base
  const input = user as Record<string, unknown>
  for (const section of ['engine', 'frames', 'challenge', 'policy'] as const) {
    const value = input[section]
    if (typeof value === 'object' && value !== null) {
      Object.assign((base as Record<string, unknown>)[section] as Record<string, unknown>, value as Record<string, unknown>)
    }
  }
  return base
}

/**
 * Redact everything secret, for status output and logs.
 *
 * `browser_status` is a model-facing tool result. Anything in it can end up in
 * the prompt, in the session log, and in a screenshot the user shares. Credentials
 * must not be able to take that path.
 */
export function redactConfig(config: BrowserConfig): Record<string, unknown> {
  const engine = { ...config.engine } as Record<string, unknown>
  engine.proxy = typeof engine.proxy === 'string' ? redactUrl(engine.proxy) : engine.proxy
  const cloak = (engine.cloak ?? {}) as Record<string, unknown>
  engine.cloak = { ...cloak, licenseKey: cloak.licenseKey ? '<set>' : null }
  const cdp = (engine.cdpEndpoint ?? null) as string | null
  engine.cdpEndpoint = cdp ? redactUrl(cdp) : null
  const adapterConfig = ((config.challenge as Record<string, unknown>).adapterConfig ?? {}) as Record<string, unknown>
  return {
    engine,
    frames: config.frames,
    challenge: {
      ...config.challenge,
      adapterConfig: { ...adapterConfig, apiKey: adapterConfig.apiKey ? '<set>' : null },
    },
    policy: config.policy,
  }
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value)
    if (url.username || url.password) {
      url.username = url.username ? '<redacted>' : ''
      url.password = ''
    }
    return url.toString()
  } catch {
    return '<redacted>'
  }
}

/**
 * The cordis 4 config contract: a Standard Schema v1 wrapper around
 * `resolveConfig`.
 *
 * Validation never REJECTS: an unknown key or a wrong type falls back to the
 * documented default rather than failing plugin load. A browser plugin that
 * refuses to mount because someone typo'd `maxFps` is worse than one that runs
 * at 5 fps and says so in the log — and `resolveConfig` is already the single
 * coercion point the host, the tools and the redactor all trust.
 */
export const Config = {
  '~standard': {
    version: 1 as const,
    vendor: 'dsh-browser',
    validate: (value: unknown): { value: BrowserConfig } => ({ value: resolveConfig(value) }),
  },
}

export { DEFAULT_CONFIG }
export type { BrowserConfig }
