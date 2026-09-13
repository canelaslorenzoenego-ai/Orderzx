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

const MIME = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8' }
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(HTML)
    return
  }
  if (req.method === 'GET' && url.pathname.startsWith('/_dsh/')) {
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
} finally {
  await browser.close()
  server.close()
}
console.log(failures.length === 0 ? `${pass}/${pass} steps passed` : `${pass} passed, ${failures.length} FAILED`)
process.exit(failures.length === 0 ? 0 : 1)
