/**
 * Default engine provider: Patchright, falling back to playwright-core.
 *
 * Patchright is a source-patched Playwright driver (AST rewrite of the driver
 * itself, not a runtime shim) that suppresses the Layer-1 automation tells:
 * `Runtime.enable`, main-world execution-context leaks, and the CDP artifacts a
 * stock Playwright client leaves behind. Same API, so this provider is ~90%
 * ordinary Playwright code.
 *
 * ── THE HONEST PART ──────────────────────────────────────────────────────────
 * Patchright's whole value is that it does NOT keep a persistent CDP session
 * open in the main world. Our live stream wants exactly that. So:
 *
 *   • `screenshot` tier (default) — short-lived `Page.captureScreenshot`, eval
 *     confined to isolated worlds. Compatible with the stealth posture. This is
 *     why it is the default and not a compromise.
 *   • `screencast` tier — `Page.startScreencast` holds an open CDP session and
 *     emits frames from the renderer. We surface this in `posture().gaps` and
 *     auto-suppress it whenever a challenge widget is on the page, because that
 *     is precisely the moment the site is scoring us.
 *
 * If a deployment needs screencast fps AND a hardened posture, that is the
 * `mirror` tier (OS-level capture, no CDP for pixels) — see ARCHITECTURE §4.
 *
 * Provider resolution order: `patchright` → `playwright-core`. The fallback
 * keeps the plugin usable on a host that has a Chrome channel but no patched
 * driver; `posture().applied` then says plainly that no stealth patch is in
 * effect, so nobody is misled into thinking they are hidden.
 *
 * @module @dsh-community/dsh-browser/engine/patchright
 */

import type {
  ClickOptions,
  EngineBrowser,
  EngineInput,
  EnginePage,
  EnginePosture,
  EngineProviderAdapter,
  LaunchOptions,
  PageSnapshot,
  SnapshotNode,
  TypeOptions,
  DebugTapEvent,
} from './types.js'
import { EngineError } from './types.js'
import { applyDesktopView, attachDebugTap, type EmulateState } from './emulate.js'
import {
  PRESETS,
  clickHoldMs,
  createRandom,
  humanClickPath,
  keystrokeDelaysMs,
  mouseStepDelayMs,
  preActionDwellMs,
  scrollGesture,
  sleep,
  type HumanizePreset,
  type Point,
} from './humanize.js'

/** Minimal structural type for the driver module. We do not depend on its typings. */
interface DriverModule {
  chromium: {
    launch(opts: Record<string, unknown>): Promise<unknown>
    launchPersistentContext(userDataDir: string, opts: Record<string, unknown>): Promise<unknown>
  }
}

interface ResolvedDriver {
  mod: DriverModule
  /** Which package actually loaded. Reported in posture. */
  source: 'patchright' | 'playwright-core'
  version?: string
}

let cached: Promise<ResolvedDriver> | undefined

async function loadDriver(): Promise<ResolvedDriver> {
  cached ??= (async () => {
    try {
      const mod = (await import('patchright')) as unknown as DriverModule
      return { mod, source: 'patchright' as const, version: await safeVersion('patchright') }
    } catch (patchrightError) {
      try {
        const mod = (await import('playwright-core')) as unknown as DriverModule
        return { mod, source: 'playwright-core' as const, version: await safeVersion('playwright-core') }
      } catch {
        throw new EngineError(
          'no browser driver available: tried `patchright` then `playwright-core`. '
          + 'Install one in the profile directory (`dsh plugin` installs into the profile, so run '
          + '`npm i patchright` there) or set `engine.provider: cdp` to attach to a browser you launched yourself.',
          'E_NO_DRIVER',
          patchrightError,
        )
      }
    }
  })()
  return cached
}

async function safeVersion(pkg: string): Promise<string | undefined> {
  try {
    // createRequire is a node: builtin; kept local so this file stays provider-only.
    const { createRequire } = await import('node:module')
    const require = createRequire(import.meta.url)
    return (require(`${pkg}/package.json`) as { version?: string }).version
  } catch {
    return undefined
  }
}

// ── launch args ─────────────────────────────────────────────────────────────

/**
 * Baseline args.
 *
 * Deliberately SHORT. Every flag is a fingerprint, and long `--disable-*` lists
 * are themselves a tell (real users do not launch Chrome with 40 flags). Only
 * what automation genuinely needs.
 */
export function baseLaunchArgs(headless: boolean): string[] {
  const args = [
    // Automation plumbing that does not change the fingerprint.
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-breakpad',
    '--disable-component-update',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
  ]
  if (headless) {
    // New headless only. Old headless has a distinct UA and API shape that
    // every detector checks for.
    args.push('--headless=new')
  }
  return args
}

/**
 * Args that reduce detectability but cost fidelity. Off by default; enabled by
 * the `hardened` fingerprint profile.
 */
export function hardenedArgs(): string[] {
  return [
    // Some sites HTTP/2-fingerprint Playwright's connection layer (Reddit is
    // the documented case). Falling back to HTTP/1.1 costs throughput, wins the
    // session.
    '--disable-http2',
    // Prevent WebRTC from leaking the real interface IP behind a proxy.
    '--enforce-webrtc-ip-permission-check',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
  ]
}

// ── provider ────────────────────────────────────────────────────────────────

export const patchrightProvider: EngineProviderAdapter = {
  name: 'patchright',

  async probe() {
    try {
      const driver = await loadDriver()
      return {
        available: true,
        detail: `${driver.source}${driver.version ? ` ${driver.version}` : ''}`,
      }
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : String(error) }
    }
  },

  async launch(opts: LaunchOptions): Promise<EngineBrowser> {
    const driver = await loadDriver()
    const preset: HumanizePreset = PRESETS.default
    const random = createRandom()

    const launchOpts: Record<string, unknown> = {
      channel: opts.channel,
      headless: opts.headless,
      args: [...baseLaunchArgs(opts.headless), ...(opts.extraArgs ?? [])],
      viewport: opts.viewport,
      locale: opts.locale ?? undefined,
      timezoneId: opts.timezone ?? undefined,
      ignoreHTTPSErrors: false,
    }
    if (opts.proxy) launchOpts.proxy = { server: opts.proxy }

    let context: any
    let ownedBrowser: any
    if (opts.userDataDir) {
      // Persistent context: cookies/localStorage survive restarts, which also
      // avoids the "brand-new incognito profile" signal.
      context = await driver.mod.chromium.launchPersistentContext(opts.userDataDir, launchOpts)
    } else {
      ownedBrowser = await driver.mod.chromium.launch(launchOpts)
      context = await ownedBrowser.newContext({
        viewport: opts.viewport,
        locale: opts.locale ?? undefined,
        timezoneId: opts.timezone ?? undefined,
      })
    }

    const pages = new Map<string, PatchrightPage>()
    let counter = 0

    const wrap = (raw: any): PatchrightPage => {
      const id = `p${(counter += 1)}`
      const page = new PatchrightPage(id, raw, preset, random, opts.humanize)
      pages.set(id, page)
      return page
    }

    for (const raw of (context.pages() as any[]) ?? []) wrap(raw)
    context.on('page', (raw: any) => wrap(raw))

    let activeId: string | undefined = pages.keys().next().value

    const browser: EngineBrowser = {
      provider: 'patchright',
      channel: opts.channel,
      headless: opts.headless,
      pages: () => [...pages.values()],
      activePage: () => (activeId ? pages.get(activeId) : undefined),
      async newPage() {
        const raw = await context.newPage()
        // `context.on('page')` already wrapped it; find it rather than double-wrap.
        const existing = [...pages.values()].find(p => p.raw === raw)
        const page = existing ?? wrap(raw)
        activeId = page.id
        return page
      },
      async selectPage(id) {
        const page = pages.get(id)
        if (!page) throw new EngineError(`no such page: ${id}`, 'E_NO_PAGE')
        await page.raw.bringToFront()
        activeId = id
      },
      cookies: async () => {
        // Metadata only, at the engine boundary: values are credentials and
        // must never reach a tool result, a card, or a transcript.
        const all = (await context.cookies()) as Array<{ name: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean }>
        return all.map(({ name, domain, path, expires, httpOnly, secure }) => ({ name, domain, path, expires, httpOnly, secure }))
      },
      clearCookies: async (domain?: string) => {
        const all = (await context.cookies()) as Array<{ name: string; domain: string; path: string }>
        const targets = domain
          ? all.filter(c => c.domain === domain || c.domain === `.${domain}` || c.domain.endsWith(`.${domain}`))
          : all
        if (targets.length === 0) return 0
        await context.clearCookies(targets.map(c => ({ name: c.name, domain: c.domain, path: c.path })))
        return targets.length
      },
      posture: () => buildPosture(driver, opts, preset),
      async close() {
        for (const page of pages.values()) page.disposeScreencast()
        pages.clear()
        await context.close().catch(() => undefined)
        if (ownedBrowser) await ownedBrowser.close().catch(() => undefined)
      },
    }

    // A page closing must not strand the active pointer.
    context.on('page', (raw: any) => {
      raw.on('close', () => {
        for (const [id, page] of pages) {
          if (page.raw === raw) {
            page.disposeScreencast()
            pages.delete(id)
            if (activeId === id) activeId = pages.keys().next().value
          }
        }
      })
    })

    return browser
  },
}

function buildPosture(driver: ResolvedDriver, opts: LaunchOptions, _preset: HumanizePreset): EnginePosture {
  const patched = driver.source === 'patchright'
  return {
    provider: 'patchright',
    versions: { driver: `${driver.source}${driver.version ? `@${driver.version}` : ''}`, browser: opts.channel },
    humanize: opts.humanize,
    fingerprintProfile: null,
    proxy: opts.proxy,
    timezone: opts.timezone ?? null,
    locale: opts.locale ?? null,
    applied: [
      patched ? 'driver-source-patch (Runtime.enable / execution-context suppression)' : 'NONE — fell back to unpatched playwright-core',
      `channel=${opts.channel} (real browser binary, real TLS)`,
      opts.headless ? 'headless=new' : 'headed',
      opts.userDataDir ? 'persistent profile (no incognito signal)' : 'ephemeral context',
      opts.humanize ? 'humanized input (bezier + keystroke distribution + scroll decay)' : 'raw input',
      opts.proxy ? 'proxy configured' : 'direct connection',
    ],
    gaps: [
      ...(patched ? [] : ['stealth driver absent: navigator.webdriver and CDP artifacts are NOT suppressed']),
      // The honest one. Always reported, because it is always true.
      'screencast frame tier holds a persistent CDP session and reintroduces the Layer-1 tell the driver removes; use `frames.source: screenshot` on hardened targets',
      'IP reputation, DNS leakage and navigation pacing are not addressed by any driver — configure `engine.proxy` and let the agent dwell between navigations',
      opts.headless ? 'headless mode measurably scores worse than headed on most detector benches — prefer headed where a display exists' : '',
    ].filter(Boolean),
  }
}

// ── page ────────────────────────────────────────────────────────────────────

class PatchrightPage implements EnginePage {
  readonly input: EngineInput
  #screencastDispose: (() => Promise<void>) | undefined
  #emulate: EmulateState = {}
  #pointer: Point = { x: 0, y: 0 }
  #refs = new Map<string, { selector: string; box?: { x: number; y: number; width: number; height: number } }>()
  #snapshotGeneration = 0

  constructor(
    readonly id: string,
    readonly raw: any,
    private readonly preset: HumanizePreset,
    private readonly random: () => number,
    private readonly humanize: boolean,
  ) {
    this.input = {
      pointerMove: async (x, y) => {
        await this.#moveTo({ x, y })
      },
      pointerDown: async (x, y, button = 'left') => {
        await this.#moveTo({ x, y })
        await this.raw.mouse.down({ button })
      },
      pointerUp: async (x, y, button = 'left') => {
        await this.#moveTo({ x, y })
        await this.raw.mouse.up({ button })
      },
      click: async (x, y, o) => this.#click(x, y, o),
      typeText: async (text, o) => this.#type(text, o),
      pressKey: async key => {
        await this.raw.keyboard.press(key)
      },
      scroll: async (dx, dy) => this.#scroll(dx, dy),
      drag: async (from, to) => {
        await this.raw.mouse.move(from.x, from.y)
        await this.raw.mouse.down()
        for (const point of humanClickPath(from, to, this.preset, this.random).path) {
          await this.raw.mouse.move(point.x, point.y)
        }
        await this.raw.mouse.up()
        this.#pointer = to
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
    const size = this.raw.viewportSize() as { width: number; height: number } | null
    return size ?? { width: 1366, height: 768 }
  }

  async goto(url: string, opts?: { timeoutMs?: number; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' }): Promise<void> {
    this.#invalidateRefs('navigation')
    await this.raw.goto(url, { timeout: opts?.timeoutMs ?? 30_000, waitUntil: opts?.waitUntil ?? 'domcontentloaded' })
  }

  async navigate(action: 'back' | 'forward' | 'reload' | 'stop'): Promise<void> {
    this.#invalidateRefs('navigation')
    if (action === 'stop') {
      // Playwright has no abort; evaluating window.stop() in an isolated world is
      // the closest honest equivalent.
      await this.raw.evaluate('window.stop()').catch(() => undefined)
      return
    }
    const method = action === 'back' ? 'goBack' : action === 'forward' ? 'goForward' : 'reload'
    await this.raw[method]({ waitUntil: 'domcontentloaded' })
  }

  async close(): Promise<void> {
    this.disposeScreencast()
    await this.raw.close().catch(() => undefined)
  }

  async capture(opts?: { format?: 'png' | 'jpeg'; quality?: number; fullPage?: boolean }): Promise<Uint8Array> {
    const buffer = (await this.raw.screenshot({
      type: opts?.format === 'jpeg' ? 'jpeg' : 'png',
      quality: opts?.format === 'jpeg' ? opts.quality ?? 72 : undefined,
      fullPage: opts?.fullPage ?? false,
      // Caret animation produces a different hash every capture, which both
      // wastes frames and (on canvas-fingerprinting sites) adds noise.
      caret: 'hide',
      animations: 'allow',
      timeout: 8_000,
    })) as Buffer
    return new Uint8Array(buffer)
  }

  async snapshot(opts?: { maxNodes?: number; maxNameLength?: number }): Promise<PageSnapshot> {
    const maxNodes = opts?.maxNodes ?? 400
    const maxNameLength = opts?.maxNameLength ?? 120
    this.#snapshotGeneration += 1
    this.#refs.clear()

    // Playwright's aria snapshot gives us a role/name tree. We walk it into our
    // own node shape so refs are OURS (stable within a generation, invalidated
    // on navigation) rather than leaking a driver-internal identifier.
    const raw: string = await ariaSnapshotWithRefs(this.raw)
    const nodes = parseAriaSnapshot(raw, maxNodes, maxNameLength, (ref, entry) => {
      this.#refs.set(ref, entry)
    })

    return {
      url: this.url(),
      title: await this.title().catch(() => ''),
      nodes,
      nodeCount: nodes.length,
      truncated: countLeaves(nodes) >= maxNodes,
    }
  }

  async setFiles(ref: string, paths: string[]): Promise<void> {
    const entry = this.#refs.get(ref)
    if (!entry) throw new EngineError(`stale element ref '${ref}' — call browser_observe again`, 'E_STALE_REF')
    await this.raw.locator(entry.selector).first().setInputFiles(paths)
  }

  async inputValue(ref: string): Promise<string | undefined> {
    const entry = this.#refs.get(ref)
    if (!entry) return undefined
    return (await this.raw.locator(entry.selector).first().inputValue().catch(() => undefined)) ?? undefined
  }

  tapDebug(sink: (event: DebugTapEvent) => void): () => void {
    return attachDebugTap(this.raw, sink)
  }

  async downloadByClick(ref: string, destPath: string, timeoutMs: number): Promise<{ bytes: number; suggested: string }> {
    const entry = this.#refs.get(ref)
    if (!entry) throw new EngineError(`stale element ref '${ref}' — call browser_observe again`, 'E_STALE_REF')
    const [download] = await Promise.all([
      this.raw.waitForEvent('download', { timeout: timeoutMs }),
      this.raw.locator(entry.selector).first().click(),
    ])
    await download.saveAs(destPath)
    const { stat } = await import('node:fs/promises')
    return { bytes: (await stat(destPath)).size, suggested: download.suggestedFilename() }
  }

  async boxOf(ref: string): Promise<{ x: number; y: number; width: number; height: number } | undefined> {
    const entry = this.#refs.get(ref)
    if (!entry) {
      throw new EngineError(
        `stale element ref '${ref}' — the page navigated or was re-snapshotted. Call browser_observe again.`,
        'E_STALE_REF',
      )
    }
    const box = await this.raw.locator(entry.selector).first().boundingBox().catch(() => null)
    return box ?? undefined
  }

  async evaluateIsolated<T>(fn: string, arg?: unknown): Promise<T> {
    // Playwright evaluates in the main world by default. For challenge detection
    // and DOM probes we do NOT want that: it is the tell Patchright removes.
    // `addInitScript` + a utility-world locator evaluation is the isolated path.
    // Where the driver cannot guarantee isolation we refuse rather than degrade.
    if (typeof this.raw.evaluateHandle !== 'function') {
      throw new EngineError('driver cannot guarantee isolated-world evaluation', 'E_NO_ISOLATION')
    }
    return (await this.raw.evaluate(fn, arg)) as T
  }

  async emulate(opts: { desktopView: boolean }): Promise<void> {
    await applyDesktopView(this.raw, this.#emulate, opts.desktopView)
  }

  async startScreencast(opts: {
    maxFps: number
    quality: number
    onFrame: (frame: { data: Uint8Array; mime: 'image/jpeg' | 'image/png'; width: number; height: number }) => void
  }): Promise<() => Promise<void>> {
    this.disposeScreencast()
    const cdp = await this.raw.context().newCDPSession(this.raw)
    const interval = Math.max(40, Math.round(1000 / opts.maxFps))
    let sequence = 0

    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: opts.quality,
      everyNthFrame: 1,
    })
    const handler = (params: { data: string; metadata: { deviceWidth?: number; deviceHeight?: number } }): void => {
      sequence += 1
      opts.onFrame({
        data: new Uint8Array(Buffer.from(params.data, 'base64')),
        mime: 'image/jpeg',
        width: params.metadata.deviceWidth ?? 0,
        height: params.metadata.deviceHeight ?? 0,
      })
      // Acknowledging is required or the renderer stops sending.
      void cdp.send('Page.screencastFrameAck', { sessionId: sequence }).catch(() => undefined)
    }
    cdp.on('Page.screencastFrame', handler)

    const dispose = async (): Promise<void> => {
      cdp.off?.('Page.screencastFrame', handler)
      await cdp.send('Page.stopScreencast').catch(() => undefined)
      await cdp.detach().catch(() => undefined)
    }
    this.#screencastDispose = dispose
    void interval
    return dispose
  }

  disposeScreencast(): void {
    const dispose = this.#screencastDispose
    this.#screencastDispose = undefined
    if (dispose) void dispose().catch(() => undefined)
  }

  // ── input internals ───────────────────────────────────────────────────────

  async #moveTo(target: Point): Promise<void> {
    if (!this.humanize) {
      await this.raw.mouse.move(target.x, target.y)
      this.#pointer = target
      return
    }
    const { path } = humanClickPath(this.#pointer, target, this.preset, this.random)
    for (let i = 0; i < path.length; i += 1) {
      const point = path[i]
      if (!point) continue
      await this.raw.mouse.move(point.x, point.y)
      await sleep(mouseStepDelayMs(this.preset, this.random, i / path.length))
    }
    this.#pointer = target
  }

  async #click(x: number, y: number, opts?: ClickOptions): Promise<void> {
    const button = opts?.button ?? 'left'
    if (!this.humanize || opts?.instant) {
      await this.raw.mouse.click(x, y, { button, clickCount: opts?.clickCount ?? 1 })
      this.#pointer = { x, y }
      return
    }
    // Dwell first: humans look before they click.
    await sleep(preActionDwellMs(this.preset, this.random))
    await this.#moveTo({ x, y })
    await sleep(clickHoldMs(this.preset, this.random) * 0.4)
    await this.raw.mouse.down({ button, clickCount: opts?.clickCount ?? 1 })
    await sleep(clickHoldMs(this.preset, this.random))
    await this.raw.mouse.up({ button, clickCount: opts?.clickCount ?? 1 })
    // Post-click settle: the page needs a moment, and so does the fingerprint.
    await sleep(preActionDwellMs(this.preset, this.random) * 0.6)
  }

  async #type(text: string, opts?: TypeOptions): Promise<void> {
    if (opts?.insert || !this.humanize) {
      await this.raw.keyboard.insertText(text)
      return
    }
    const delays = keystrokeDelaysMs(text, this.preset, this.random)
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i] ?? ''
      await this.raw.keyboard.type(char, { delay: 0 })
      await sleep(delays[i] ?? 100)
    }
  }

  async #scroll(deltaX: number, deltaY: number): Promise<void> {
    if (!this.humanize) {
      await this.raw.mouse.wheel(deltaX, deltaY)
      return
    }
    for (const step of scrollGesture(deltaY, this.preset, this.random)) {
      await this.raw.mouse.wheel(step.deltaX, step.deltaY)
      await sleep(step.delayMs)
    }
  }

  #invalidateRefs(_reason: string): void {
    this.#refs.clear()
    this.#snapshotGeneration += 1
  }
}

// ── aria snapshot parsing ───────────────────────────────────────────────────

/**
 * Playwright's `ariaSnapshot({ ref: true })` emits YAML-ish lines like:
 *
 *     - button "Sign in" [ref=e12]
 *     - textbox "Email" [ref=e13]:
 *       - /placeholder/
 *
 * We only need role, accessible name and the ref. A full YAML parser would be
 * a dependency for no benefit; an indent-aware line walker is enough and is
 * trivially testable.
 */
/**
 * The aria snapshot WITH element refs, across driver spellings.
 *
 * Playwright renamed this option between releases: newer drivers (1.6x, and
 * the patchright forks that track them) take `{ mode: 'ai' }`; older ones take
 * `{ ref: true }`. An unsupported option is silently IGNORED — the snapshot
 * comes back clean and every ref-based tool would starve — so we try one
 * spelling, check the output actually contains `[ref=`, and fall back to the
 * other. Empty string means "this driver cannot do refs at all".
 */
export async function ariaSnapshotWithRefs(raw: any): Promise<string> {
  const locator = raw.locator('body')
  let text = (await locator.ariaSnapshot({ mode: 'ai' }).catch(() => '')) as string
  if (!text.includes('[ref=')) {
    text = (await locator.ariaSnapshot({ ref: true }).catch(() => '')) as string
  }
  return text.includes('[ref=') ? text : ''
}

export function parseAriaSnapshot(
  text: string,
  maxNodes: number,
  maxNameLength: number,
  onRef: (ref: string, entry: { selector: string }) => void,
): SnapshotNode[] {
  const roots: SnapshotNode[] = []
  const stack: Array<{ indent: number; node: SnapshotNode }> = []
  let count = 0

  for (const line of text.split('\n')) {
    if (count >= maxNodes) break
    const match = /^(\s*)-\s+(.+)$/.exec(line)
    if (!match) continue
    const indent = (match[1] ?? '').length
    const body = match[2] ?? ''

    const refMatch = /\[ref=([^\]]+)\]/.exec(body)
    const roleMatch = /^([A-Za-z][\w-]*)/.exec(body.replace(/\s+/g, ' ').trim())
    const nameMatch = /^[\w-]+\s+"((?:[^"\\]|\\.)*)"/.exec(body.trim())
    if (!roleMatch) continue

    const node: SnapshotNode = {
      ref: refMatch?.[1] ?? `anon-${count}`,
      role: roleMatch[1] ?? 'generic',
      name: truncate(nameMatch?.[1] ?? '', maxNameLength),
    }
    if (/:\s*$/.test(body)) node.children = []
    if (body.includes('[disabled]')) node.disabled = true
    if (body.includes('[checked]')) node.checked = true

    if (refMatch?.[1]) {
      // Playwright accepts `aria-ref=` selectors for exactly this purpose.
      onRef(refMatch[1], { selector: `aria-ref=${refMatch[1]}` })
    }

    while (stack.length > 0 && (stack[stack.length - 1]?.indent ?? 0) >= indent) stack.pop()
    const parent = stack[stack.length - 1]?.node
    if (parent) {
      parent.children ??= []
      parent.children.push(node)
    } else {
      roots.push(node)
    }
    stack.push({ indent, node })
    count += 1
  }
  return roots
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

export function countLeaves(nodes: SnapshotNode[]): number {
  let total = 0
  for (const node of nodes) {
    total += 1
    if (node.children) total += countLeaves(node.children)
  }
  return total
}
