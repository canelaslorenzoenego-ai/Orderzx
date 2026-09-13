#!/usr/bin/env node
// Hostile-harness dock smoke (rc.20, permanent): mounts the REAL shipped
// client (lib/client.js via the __ModuleLoader__ contract, exactly like
// demo/index.html) inside a harness shell built to defeat the dock lease —
// `#root > [data-shell]` with `position: fixed; inset: 0; width: 100vw` —
// while a 700 ms wiper deletes the inline margin, the ownership attribute
// AND detaches the forced <style> sheet.
//
// Asserts the EXTEND-ONLY contract at desktop and phone widths: the chat
// column ends at the panel edge (never under it), the lease heals after wipe
// cycles, and release() still restores the shell byte-for-byte.
//
// Run: DSH_BROWSER_LIVE=1 node scripts/dev-dock-hostile-smoke.mjs
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, resolve, normalize } from 'node:path'
import { chromium } from 'patchright'

const ROOT = resolve(join(import.meta.dirname, '..'))
const PORT = Number(process.env.DSH_DOCK_SMOKE_PORT ?? 39127)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

const HTML = `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>html,body{margin:0;height:100%;background:#0b0b0f}#root{height:100%}</style>
</head><body>
<div id="root"><div data-shell="hostile" style="position:fixed;inset:0;width:100vw;display:flex;flex-direction:column">
  <div data-chat-column style="flex:1 1 auto;overflow:hidden;padding:16px 20px"></div>
  <div data-chatbar style="flex:0 0 auto;height:56px;border-top:1px solid #333"></div>
</div></div>
<script src="/node_modules/react/umd/react.production.min.js"></script>
<script src="/node_modules/react-dom/umd/react-dom.production.min.js"></script>
<script>
  window.__dshRequire = function (id) {
    switch (id) {
      case 'react': return window.React;
      case 'react-dom': return window.ReactDOM;
      case 'react-dom/client': return { createRoot: window.ReactDOM.createRoot, hydrateRoot: window.ReactDOM.hydrateRoot };
      case 'react/jsx-runtime': {
        const jsx = (type, props, key) => {
          const { children, ...rest } = props ?? {};
          if (key !== undefined) rest.key = key;
          return window.React.createElement(type, rest, children);
        };
        return { jsx, jsxs: jsx, jsxDEV: jsx, Fragment: window.React.Fragment };
      }
      default: throw new Error('smoke: unexpected require(' + id + ')');
    }
  };
  window.__ModuleLoader__ = { load({ factory }) { window.DSHBrowserClient = factory(window.__dshRequire); } };
</script>
<script src="/lib/client.js"></script>
<script>
  const SESSION = 'smoke-session';
  const EXPIRES = Date.now() + 3600000;
  const json = b => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const fetcher = async (url) => {
    const u = new URL(url, 'http://smoke.local');
    if (u.pathname.endsWith('/grant')) return json({ kind: 'session', session: SESSION, scope: 'view',
      stream: { token: 'st', expiresAt: EXPIRES }, control: { token: 'ct', expiresAt: EXPIRES } });
    if (u.pathname.endsWith('/status')) return json({ phase: 'streaming', interactionSeq: 1, recent: [],
      session: { id: SESSION, tabs: [{ url: 'http://smoke.local/' }], activeTab: 0, viewport: { width: 1280, height: 720 } },
      sessions: [{ id: SESSION, label: null, phase: 'streaming', owner: 'agent', url: 'http://smoke.local/', challengeVendor: null, desktopView: false }],
      frames: { source: 'screenshot', fps: 2, lastSequence: 1, lastAt: Date.now(), bytes: 100 } });
    return new Response('nope', { status: 404 });
  };
  setInterval(() => {
    const shell = document.querySelector('[data-shell]');
    if (!shell) return;
    shell.style.marginRight = '';
    shell.removeAttribute('data-dsh-browser-panel-dock');
    document.querySelectorAll('style[data-dsh-dock-push]').forEach(s => s.remove());
  }, 700);
  const host = window.DSHBrowserClient.mountBrowserPanelHost({ fetcher });
  host.open({ sessionId: 'conv-smoke', browserSession: SESSION, origin: 'boot' });
  window.__dockHost = host;
</script>
</body></html>`

// Patched-harness page: simulates the modified deepseek-harness AppFrame —
// a grid frame advertising [data-dsh-external-track] that reserves the
// external track from the published variable/event (native extend).
const PATCHED_HTML = `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>html,body{margin:0;height:100%;background:#0b0b0f}
[data-frame]{display:grid;grid-template-rows:100%;height:100%;overflow:hidden}
[data-rail]{background:#111}[data-center]{display:flex;flex-direction:column;min-width:0;overflow:hidden}
[data-chat-column]{flex:1 1 auto;overflow:hidden;padding:16px 20px}
[data-chatbar]{flex:0 0 auto;height:56px;border-top:1px solid #333}</style>
</head><body>
<div data-frame data-dsh-external-track="ready">
  <div data-rail></div>
  <div data-center><div data-chat-column></div><div data-chatbar></div></div>
  <div data-rightbar></div>
  <div data-external></div>
</div>
<script>
  // The modified AppFrame's track subscription, faithfully tiny.
  const frame = document.querySelector('[data-frame]');
  const read = () => {
    const px = Number.parseFloat(document.documentElement.style.getPropertyValue('--dsh-external-side-track'));
    return Number.isFinite(px) && px > 0 ? Math.round(px) : 0;
  };
  const apply = (ext) => {
    const vw = window.innerWidth;
    const narrow = vw < 768;
    const centerMin = narrow ? 179 : 400;
    const extMin = narrow ? 140 : 240;
    const rail = 56;
    const available = vw - rail - centerMin;
    const e = ext === 0 || available < extMin ? 0 : Math.min(available, Math.max(extMin, Math.min(ext, vw * 0.6)));
    frame.style.gridTemplateColumns = rail + 'px minmax(0, 1fr) 0px ' + e + 'px';
    document.documentElement.style.setProperty('--dsh-external-side-track-granted', e + 'px');
    window.dispatchEvent(new CustomEvent('dsh-external-side-track-granted', { detail: { width: e } }));
  };
  window.addEventListener('dsh-external-side-track', (ev) => apply(typeof ev.detail?.width === 'number' ? ev.detail.width : read()));
  setInterval(() => apply(read()), 400);
  apply(read());
</script>
<script src="/node_modules/react/umd/react.production.min.js"></script>
<script src="/node_modules/react-dom/umd/react-dom.production.min.js"></script>
<script>
  window.__dshRequire = function (id) {
    switch (id) {
      case 'react': return window.React;
      case 'react-dom': return window.ReactDOM;
      case 'react-dom/client': return { createRoot: window.ReactDOM.createRoot, hydrateRoot: window.ReactDOM.hydrateRoot };
      case 'react/jsx-runtime': {
        const jsx = (type, props, key) => {
          const { children, ...rest } = props ?? {};
          if (key !== undefined) rest.key = key;
          return window.React.createElement(type, rest, children);
        };
        return { jsx, jsxs: jsx, jsxDEV: jsx, Fragment: window.React.Fragment };
      }
      default: throw new Error('smoke: unexpected require(' + id + ')');
    }
  };
  window.__ModuleLoader__ = { load({ factory }) { window.DSHBrowserClient = factory(window.__dshRequire); } };
</script>
<script src="/lib/client.js"></script>
<script>
  const SESSION = 'smoke-session';
  const EXPIRES = Date.now() + 3600000;
  const json = b => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const fetcher = async (url) => {
    const u = new URL(url, 'http://smoke.local');
    if (u.pathname.endsWith('/grant')) return json({ kind: 'session', session: SESSION, scope: 'view',
      stream: { token: 'st', expiresAt: EXPIRES }, control: { token: 'ct', expiresAt: EXPIRES } });
    if (u.pathname.endsWith('/status')) return json({ phase: 'streaming', interactionSeq: 1, recent: [],
      session: { id: SESSION, tabs: [{ url: 'http://smoke.local/' }], activeTab: 0, viewport: { width: 1280, height: 720 } },
      sessions: [{ id: SESSION, label: null, phase: 'streaming', owner: 'agent', url: 'http://smoke.local/', challengeVendor: null, desktopView: false }],
      frames: { source: 'screenshot', fps: 2, lastSequence: 1, lastAt: Date.now(), bytes: 100 } });
    return new Response('nope', { status: 404 });
  };
  const host = window.DSHBrowserClient.mountBrowserPanelHost({ fetcher });
  host.open({ sessionId: 'conv-smoke', browserSession: SESSION, origin: 'boot' });
</script>
</body></html>`

const MIME = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8' }
const stats = { polls: [], sse: null, sseOpenedAt: 0, pollMode: false, paths: [] }
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(HTML)
    return
  }
  if (url.pathname === '/patched') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(PATCHED_HTML)
    return
  }
  if (url.pathname === '/__stats') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ polls: stats.polls, sseOpenedAt: stats.sseOpenedAt, paths: stats.paths.slice(-12) }))
    return
  }
  if (url.pathname === '/__mode') {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      stats.pollMode = JSON.parse(body || '{}').poll === true
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
    })
    return
  }
  if (url.pathname === '/__emit') {
    if (stats.sse === null) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end('{"ok":false,"error":"no sse"}')
      return
    }
    stats.sse.write('event: interaction\n'
      + `data: ${JSON.stringify({ seq: 1, at: Date.now(), actor: 'agent', event: { type: 'click', x: 0.45, y: 0.55, button: 'left', label: 'search' } })}\n\n`)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"ok":true}')
    return
  }
  if (req.method === 'GET' && url.pathname.startsWith('/_dsh/')) {
    stats.paths.push(url.pathname)
    if (url.pathname.endsWith('/interactions')) {
      stats.sse = res
      stats.sseOpenedAt = Date.now()
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
      res.write(': ok\n\n')
      return
    }
    if (url.pathname.endsWith('/stream')) {
      // Multiparty grant: a buffering-WebView simulation returns 404 in poll
      // mode so the client's stall probe flips it to single-frame polls.
      if (stats.pollMode) {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('buffered forever')
        return
      }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' })
      res.end(PNG)
      return
    }
    if (url.pathname.endsWith('/stream/frame')) {
      stats.polls.push(Date.now())
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' })
      res.end(PNG)
      return
    }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' })
    res.end(PNG)
    return
  }
  const path = resolve(join(ROOT, normalize(url.pathname)))
  if (!path.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return }
  void readFile(path).then(body => {
    res.writeHead(200, { 'Content-Type': MIME[path.slice(path.lastIndexOf('.'))] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
    res.end(body)
  }).catch(() => { res.writeHead(404); res.end('not found') })
})

let pass = 0
const failures = []
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log('  ok ' + label) } else { failures.push(label); console.error('FAIL ' + label) }
}

const measure = page => page.evaluate(() => {
  const chat = document.querySelector('[data-chat-column]')?.getBoundingClientRect()
  const panel = document.querySelector('[data-dsh-side-surface]')?.getBoundingClientRect()
  const shell = document.querySelector('[data-shell]')
  return {
    surface: document.querySelector('[data-dsh-side-surface]')?.getAttribute('data-dsh-side-surface') ?? null,
    chatRight: chat?.right ?? -1,
    chatWidth: chat?.width ?? -1,
    panelLeft: panel?.left ?? -1,
    shellMargin: shell?.style.marginRight ?? '',
    sheet: document.querySelector('style[data-dsh-dock-push]')?.isConnected === true,
  }
})
const extended = m => m.surface === 'dock' && m.chatRight <= m.panelLeft + 2 && m.chatWidth >= 150

await new Promise(resolve => server.listen(PORT, '127.0.0.1', resolve))
const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
try {
  for (const [label, viewport] of [['desktop 1280', { width: 1280, height: 800 }], ['phone 390', { width: 390, height: 844 }]]) {
    const page = await (await browser.newContext({ viewport })).newPage()
    await page.goto(`http://127.0.0.1:${PORT}/`)
    await page.waitForSelector('[data-dsh-side-surface]', { timeout: 20000 })
    await page.waitForTimeout(1200)
    const first = await measure(page)
    ok(first.surface === 'dock', `${label}: surface docks (got ${first.surface})`)
    ok(extended(first), `${label}: chat column ends at the panel edge (${Math.round(first.chatRight)} vs ${Math.round(first.panelLeft)})`)
    await page.waitForTimeout(1800) // >= 2 wiper cycles
    const healed = await measure(page)
    ok(extended(healed) && healed.shellMargin !== '', `${label}: lease heals through wipe cycles (margin ${healed.shellMargin})`)
    ok(healed.sheet, `${label}: forced sheet re-attached after detach`)
    if (label.startsWith('desktop')) {
      await page.click('[data-dsh-side-surface] button[aria-label="close the side dashboard"]')
      await page.waitForTimeout(900)
      const after = await measure(page)
      ok(after.shellMargin === '' && !after.sheet, 'the × release restores the shell and drops the sheet under the wiper')
    }
    await page.context().close()
  }

  // ── burst cadence (the rc.20 "see the model act" fix) ────────────────────
  // A gesture arriving over the SSE channel must repaint immediately and
  // tighten the poll cadence from the idle tier (500 ms at 2 fps) to the
  // 200 ms floor for its 4 s window. Poll mode is forced by 404-ing the
  // multipart stream (the buffering-WebView simulation).
  await fetch(`http://127.0.0.1:${PORT}/__mode`, { method: 'POST', body: '{"poll":true}' })
  const burstPage = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
  await burstPage.goto(`http://127.0.0.1:${PORT}/`)
  await burstPage.waitForSelector('[data-dsh-side-surface]', { timeout: 20000 })
  await burstPage.waitForTimeout(6000) // stall probe (4 s) flips to polling
  const readStats = async () => (await (await fetch(`http://127.0.0.1:${PORT}/__stats`)).json())
  const s0 = await readStats()
  ok(s0.sseOpenedAt > 0, 'burst: gesture channel (SSE) connected')
  ok(s0.polls.length > 0, 'burst: stall probe fell back to single-frame polls')
  await new Promise(resolve => setTimeout(resolve, 2500))
  const s1 = await readStats()
  const base = s1.polls.length - s0.polls.length
  const emitAt = Date.now()
  const emitted = await (await fetch(`http://127.0.0.1:${PORT}/__emit`, { method: 'POST' })).json()
  ok(emitted.ok === true, 'burst: gesture event delivered to the panel')
  await new Promise(resolve => setTimeout(resolve, 2500))
  const s2 = await readStats()
  const burst = s2.polls.length - s1.polls.length
  ok(burst >= base + 4, `burst: gesture tightens cadence (${base} idle vs ${burst} bursting polls per 2.5 s)`)
  const afterEmit = s2.polls.filter(t => t >= emitAt - 50)
  const immediate = afterEmit.length > 0 ? afterEmit[0] - emitAt : Number.POSITIVE_INFINITY
  ok(immediate < 450, `burst: repaint lands within one tick of the gesture (${Math.round(immediate)} ms)`)
  await burstPage.context().close()

  // ── patched harness: native external track (deepseek-harness ui-layout) ──
  const measurePatched = page => page.evaluate(() => {
    const chat = document.querySelector('[data-chat-column]')?.getBoundingClientRect()
    const panel = document.querySelector('[data-dsh-side-surface]')?.getBoundingClientRect()
    const frame = document.querySelector('[data-frame]')
    return {
      surface: document.querySelector('[data-dsh-side-surface]')?.getAttribute('data-dsh-side-surface') ?? null,
      chatRight: chat?.right ?? -1,
      chatWidth: chat?.width ?? -1,
      panelLeft: panel?.left ?? -1,
      frameMargin: frame?.style.marginRight ?? 'x',
      variable: document.documentElement.style.getPropertyValue('--dsh-external-side-track'),
    }
  })
  for (const [label, viewport] of [
    ['patched desktop 1280', { width: 1280, height: 800 }],
    ['patched phone 390', { width: 390, height: 844 }],
  ]) {
    const page = await (await browser.newContext({ viewport })).newPage()
    await page.goto(`http://127.0.0.1:${PORT}/patched`)
    await page.waitForSelector('[data-dsh-side-surface]', { timeout: 20000 })
    await page.waitForTimeout(900)
    const m = await measurePatched(page)
    ok(m.surface === 'dock', `${label}: surface docks`)
    ok(m.chatRight <= m.panelLeft + 2 && m.chatWidth >= 150,
      `${label}: conversation extends around the panel (${Math.round(m.chatRight)} vs ${Math.round(m.panelLeft)})`)
    ok(m.frameMargin === '', `${label}: native track — no margin lease on the frame`)
    ok(m.variable !== '', `${label}: width published via --dsh-external-side-track (${m.variable || 'missing'})`)
    if (label.includes('phone')) {
      // ask 211 / granted 155 on a 390 viewport: the surface must size to the
      // GRANTED track, or it would overlap the conversation again.
      const panelWidth = (await page.evaluate(() => window.innerWidth)) - m.panelLeft
      ok(Math.abs(panelWidth - 155) <= 3, `patched phone: panel sizes to the granted track (${Math.round(panelWidth)}px)`)
    }
    if (label.includes('desktop')) {
      await page.click('[data-dsh-side-surface] button[aria-label="close the side dashboard"]')
      await page.waitForTimeout(700)
      const after = await measurePatched(page)
      ok(after.variable === '' && after.chatWidth > m.chatWidth + 200,
        'patched desktop: close returns the track to the conversation')
    }
    await page.context().close()
  }
} finally {
  await browser.close()
  server.close()
}
console.log(failures.length === 0 ? `${pass}/${pass} steps passed` : `${pass} passed, ${failures.length} FAILED`)
process.exit(failures.length === 0 ? 0 : 1)
