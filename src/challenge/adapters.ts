/**
 * Tier-3 solver adapters.
 *
 * Three ship in the box, and the point of shipping all three is that they
 * demonstrate the whole honest range:
 *
 *   `none`                 — always registered. Makes "tier 3 is off" a real
 *                            adapter rather than a null check, so the pipeline
 *                            has one code path.
 *   `capsolver-extension`  — IN-SESSION. Loads a solver's Chrome extension into
 *                            our own browser at launch. The extension's content
 *                            script detects the widget, its service worker calls
 *                            the vendor API, and the token is injected into the
 *                            page that requested it. Same fingerprint, same TLS,
 *                            same IP, same behavioral history. This is the only
 *                            tier-3 mode that is defensible on a scored challenge.
 *   `token-api`            — REMOTE. Posts sitekey+url to a solving service and
 *                            injects the returned token. Works on lenient
 *                            configurations; on strict ones the token is rejected
 *                            because it encodes a different browser's
 *                            fingerprint. `inSession: false`, always.
 *
 * None of them is enabled by default. All of them require the user's own
 * credentials, an explicit per-domain allowlist, and a one-shot DSH approval.
 *
 * @module @dsh-community/dsh-browser/challenge/adapters
 */

import type { ChallengeVendor } from '../protocol.js'
import type { SolverAdapter, SolveRequest, SolveResult } from './pipeline.js'

// ── none ────────────────────────────────────────────────────────────────────

export const noneAdapter: SolverAdapter = {
  name: 'none',
  inSession: false,
  supports: () => false,
  async ready() {
    return { ready: false, reason: 'tier 3 is disabled (challenge.autoSolver: off)' }
  },
  async solve() {
    return { ok: false, latencyMs: 0, reason: 'no solver adapter configured' }
  },
}

// ── in-session extension ────────────────────────────────────────────────────

export interface ExtensionAdapterConfig {
  /**
   * Absolute path to the unpacked extension directory, or the downloaded
   * extension zip's extracted folder. Validated at config time; never accepted
   * from the model.
   */
  extensionPath: string | null
  /** Vendors the user has confirmed the extension handles. */
  handles: ChallengeVendor[]
  /** How long to wait for the extension to inject a token. */
  waitMs: number
}

const DEFAULT_EXTENSION_CONFIG: ExtensionAdapterConfig = {
  extensionPath: null,
  handles: ['recaptcha-v2', 'recaptcha-v3', 'hcaptcha', 'cloudflare-turnstile', 'funcaptcha', 'geetest', 'amazon-waf'],
  waitMs: 60_000,
}

/**
 * The extension adapter does not itself call any vendor API.
 *
 * It configures the LAUNCH (see `launchArgsForExtension` in engine config) and
 * then waits for the page's own response field to be populated by the
 * extension's content script. That is the whole implementation, and it is why
 * `inSession` is true: nothing leaves the browser context except what the
 * extension itself sends.
 */
export class ExtensionSolverAdapter implements SolverAdapter {
  readonly name = 'capsolver-extension'
  readonly inSession = true
  #config: ExtensionAdapterConfig

  constructor(config: Partial<ExtensionAdapterConfig> = {}) {
    this.#config = { ...DEFAULT_EXTENSION_CONFIG, ...config }
  }

  get config(): Readonly<ExtensionAdapterConfig> {
    return this.#config
  }

  supports(vendor: ChallengeVendor): boolean {
    return this.#config.handles.includes(vendor)
  }

  async ready(): Promise<{ ready: boolean; reason?: string }> {
    if (!this.#config.extensionPath) {
      return {
        ready: false,
        reason:
          'challenge.adapterConfig.extensionPath is not set. Download the solver extension from your own provider account, '
          + 'unzip it, and point this at the extracted directory. This plugin does not download it for you.',
      }
    }
    const { stat } = await import('node:fs/promises')
    const info = await stat(this.#config.extensionPath).catch(() => undefined)
    if (!info?.isDirectory()) return { ready: false, reason: `extensionPath is not a directory: ${this.#config.extensionPath}` }
    const { access } = await import('node:fs/promises')
    const manifest = `${this.#config.extensionPath}/manifest.json`
    const ok = await access(manifest).then(() => true).catch(() => false)
    if (!ok) return { ready: false, reason: `no manifest.json at ${manifest}` }
    return { ready: true }
  }

  async solve(request: SolveRequest): Promise<SolveResult> {
    const started = Date.now()
    if (!request.approvedDomain) {
      return { ok: false, latencyMs: 0, reason: 'domain not approved for automated solving' }
    }
    const field = request.detection.responseField
    if (!field) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        reason: `${request.detection.vendor} exposes no response field to wait on; the extension may still be working, but we cannot confirm a solve`,
      }
    }

    const deadline = Date.now() + this.#config.waitMs
    const safeField = field.replace(/[^a-zA-Z0-9_-]/g, '')
    while (Date.now() < deadline) {
      if (request.signal?.aborted) return { ok: false, latencyMs: Date.now() - started, reason: 'aborted' }
      const filled = await request.page
        .evaluateIsolated<boolean>(
          `(() => { const el = document.querySelector('[name="${safeField}"], #${safeField}'); return !!(el && typeof el.value === 'string' && el.value.length > 8); })()`,
        )
        .catch(() => false)
      if (filled) {
        return {
          ok: true,
          latencyMs: Date.now() - started,
          inSession: true,
          detail: 'extension injected a token into the requesting page',
        }
      }
      await new Promise(resolve => setTimeout(resolve, 800))
    }
    return {
      ok: false,
      latencyMs: Date.now() - started,
      reason: `extension did not populate ${field} within ${this.#config.waitMs} ms`,
    }
  }
}

/** Chrome args to load an unpacked extension at launch. */
export function launchArgsForExtension(extensionPath: string | null, headless: boolean): string[] {
  if (!extensionPath) return []
  const args = [`--load-extension=${extensionPath}`, `--disable-extensions-except=${extensionPath}`]
  // MV3 service workers run under the new headless mode. Old headless cannot
  // load extensions at all, which is why the engine pins --headless=new.
  if (headless) args.push('--headless=new')
  return args
}

// ── remote token API ────────────────────────────────────────────────────────

export interface TokenApiConfig {
  /** `2captcha`-compatible or `capsolver`-compatible. */
  flavor: 'twocaptcha' | 'capsolver'
  /**
   * The user's own key. Read from config only; never logged, never returned in
   * a tool result, never sent anywhere except the configured endpoint.
   */
  apiKey: string | null
  /** Override for a self-hosted or proxying endpoint. */
  endpoint: string | null
  handles: ChallengeVendor[]
  timeoutMs: number
}

const DEFAULT_TOKEN_CONFIG: TokenApiConfig = {
  flavor: 'twocaptcha',
  apiKey: null,
  endpoint: null,
  handles: ['recaptcha-v2', 'hcaptcha', 'funcaptcha', 'geetest'],
  timeoutMs: 180_000,
}

/**
 * Remote token solving.
 *
 * Ships DISABLED and with `inSession: false` hard-coded, because that is the
 * truth about it and the audit record has to say so.
 *
 * Note what is deliberately NOT in `handles` by default: `cloudflare-turnstile`,
 * `recaptcha-v3`, `datadome`, `perimeterx`, `kasada`. Those are the
 * session-bound vendors where a remote token is most likely to be rejected, so
 * the default configuration will not even attempt them — it falls through to
 * handoff. A user who wants to try anyway has to add the vendor explicitly,
 * which means they had to read this file to do it.
 */
export class TokenApiSolverAdapter implements SolverAdapter {
  readonly name = 'token-api'
  readonly inSession = false
  #config: TokenApiConfig

  constructor(config: Partial<TokenApiConfig> = {}) {
    this.#config = { ...DEFAULT_TOKEN_CONFIG, ...config }
  }

  get config(): Readonly<TokenApiConfig> {
    return { ...this.#config, apiKey: this.#config.apiKey ? '<redacted>' : null }
  }

  supports(vendor: ChallengeVendor): boolean {
    return this.#config.handles.includes(vendor)
  }

  async ready(): Promise<{ ready: boolean; reason?: string }> {
    if (!this.#config.apiKey) {
      return {
        ready: false,
        reason: `challenge.adapterConfig.apiKey is not set. Use your OWN account key with the ${this.#config.flavor} service you already pay for.`,
      }
    }
    return { ready: true }
  }

  async solve(request: SolveRequest): Promise<SolveResult> {
    const started = Date.now()
    if (!request.approvedDomain) return { ok: false, latencyMs: 0, reason: 'domain not approved for automated solving' }
    if (!this.#config.apiKey) return { ok: false, latencyMs: 0, reason: 'no API key configured' }
    if (!request.detection.sitekey) {
      return { ok: false, latencyMs: Date.now() - started, reason: `${request.detection.vendor} exposes no sitekey; a remote solve cannot be requested` }
    }

    const endpoint = this.#config.endpoint ?? (this.#config.flavor === 'capsolver' ? 'https://api.capsolver.com/createTask' : 'https://2captcha.com/in.php')
    const taskType = mapTaskType(this.#config.flavor, request.detection.vendor)
    if (!taskType) {
      return { ok: false, latencyMs: Date.now() - started, reason: `no task type mapping for ${request.detection.vendor} on ${this.#config.flavor}` }
    }

    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.#config.timeoutMs)
      request.signal?.addEventListener('abort', () => controller.abort(), { once: true })

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildTaskBody(this.#config, taskType, request)),
        signal: controller.signal,
      }).finally(() => clearTimeout(timer))

      if (!response.ok) {
        return { ok: false, latencyMs: Date.now() - started, reason: `solver endpoint returned ${response.status}` }
      }
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
      const token = extractToken(this.#config.flavor, body)
      if (!token) {
        return {
          ok: false,
          latencyMs: Date.now() - started,
          reason: `solver responded without a usable token (async task, or an error we did not parse): ${JSON.stringify(body).slice(0, 200)}`,
        }
      }
      await injectToken(request, token)
      return {
        ok: true,
        latencyMs: Date.now() - started,
        inSession: false,
        detail: 'token minted remotely and injected — rejection is likely on session-bound vendors',
      }
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - started, reason: error instanceof Error ? error.message : String(error) }
    }
  }
}

function mapTaskType(flavor: TokenApiConfig['flavor'], vendor: ChallengeVendor): string | null {
  if (flavor === 'capsolver') {
    switch (vendor) {
      case 'recaptcha-v2': return 'ReCaptchaV2TaskProxyLess'
      case 'recaptcha-v3': return 'ReCaptchaV3TaskProxyLess'
      case 'hcaptcha': return 'AntiHCaptchaTaskProxyLess'
      case 'cloudflare-turnstile': return 'AntiTurnstileTaskProxyLess'
      case 'funcaptcha': return 'AntiCloudflareTask'
      default: return null
    }
  }
  switch (vendor) {
    case 'recaptcha-v2': return 'recaptcha'
    case 'recaptcha-v3': return 'recaptcha-v3'
    case 'hcaptcha': return 'hcaptcha'
    case 'cloudflare-turnstile': return 'turnstile'
    case 'funcaptcha': return 'funcaptcha'
    case 'geetest': return 'geetest'
    default: return null
  }
}

function buildTaskBody(config: TokenApiConfig, taskType: string, request: SolveRequest): Record<string, unknown> {
  const common = { sitekey: request.detection.sitekey, pageurl: request.url, type: taskType }
  if (config.flavor === 'capsolver') {
    return { clientKey: config.apiKey, task: { type: taskType, websiteURL: request.url, websiteKey: request.detection.sitekey } }
  }
  return { key: config.apiKey, json: 1, method: taskType, ...common }
}

function extractToken(flavor: TokenApiConfig['flavor'], body: Record<string, unknown>): string | null {
  if (flavor === 'capsolver') {
    const solution = body.solution as Record<string, unknown> | undefined
    const token = solution?.gRecaptchaResponse ?? solution?.token ?? solution?.captchaId
    return typeof token === 'string' && token.length > 8 ? token : null
  }
  // 2captcha's synchronous shape; the async `request_id` path is deliberately
  // NOT followed here — polling a task id would need a job, and a tier-3 solve
  // should not outlive the tool call that asked for it.
  const status = body.status
  const request = body.request ?? body.token
  if (status === 1 && typeof request === 'string' && request.length > 8) return request
  return null
}

/**
 * Inject a token into the field the widget reads.
 *
 * Uses the native value setter and dispatches an `input` + `change` event,
 * because React/Vue controlled inputs ignore a bare `.value =` assignment. This
 * is a well-known integration detail, not a trick: the vendor's own docs
 * describe populating the same field.
 */
async function injectToken(request: SolveRequest, token: string): Promise<void> {
  const field = (request.detection.responseField ?? 'g-recaptcha-response').replace(/[^a-zA-Z0-9_-]/g, '')
  const script = `(() => {
    const el = document.querySelector('[name="${field}"], #${field}');
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(el, ${JSON.stringify(token)}); else el.value = ${JSON.stringify(token)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`
  const ok = await request.page.evaluateIsolated<boolean>(script).catch(() => false)
  if (!ok) throw new Error(`could not locate the ${field} field to inject into`)
}

// ── registry ────────────────────────────────────────────────────────────────

export function buildAdapters(config: {
  adapter: string | null
  extension?: Partial<ExtensionAdapterConfig>
  tokenApi?: Partial<TokenApiConfig>
}): Map<string, SolverAdapter> {
  const adapters = new Map<string, SolverAdapter>()
  adapters.set('none', noneAdapter)
  adapters.set('capsolver-extension', new ExtensionSolverAdapter(config.extension))
  adapters.set('token-api', new TokenApiSolverAdapter(config.tokenApi))
  // Alias the legacy name so `challenge.adapter: twocaptcha` resolves to the
  // same remote adapter with the right flavor default.
  if (config.adapter === 'twocaptcha' || config.tokenApi?.flavor === 'twocaptcha') {
    adapters.set('twocaptcha', new TokenApiSolverAdapter({ ...config.tokenApi, flavor: 'twocaptcha' }))
  }
  if (config.adapter === 'capsolver-api') {
    adapters.set('capsolver-api', new TokenApiSolverAdapter({ ...config.tokenApi, flavor: 'capsolver' }))
  }
  return adapters
}

export type { SolverAdapter, SolveRequest, SolveResult }
