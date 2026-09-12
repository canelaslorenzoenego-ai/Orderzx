// Wrap the compiled standalone IIFE bundle into a single self-contained HTML
// page — lib/standalone.html — which GET /_dsh/dsh-browser/panel serves.
//
// One file on purpose: the route handler does not want to reason about asset
// paths, cache-busting or a second mount point, and a phone over `adb reverse`
// wants exactly one request.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const compiledPath = join(root, '.standalone-build', 'standalone.iife.js')
const outputPath = join(root, 'lib', 'standalone.html')

const script = await readFile(compiledPath, 'utf8')
// This bundle MUST contain its own React — unlike lib/client.js there is no
// host realm to share, and a leftover require('react') would be a silent blank
// page on a phone with no console attached.
if (/\brequire\(["']react["']\)|\brequire\(["']react-dom/u.test(script)) {
  throw new Error('Standalone bundle still externalises React; tsdown.standalone.config.mjs must bundle everything')
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="color-scheme" content="dark light" />
<meta name="robots" content="noindex, nofollow" />
<title>DeepSeek Harness · browser panel</title>
<style>
  /* The panel reads the DSW theme variables from the host document. Standalone
     there is no host, so this page provides the dark defaults; a light-scheme
     override keeps the page legible if the OS prefers light. */
  :root {
    --dsw-bg-primary: #101014;
    --dsw-bg-secondary: #16161a;
    --dsw-bg-tertiary: #1d1d23;
    --dsw-bg-hover: rgba(255, 255, 255, 0.06);
    --dsw-border-color: rgba(128, 128, 128, 0.22);
    --dsw-text-primary: rgba(255, 255, 255, 0.92);
    --dsw-text-secondary: rgba(255, 255, 255, 0.58);
    --dsw-text-tertiary: rgba(255, 255, 255, 0.38);
    color-scheme: dark;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --dsw-bg-primary: #ffffff;
      --dsw-bg-secondary: #f7f7f8;
      --dsw-bg-tertiary: #eeeeF1;
      --dsw-bg-hover: rgba(0, 0, 0, 0.05);
      --dsw-border-color: rgba(0, 0, 0, 0.14);
      --dsw-text-primary: rgba(0, 0, 0, 0.88);
      --dsw-text-secondary: rgba(0, 0, 0, 0.56);
      --dsw-text-tertiary: rgba(0, 0, 0, 0.38);
      color-scheme: light;
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background: var(--dsw-bg-primary);
    color: var(--dsw-text-primary);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    overscroll-behavior: none;
  }
  /* Shown only until the panel mounts; the docked panel covers it. */
  #dsh-browser-standalone-fallback {
    position: fixed; inset: 0; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 10px; padding: 24px;
    text-align: center; color: var(--dsw-text-secondary); font-size: 13px;
  }
</style>
</head>
<body>
<div id="dsh-browser-standalone-fallback">Loading the browser panel…</div>
<script>
${script}
</script>
<script>
  // The panel mounted? Drop the fallback so it cannot peek through a transparent
  // seam. Two rAFs: one for React's commit, one for the mount-time slide-in's
  // first paint.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const mounted = document.querySelector('[data-browser-panel-host]')
    if (mounted) document.getElementById('dsh-browser-standalone-fallback')?.remove()
  }))
</script>
</body>
</html>
`

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, html)
await rm(join(root, '.standalone-build'), { recursive: true, force: true })
const bytes = Buffer.byteLength(html)
console.log(`lib/standalone.html written (${bytes.toLocaleString('en-US')} bytes)`)
