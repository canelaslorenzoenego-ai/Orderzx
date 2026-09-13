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

import type { DebugTapEvent, EngineBrowser, EnginePage, EnginePosture, EngineProviderAdapter, LaunchOptions } from './types.js'
import { EngineError } from './types.js'
import { applyDesktopView, attachDebugTap, type EmulateState } from './emulate.js'
import { ariaSnapshotWithRefs, countLeaves, parseAriaSnapshot } from './patchright.js'
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
    // raw → wrapper registry: `context.newPage()` wraps directly AND fires the
    // context 'page' event, so without dedupe every new tab gets two wrappers
    // (two ids, double entries in pages()) — and closed tabs must be evicted
    // or pages() lists ghosts forever.
    const byRaw = new Map<any, EnginePage>()
    let counter = 0
    let activeId: string | undefined

    const wrap = (raw: any): EnginePage => {
      const existing = byRaw.get(raw)
      if (existing) return existing
      const id = `p${(counter += 1)}`
      // probeTouch: this engine attaches to the user's OWN real browser (often
      // Chrome on Android via adb) — a one-shot maxTouchPoints probe there is
      // unremarkable, and it is the only way to know whether the desktop-view
      // toggle should also drop touch emulation. Stealth engines never probe.
      const emulateState: EmulateState = { probeTouch: true }
      // Ref bookkeeping, same contract as the patchright engine: refs are ours,
      // they live one snapshot generation, and navigation kills them. An
      // attached browser is a real user browser — refs must fail LOUDLY on a
      // stale generation, never click something the user since changed.
      const refs = new Map<string, { selector: string }>()
      const invalidateRefs = (): void => refs.clear()
      let screencastDispose: (() => Promise<void>) | undefined
      // ── honest viewport ─────────────────────────────────────────────────
      // An attached page has no emulated viewport: playwright's
      // viewportSize() is null and the window is whatever size the user's
      // real browser happens to be. A canned 1366×768 fallback silently
      // breaks every normalized-coordinate consumer: panel gestures land on
      // the wrong element, workflow replay clicks miss, and frame metadata
      // mislabels capture dimensions. Measure the real window instead,
      // refreshed on navigation (awaited — coordinates matter immediately
      // after a load) and opportunistically on capture (throttled) so a
      // user-side resize converges within a couple of seconds.
      const FALLBACK_VIEWPORT = { width: 1366, height: 768 }
      let cachedViewport: { width: number; height: number } | null = null
      let viewportRefreshAt = 0
      const refreshViewport = async (): Promise<void> => {
        try {
          const size = (await raw.evaluate('({ w: window.innerWidth, h: window.innerHeight })')) as { w?: number; h?: number } | null
          const w = size?.w
          const h = size?.h
          if (typeof w === 'number' && typeof h === 'number' && Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
            cachedViewport = { width: Math.round(w), height: Math.round(h) }
          }
        } catch { /* mid-navigation: keep the last known size */ }
      }
      void refreshViewport()
      const page: EnginePage = {
        id,
        url: () => raw.url() as string,
        title: async () => (await raw.title()) as string,
        viewport: () => (raw.viewportSize() as { width: number; height: number } | null) ?? cachedViewport ?? FALLBACK_VIEWPORT,
        goto: async (url, o) => {
          invalidateRefs()
          await raw.goto(url, { timeout: o?.timeoutMs ?? 30_000, waitUntil: o?.waitUntil ?? 'domcontentloaded' })
          await refreshViewport()
        },
        navigate: async action => {
          invalidateRefs()
          if (action === 'stop') return void (await raw.evaluate('window.stop()').catch(() => undefined))
          const m = action === 'back' ? 'goBack' : action === 'forward' ? 'goForward' : 'reload'
          await raw[m]({ waitUntil: 'domcontentloaded' })
          await refreshViewport()
        },
        close: async () => {
          await screencastDispose?.().catch(() => undefined)
          screencastDispose = undefined
          await raw.close().catch(() => undefined)
        },
        snapshot: async (opts) => {
          const maxNodes = opts?.maxNodes ?? 400
          const maxNameLength = opts?.maxNameLength ?? 120
          invalidateRefs()
          const text = await ariaSnapshotWithRefs(raw)
          const nodes = parseAriaSnapshot(text, maxNodes, maxNameLength, (ref, entry) => {
            refs.set(ref, entry)
          })
          return {
            url: raw.url() as string,
            title: await raw.title().catch(() => ''),
            nodes,
            nodeCount: nodes.length,
            truncated: countLeaves(nodes) >= maxNodes,
          }
        },
        setFiles: async (ref, paths) => {
          const entry = refs.get(ref)
          if (!entry) throw new EngineError(`stale element ref '${ref}' — call browser_observe again`, 'E_STALE_REF')
          await raw.locator(entry.selector).first().setInputFiles(paths)
        },
        inputValue: async ref => {
          const entry = refs.get(ref)
          if (!entry) return undefined
          return (await raw.locator(entry.selector).first().inputValue().catch(() => undefined)) ?? undefined
        },
        tapDebug: (sink: (event: DebugTapEvent) => void) => attachDebugTap(raw, sink),
        downloadByClick: async (ref, destPath, timeoutMs) => {
          const entry = refs.get(ref)
          if (!entry) throw new EngineError(`stale element ref '${ref}' — call browser_observe again`, 'E_STALE_REF')
          const [download] = await Promise.all([
            raw.waitForEvent('download', { timeout: timeoutMs }),
            raw.locator(entry.selector).first().click(),
          ])
          await download.saveAs(destPath)
          const { stat } = await import('node:fs/promises')
          return { bytes: (await stat(destPath)).size, suggested: download.suggestedFilename() }
        },
        boxOf: async ref => {
          const entry = refs.get(ref)
          if (!entry) {
            throw new EngineError(
              `stale element ref '${ref}' — the page navigated or was re-snapshotted. Call browser_observe again.`,
              'E_STALE_REF',
            )
          }
          const box = await raw.locator(entry.selector).first().boundingBox().catch(() => null)
          return box ?? undefined
        },
        capture: async o => {
          if (Date.now() - viewportRefreshAt > 2000) {
            viewportRefreshAt = Date.now()
            void refreshViewport()
          }
          return new Uint8Array((await raw.screenshot({
          type: o?.format === 'jpeg' ? 'jpeg' : 'png',
          quality: o?.format === 'jpeg' ? o.quality ?? 72 : undefined,
          fullPage: o?.fullPage ?? false,
          caret: 'hide',
          animations: 'allow',
          timeout: 8_000,
        })) as Buffer)
        },
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
        // Real CDP screencast — the same Page.startScreencast loop the
        // patchright engine runs. The previous no-op stub was a silent lie:
        // the frame loop would report `screencast` as the effective tier while
        // producing nothing but fallback captures.
        startScreencast: async opts => {
          await screencastDispose?.().catch(() => undefined)
          const cdp = await raw.context().newCDPSession(raw)
          let sequence = 0
          await cdp.send('Page.startScreencast', { format: 'jpeg', quality: opts.quality, everyNthFrame: 1 })
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
          screencastDispose = async () => {
            cdp.off?.('Page.screencastFrame', handler)
            await cdp.send('Page.stopScreencast').catch(() => undefined)
            await cdp.detach().catch(() => undefined)
          }
          return () => {
            const dispose = screencastDispose
            screencastDispose = undefined
            return dispose ? dispose() : Promise.resolve()
          }
        },
      }
      pages.set(id, page)
      byRaw.set(raw, page)
      raw.on?.('close', () => {
        pages.delete(id)
        byRaw.delete(raw)
        if (activeId === id) activeId = pages.keys().next().value
      })
      // Ownership propagates to popups: a window.open/target=_blank child of an
      // owned page belongs to this session (and gets its own popup listener via
      // this same wrap). byRaw dedupes against any other discovery path.
      raw.on?.('popup', (child: any) => {
        if (!byRaw.has(child)) wrap(child)
      })
      return page
    }

    // Ownership scoping: an attached browser belongs to the USER, and may also
    // host other sessions' tabs (sub-agents share one CDP browser). A session
    // sees, drives and closes only the pages IT created — pre-existing tabs are
    // never adopted (the old wrap-everything loop made browser_start hijack and
    // navigate the user's own first tab, and let one session close another's
    // pages), and there is deliberately no blanket context 'page' listener: it
    // would pull other sessions' tabs into this session's tab strip. Popups
    // (window.open, target=_blank) descend from an owned page, so ownership
    // propagates through each wrapper's own 'popup' listener instead.
    const first = wrap(await context.newPage())
    activeId = first.id

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
        // Close OWNED pages, then detach WITHOUT killing the user's browser —
        // we are a guest. Owned tabs must not litter the user's window after
        // stop (every previous suite run left stale tabs behind), and foreign
        // tabs were never wrapped, so they cannot be touched here.
        const owned = [...pages.values()]
        pages.clear()
        byRaw.clear()
        activeId = undefined
        for (const page of owned) await page.close().catch(() => undefined)
        await browser.close().catch(() => undefined)
      },
    }
  },
}
