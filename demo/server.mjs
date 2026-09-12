/**
 * Zero-dependency static server for the panel demo.
 *
 * Serves the repo root so the page can load the REAL artifacts:
 *   /lib/client.js                 the shipped client bundle
 *   /node_modules/react/umd/…      the same React 18 the harness provides
 *   /demo/…                        the harness page itself
 * `/` redirects to the demo. Development aid only — not part of the plugin.
 */
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'

const ROOT = resolve(join(import.meta.dirname, '..'))
const PORT = Number(process.env.PORT ?? 8123)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname === '/') {
    res.writeHead(302, { Location: '/demo/index.html' })
    return res.end()
  }
  // Path-traversal guard: the resolved path must stay inside ROOT.
  const path = resolve(join(ROOT, normalize(url.pathname)))
  if (!path.startsWith(ROOT)) {
    res.writeHead(403)
    return res.end('forbidden')
  }
  void (async () => {
    try {
      const info = await stat(path)
      if (info.isDirectory()) throw new Error('dir')
      const body = await readFile(path)
      res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end('not found')
    }
  })()
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`dsh-browser demo serving on http://0.0.0.0:${PORT} → /demo/index.html`)
})
