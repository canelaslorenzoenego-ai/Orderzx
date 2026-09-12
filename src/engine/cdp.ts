/**
 * Optional engine provider: attach to a browser you launched yourself.
 *
 * `engine.provider: cdp` + `engine.cdpEndpoint: ws://127.0.0.1:9222/devtools/browser/…`
 * connects over `chromium.connectOverCDP` instead of launching anything.
 *
 * Why this exists:
 *
 *  1. It is the escape hatch when every bundled driver is detected. You launch
 *     Chrome by hand (or from a hardened wrapper, a container, a real desktop
 *     session) and the plugin just drives it.
 *  2. It pairs with the `mirror` frame tier: a browser on a real display can be
 *     captured at the compositor with zero CDP involvement, which is the only
 *     configuration that has both native-fps streaming and no added tell.
 *  3. It lets a user reuse an already-authenticated browser session instead of
 *     re-logging in inside an automation profile.
 *
 * SECURITY: attaching over CDP hands this plugin full control of a browser that
 * may hold the user's real cookies, passwords and sessions. The endpoint is
 * therefore only ever read from config — never from a tool argument — and it is
 * redacted in status output. See SECURITY.md.
 *
 * @module @dsh-community/dsh-browser/engine/cdp
 */

import type { EngineBrowser, EnginePage, EnginePosture, EngineProviderAdapter, LaunchOptions } from './types.js'
import { EngineError } from './types.js'
import { applyDesktopView, type EmulateState } from './emulate.js'
import { patchrightProvider } from './patchright.js'

let endpoint: string | null = null

/** Set from config apply. Never from the model, never from a tool argument. */
export function configureCdpEndpoint(value: string | null): void {
  endpoint = value?.trim() || null
}

export function cdpEndpoint(): string | null {
  return endpoint
}

/** Redacted for status/logging: keep the host+port, drop any token path. */
export function redactEndpoint(value: string | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}${url.pathname.split('/').slice(0, 3).join('/')}/…`
  } catch {
    return '<unparseable endpoint>'
  }
}

export const cdpProvider: EngineProviderAdapter = {
  name: 'cdp',

  async probe() {
    if (!endpoint) {
      return {
        available: false,
        reason: 'engine.cdpEndpoint is not configured. Launch Chrome with `--remote-debugging-port=9222` '
          + 'and set `engine.cdpEndpoint: http://127.0.0.1:9222` (or the ws:// browser endpoint).',
      }
    }
    return { available: true, detail: `attach → ${redactEndpoint(endpoint)}` }
  },

  async launch(_opts: LaunchOptions): Promise<EngineBrowser> {
    if (!endpoint) throw new EngineError('engine.cdpEndpoint is not configured', 'E_NO_ENDPOINT')

    // Reuse the patchright/playwright-core module loader; connectOverCDP lives
    // on the same chromium object.
    const adapter = patchrightProvider
    void adapter

    const { createRequire } = await import('node:module')
    const require = createRequire(import.meta.url)
    let chromium: any
    try {
      chromium = (require('patchright') as any).chromium
    } catch {
      chromium = (require('playwright-core') as any).chromium
    }

    const browser = await chromium.connectOverCDP(endpoint, { timeout: _opts.timeoutMs })
    const context = browser.contexts()[0] ?? (await browser.newContext())

    // Wrap via the same page machinery. We construct a minimal EngineBrowser
    // rather than reusing patchrightProvider.launch, because nothing was
    // launched and the posture is entirely different.
    const pages = new Map<string, EnginePage>()
    let counter = 0
    let activeId: string | undefined

    const wrap = (raw: any): EnginePage => {
      const id = `p${(counter += 1)}`
      // probeTouch: this engine attaches to the user's OWN real browser (often
      // Chrome on Android via adb) — a one-shot maxTouchPoints probe there is
      // unremarkable, and it is the only way to know whether the desktop-view
      // toggle should also drop touch emulation. Stealth engines never probe.
      const emulateState: EmulateState = { probeTouch: true }
      const page: EnginePage = {
        id,
        url: () => raw.url() as string,
        title: async () => (await raw.title()) as string,
        viewport: () => (raw.viewportSize() as { width: number; height: number } | null) ?? { width: 1366, height: 768 },
        goto: async (url, o) => raw.goto(url, { timeout: o?.timeoutMs ?? 30_000, waitUntil: o?.waitUntil ?? 'domcontentloaded' }),
        navigate: async action => {
          if (action === 'stop') return void (await raw.evaluate('window.stop()').catch(() => undefined))
          const m = action === 'back' ? 'goBack' : action === 'forward' ? 'goForward' : 'reload'
          await raw[m]({ waitUntil: 'domcontentloaded' })
        },
        close: async () => raw.close().catch(() => undefined),
        snapshot: async () => ({ url: raw.url(), title: await raw.title().catch(() => ''), nodes: [], nodeCount: 0, truncated: false }),
        boxOf: async () => undefined,
        capture: async o => new Uint8Array((await raw.screenshot({ type: o?.format === 'jpeg' ? 'jpeg' : 'png', caret: 'hide' })) as Buffer),
        input: {
          pointerMove: async (x, y) => raw.mouse.move(x, y),
          pointerDown: async (x, y, b = 'left') => { await raw.mouse.move(x, y); await raw.mouse.down({ button: b }) },
          pointerUp: async (x, y, b = 'left') => { await raw.mouse.move(x, y); await raw.mouse.up({ button: b }) },
          click: async (x, y) => raw.mouse.click(x, y),
          typeText: async (text, o) => (o?.insert ? raw.keyboard.insertText(text) : raw.keyboard.type(text)),
          pressKey: async key => raw.keyboard.press(key),
          scroll: async (dx, dy) => raw.mouse.wheel(dx, dy),
          drag: async (from, to) => {
            await raw.mouse.move(from.x, from.y)
            await raw.mouse.down()
            await raw.mouse.move(to.x, to.y, { steps: 16 })
            await raw.mouse.up()
          },
        },
        evaluateIsolated: async <T,>(fn: string, arg?: unknown) => (await raw.evaluate(fn, arg)) as T,
        emulate: async opts => {
          await applyDesktopView(raw, emulateState, opts.desktopView)
        },
        startScreencast: async () => () => Promise.resolve(),
      }
      pages.set(id, page)
      return page
    }

    for (const raw of (context.pages() as any[]) ?? []) wrap(raw)
    context.on('page', (raw: any) => wrap(raw))
    activeId = pages.keys().next().value

    return {
      provider: 'cdp',
      channel: 'chrome',
      headless: false,
      pages: () => [...pages.values()],
      activePage: () => (activeId ? pages.get(activeId) : undefined),
      async newPage() {
        const page = wrap(await context.newPage())
        activeId = page.id
        return page
      },
      async selectPage(id) {
        if (!pages.has(id)) throw new EngineError(`no such page: ${id}`, 'E_NO_PAGE')
        activeId = id
      },
      posture: (): EnginePosture => ({
        provider: 'cdp',
        versions: { driver: 'connectOverCDP' },
        humanize: false,
        fingerprintProfile: null,
        proxy: null,
        timezone: null,
        locale: null,
        applied: [
          `attached to an externally launched browser at ${redactEndpoint(endpoint)}`,
          'whatever stealth the launching process configured — this plugin adds none',
        ],
        gaps: [
          'ATTACHED SESSION: the browser may hold the user\'s real cookies, passwords and logged-in sessions. Every tool call here acts on a real profile.',
          'a persistent CDP connection is itself a Layer-1 tell; the host browser\'s own configuration decides how much that matters',
          'no humanization layer — input events are raw. Combine with the host browser\'s own settings or use a different provider',
          'the plugin cannot restart or repair this browser; if it exits, browser_start must be re-run against a new endpoint',
        ],
      }),
      async close() {
        // Detach WITHOUT killing the user's browser. This is the whole point of
        // the provider: we are a guest.
        pages.clear()
        await browser.close().catch(() => undefined)
      },
    }
  },
}
