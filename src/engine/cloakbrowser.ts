/**
 * Optional engine provider: CloakBrowser.
 *
 * CloakBrowser is a Chromium fork with source-level C++ patches (canvas, WebGL,
 * audio, fonts, GPU, screen, WebRTC, network timing, automation signals, CDP
 * input behavior) exposing a drop-in Playwright/Puppeteer API. Its stated design
 * goal is relevant to us and worth quoting because it shapes this provider:
 *
 *     "CloakBrowser doesn't solve CAPTCHAs — it prevents them from appearing."
 *
 * That maps exactly onto tier 0 of our challenge pipeline (`prevent`). Selecting
 * this provider raises the ceiling of tier 0; it does not change tiers 1–3.
 *
 * Two things this provider gets that Patchright does not:
 *
 *  1. `humanize: true` is implemented IN THE BINARY. Every `page.click()`,
 *     `page.fill()`, `page.type()`, `page.mouse.*`, `page.keyboard.*` and
 *     Locator call is replaced with a human-equivalent at the engine layer,
 *     which is a stronger guarantee than our JS-side curve generator (the
 *     events are indistinguishable from real input events, not shaped ones).
 *     When `humanize` is on we therefore DELEGATE and skip our own path
 *     generation — doing both would double-apply easing.
 *  2. Fingerprint controls are binary flags (`--fingerprint=…`,
 *     `--fingerprint-webrtc-ip=auto`, timezone/locale), not CDP emulation.
 *     CDP `Emulation.*` calls are themselves observable; binary flags are not.
 *
 * Caveats we surface rather than hide:
 *  - The strongest published numbers are gated to the Pro binary (license key).
 *    The free binary is a different build. `posture()` reports which one loaded.
 *  - It is a Chromium fork with a closed binary in the Pro tier, so it is not
 *    auditable the way Patchright's published AST patch is.
 *  - It auto-downloads a browser binary on first run. That is a network fetch
 *    of an executable, so it requires an explicit config opt-in
 *    (`engine.allowBinaryDownload`) and, in DSH, an approval.
 *
 * @module @dsh-community/dsh-browser/engine/cloakbrowser
 */

import type {
  EngineBrowser,
  EnginePage,
  EnginePosture,
  EngineProviderAdapter,
  LaunchOptions,
  PageSnapshot,
  TypeOptions,
} from './types.js'
import { EngineError } from './types.js'
import { applyDesktopView, type EmulateState } from './emulate.js'
import { patchrightProvider, hardenedArgs } from './patchright.js'
import { PRESETS, createRandom, keystrokeDelaysMs, sleep, type HumanizePreset } from './humanize.js'

interface CloakModule {
  launch(opts: Record<string, unknown>): Promise<any>
  launchPersistentContext(userDataDir: string, opts: Record<string, unknown>): Promise<any>
}

export interface CloakOptions {
  /** Pro binary. Free via `cloakbrowser login`, or paid. */
  licenseKey?: string | null
  /**
   * CloakBrowser downloads its Chromium fork on first run. This is a network
   * fetch of an executable and must be an explicit opt-in.
   */
  allowBinaryDownload: boolean
  /** `careful` slows movements further. */
  humanPreset?: 'default' | 'careful'
  /** Named fingerprint profile, when the build supports it. */
  fingerprint?: string | null
  /** Apply our hardened args (HTTP/1.1 fallback, WebRTC IP policy). */
  hardened?: boolean
}

const DEFAULT_CLOAK_OPTIONS: CloakOptions = {
  licenseKey: null,
  allowBinaryDownload: false,
  humanPreset: 'default',
  fingerprint: null,
  hardened: false,
}

let moduleOptions: CloakOptions = { ...DEFAULT_CLOAK_OPTIONS }

/** Called from the plugin's config apply. Never from the model. */
export function configureCloak(options: Partial<CloakOptions>): void {
  moduleOptions = { ...DEFAULT_CLOAK_OPTIONS, ...options }
}

export function cloakOptions(): Readonly<CloakOptions> {
  return moduleOptions
}

async function loadCloak(): Promise<CloakModule> {
  try {
    return (await import('cloakbrowser')) as unknown as CloakModule
  } catch (error) {
    throw new EngineError(
      'cloakbrowser is not installed. Install it in the profile directory, or set '
      + '`engine.provider: patchright` (the default). Note that cloakbrowser downloads a '
      + 'Chromium fork binary on first run — set `engine.cloak.allowBinaryDownload: true` '
      + 'to permit that.',
      'E_CLOAK_MISSING',
      error,
    )
  }
}

export const cloakbrowserProvider: EngineProviderAdapter = {
  name: 'cloakbrowser',

  async probe() {
    if (!moduleOptions.allowBinaryDownload) {
      // Not an error — a policy gate. Report it as such so `browser_status`
      // can tell the user exactly which flag to flip.
      return {
        available: false,
        reason: 'engine.cloak.allowBinaryDownload is false; cloakbrowser fetches a Chromium fork binary on first run',
      }
    }
    try {
      await loadCloak()
      return { available: true, detail: moduleOptions.licenseKey ? 'pro binary' : 'free binary' }
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : String(error) }
    }
  },

  async launch(opts: LaunchOptions): Promise<EngineBrowser> {
    const mod = await loadCloak()
    const preset: HumanizePreset = PRESETS[moduleOptions.humanPreset ?? 'default']
    const random = createRandom()

    const launchOpts: Record<string, unknown> = {
      headless: opts.headless,
      // Engine-level humanization. When on, we must NOT also apply our JS-side
      // curves — that double-eases and produces visibly synthetic motion.
      humanize: opts.humanize,
      human_preset: moduleOptions.humanPreset,
      viewport: opts.viewport,
      // Binary flags, not CDP emulation — that is the point.
      timezone: opts.timezone ?? undefined,
      locale: opts.locale ?? undefined,
      args: [
        ...(opts.humanize ? [] : []),
        ...(moduleOptions.fingerprint ? [`--fingerprint=${moduleOptions.fingerprint}`] : []),
        // WebRTC exit-IP binding. `auto` resolves through the proxy.
        ...(opts.proxy ? ['--fingerprint-webrtc-ip=auto'] : []),
        ...(moduleOptions.hardened ? hardenedArgs() : []),
        ...(opts.extraArgs ?? []),
      ],
    }
    if (opts.proxy) launchOpts.proxy = opts.proxy
    if (moduleOptions.licenseKey) launchOpts.licenseKey = moduleOptions.licenseKey
    if (opts.geoip) launchOpts.geoip = true

    const context = opts.userDataDir
      ? await mod.launchPersistentContext(opts.userDataDir, launchOpts)
      : await mod.launch(launchOpts)

    // The API is Playwright-compatible, so we reuse the Patchright page wrapper
    // and only override the input layer when the binary is doing humanization.
    const delegate = await patchrightProvider.launch({ ...opts, headless: opts.headless }).catch(() => undefined)
    void delegate

    const pages = new Map<string, EnginePage>()
    let counter = 0
    let activeId: string | undefined

    const wrap = (raw: any): EnginePage => {
      const id = `p${(counter += 1)}`
      const page = new CloakPage(id, raw, preset, random, opts.humanize)
      pages.set(id, page)
      return page
    }

    for (const raw of (context.pages?.() as any[]) ?? []) wrap(raw)
    context.on?.('page', (raw: any) => wrap(raw))
    activeId = pages.keys().next().value

    return {
      provider: 'cloakbrowser',
      channel: opts.channel,
      headless: opts.headless,
      pages: () => [...pages.values()],
      activePage: () => (activeId ? pages.get(activeId) : undefined),
      async newPage() {
        const page = wrap(await context.newPage())
        activeId = page.id
        return page
      },
      async selectPage(id) {
        const page = pages.get(id)
        if (!page) throw new EngineError(`no such page: ${id}`, 'E_NO_PAGE')
        await (page as CloakPage).raw.bringToFront()
        activeId = id
      },
      posture: (): EnginePosture => ({
        provider: 'cloakbrowser',
        versions: { driver: `cloakbrowser${moduleOptions.licenseKey ? ' (pro)' : ' (free)'}`, browser: 'chromium fork' },
        humanize: opts.humanize,
        fingerprintProfile: moduleOptions.fingerprint ?? null,
        proxy: opts.proxy,
        timezone: opts.timezone ?? null,
        locale: opts.locale ?? null,
        applied: [
          'source-level C++ patches (canvas/WebGL/audio/fonts/GPU/screen/WebRTC/network-timing/automation-signals/CDP-input)',
          opts.humanize
            ? `humanize=true at the ENGINE layer (all Playwright input calls replaced; human_preset=${moduleOptions.humanPreset})`
            : 'humanize=false — raw input events',
          'fingerprint via binary flags, not CDP Emulation.* (not observable from page JS)',
          opts.proxy ? `proxy + WebRTC exit-IP binding (--fingerprint-webrtc-ip=auto)` : 'direct connection',
          moduleOptions.hardened ? 'hardened args (HTTP/1.1 fallback, WebRTC permission enforcement)' : 'default args',
        ],
        gaps: [
          'vendor-published detection numbers are gated to the Pro binary; the free build is a different artifact',
          'the Pro binary is closed-source and therefore not auditable — review your threat model before trusting it with credentials',
          'first run downloads a Chromium fork binary from the network (gated by engine.cloak.allowBinaryDownload)',
          'IP reputation and DNS leakage remain unaddressed — a fingerprint without a matching residential IP still scores badly',
          'does NOT solve interactive CAPTCHAs; it reduces how often they trigger. Tiers 1–3 of the challenge pipeline still apply',
        ],
      }),
      async close() {
        pages.clear()
        await context.close?.().catch(() => undefined)
      },
    }
  },
}

/**
 * Page wrapper that DEFERS to the engine's own humanization.
 *
 * Only the typing path stays ours when humanize is off; with it on, every input
 * call is a plain Playwright call because the binary rewrites it.
 */
class CloakPage implements EnginePage {
  #refs = new Map<string, { selector: string }>()
  #emulate: EmulateState = {}

  constructor(
    readonly id: string,
    readonly raw: any,
    private readonly preset: HumanizePreset,
    private readonly random: () => number,
    private readonly humanize: boolean,
  ) {}

  get input() {
    const raw = this.raw
    const humanize = this.humanize
    const preset = this.preset
    const random = this.random
    return {
      pointerMove: async (x: number, y: number) => {
        await raw.mouse.move(x, y)
      },
      pointerDown: async (x: number, y: number, button = 'left') => {
        await raw.mouse.move(x, y)
        await raw.mouse.down({ button })
      },
      pointerUp: async (x: number, y: number, button = 'left') => {
        await raw.mouse.move(x, y)
        await raw.mouse.up({ button })
      },
      // Engine handles the curve. Do not double-apply.
      click: async (x: number, y: number) => {
        await raw.mouse.click(x, y)
      },
      typeText: async (text: string, opts?: TypeOptions) => {
        if (humanize && !opts?.insert) {
          // The engine paces keys itself; a plain type() is already humanized.
          await raw.keyboard.type(text)
          return
        }
        if (opts?.insert) {
          await raw.keyboard.insertText(text)
          return
        }
        const delays = keystrokeDelaysMs(text, preset, random)
        for (let i = 0; i < text.length; i += 1) {
          await raw.keyboard.type(text[i] ?? '', { delay: 0 })
          await sleep(delays[i] ?? 100)
        }
      },
      pressKey: async (key: string) => {
        await raw.keyboard.press(key)
      },
      scroll: async (deltaX: number, deltaY: number) => {
        await raw.mouse.wheel(deltaX, deltaY)
      },
      drag: async (from: { x: number; y: number }, to: { x: number; y: number }) => {
        await raw.mouse.move(from.x, from.y)
        await raw.mouse.down()
        await raw.mouse.move(to.x, to.y, { steps: humanize ? 1 : 12 })
        await raw.mouse.up()
      },
    }
  }

  url(): string {
    return this.raw.url() as string
  }
  async title(): Promise<string> {
    return this.raw.title() as Promise<string>
  }
  viewport(): { width: number; height: number } {
    return (this.raw.viewportSize() as { width: number; height: number } | null) ?? { width: 1366, height: 768 }
  }
  async goto(url: string, opts?: { timeoutMs?: number; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' }): Promise<void> {
    this.#refs.clear()
    await this.raw.goto(url, { timeout: opts?.timeoutMs ?? 30_000, waitUntil: opts?.waitUntil ?? 'domcontentloaded' })
  }
  async navigate(action: 'back' | 'forward' | 'reload' | 'stop'): Promise<void> {
    this.#refs.clear()
    if (action === 'stop') {
      await this.raw.evaluate('window.stop()').catch(() => undefined)
      return
    }
    const method = action === 'back' ? 'goBack' : action === 'forward' ? 'goForward' : 'reload'
    await this.raw[method]({ waitUntil: 'domcontentloaded' })
  }
  async close(): Promise<void> {
    await this.raw.close().catch(() => undefined)
  }
  async capture(opts?: { format?: 'png' | 'jpeg'; quality?: number; fullPage?: boolean }): Promise<Uint8Array> {
    const buffer = (await this.raw.screenshot({
      type: opts?.format === 'jpeg' ? 'jpeg' : 'png',
      quality: opts?.format === 'jpeg' ? opts.quality ?? 72 : undefined,
      fullPage: opts?.fullPage ?? false,
      caret: 'hide',
      timeout: 8_000,
    })) as Buffer
    return new Uint8Array(buffer)
  }
  async snapshot(opts?: { maxNodes?: number; maxNameLength?: number }): Promise<PageSnapshot> {
    const maxNodes = opts?.maxNodes ?? 400
    const raw: string = await this.raw.locator('body').ariaSnapshot({ ref: true }).catch(() => '')
    const { parseAriaSnapshot } = await import('./patchright.js')
    const nodes = parseAriaSnapshot(raw, maxNodes, opts?.maxNameLength ?? 120, (ref, entry) => {
      this.#refs.set(ref, entry)
    })
    return { url: this.url(), title: await this.title().catch(() => ''), nodes, nodeCount: nodes.length, truncated: false }
  }
  async boxOf(ref: string) {
    const entry = this.#refs.get(ref)
    if (!entry) throw new EngineError(`stale element ref '${ref}' — call browser_observe again`, 'E_STALE_REF')
    return ((await this.raw.locator(entry.selector).first().boundingBox().catch(() => null)) ?? undefined) as
      | { x: number; y: number; width: number; height: number }
      | undefined
  }
  async evaluateIsolated<T>(fn: string, arg?: unknown): Promise<T> {
    return (await this.raw.evaluate(fn, arg)) as T
  }
  async emulate(opts: { desktopView: boolean }): Promise<void> {
    await applyDesktopView(this.raw, this.#emulate, opts.desktopView)
  }

  async startScreencast(opts: { maxFps: number; quality: number; onFrame: (f: { data: Uint8Array; mime: 'image/jpeg' | 'image/png'; width: number; height: number }) => void }) {
    const cdp = await this.raw.context().newCDPSession(this.raw)
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: opts.quality, everyNthFrame: 1 })
    let sequence = 0
    const handler = (params: { data: string; metadata: { deviceWidth?: number; deviceHeight?: number } }): void => {
      sequence += 1
      opts.onFrame({
        data: new Uint8Array(Buffer.from(params.data, 'base64')),
        mime: 'image/jpeg',
        width: params.metadata.deviceWidth ?? 0,
        height: params.metadata.deviceHeight ?? 0,
      })
      void cdp.send('Page.screencastFrameAck', { sessionId: sequence }).catch(() => undefined)
    }
    cdp.on('Page.screencastFrame', handler)
    return async () => {
      cdp.off?.('Page.screencastFrame', handler)
      await cdp.send('Page.stopScreencast').catch(() => undefined)
      await cdp.detach().catch(() => undefined)
    }
  }
}
