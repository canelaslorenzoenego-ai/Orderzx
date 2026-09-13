#!/usr/bin/env node
/**
 * rc.20 — apply the EXTEND-ONLY dashboard patch to an installed dsh-android
 * (DeepSeek Harness Android client) checkout.
 *
 * The sources in `harness/dsh-android-client/` are the harness's own dashboard
 * and stream files, modified so the device panel can never cover the
 * conversation and never sits on a black frame:
 *   - android-panel-host/dock: modal/full-screen overlay fallback gone,
 *     narrow viewports dock as the phone split, forced `!important` sheet +
 *     MutationObserver/interval watchdog so harness re-renders (or hostile
 *     `position: fixed; width: 100vw` shells) can no longer decay the push
 *     into an overlay;
 *   - android-stream-session + stream-routes: a single-frame route and a
 *     stall probe, so a WebView that buffers the multipart body forever
 *     falls back to 4 fps polls instead of a black "live" frame;
 *   - protocol/copy: the new route's error code + copy.
 *
 * Idempotent: re-running over an already-patched tree is a no-op (compares
 * bytes). Originals are backed up to `<file>.dsh-rc20.bak` once.
 *
 *   node scripts/patch-harness-dashboard.mjs [--target /path/to/dsh-android]
 *                                            [--web-target /path/to/deepseek-harness]
 *
 * Without --target it probes, in order: ../dsh-android, ~/dsh-android,
 * ~/research/dsh-android, node_modules/@zseven-w/dsh-android.
 *
 * rc.24 also patches the deepseek-harness WEB monorepo when one is found
 * (--web-target, else ../deepseek-harness or ~/deepseek-harness): it applies
 * harness/deepseek-harness-dashboard.patch, which gives AppFrame a native
 * external grid track so the panel extends the dashboard by design.
 */
import { spawnSync } from 'node:child_process'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const HERE = resolve(import.meta.dirname, '..')
/** Patched harness sources: [file inside harness/dsh-android-client, target path in the checkout]. */
const FILES = [
  ['android-panel-dock.ts', join('src', 'client', 'android-panel-dock.ts')],
  ['android-panel-host.tsx', join('src', 'client', 'android-panel-host.tsx')],
  ['android-stream-session.ts', join('src', 'client', 'android-stream-session.ts')],
  ['protocol.ts', join('src', 'client', 'protocol.ts')],
  ['copy.ts', join('src', 'client', 'copy.ts')],
  ['stream-routes.ts', join('src', 'stream-routes.ts')],
]

const argTarget = process.argv.includes('--target')
  ? process.argv[process.argv.indexOf('--target') + 1]
  : undefined

const candidates = [
  ...(argTarget ? [resolve(argTarget)] : []),
  resolve(HERE, '..', 'dsh-android'),
  join(homedir(), 'dsh-android'),
  join(homedir(), 'research', 'dsh-android'),
  resolve(HERE, 'node_modules', '@zseven-w', 'dsh-android'),
]

const target = candidates.find(dir => existsSync(join(dir, 'src', 'client', 'android-panel-host.tsx')))
if (target === undefined) {
  console.log('patch-harness-dashboard: no dsh-android checkout found (tried:')
  for (const dir of candidates) console.log('  ' + dir)
  console.log(') — skipped. Pass --target <dir> to patch one explicitly.')
} else {
  let patched = 0
  let same = 0
  for (const [name, rel] of FILES) {
    const from = join(HERE, 'harness', 'dsh-android-client', name)
    const to = join(target, rel)
    const [a, b] = await Promise.all([readFile(from), readFile(to).catch(() => null)])
    if (b !== null && a.equals(b)) {
      same += 1
      continue
    }
    if (b !== null && !existsSync(`${to}.dsh-rc20.bak`)) await writeFile(`${to}.dsh-rc20.bak`, b)
    await copyFile(from, to)
    patched += 1
    console.log(`patch-harness-dashboard: ${name} → ${to}`)
  }
  console.log(
    patched === 0
      ? `patch-harness-dashboard: ${target} already extend-only (${same} file(s) identical)`
      : `patch-harness-dashboard: patched ${patched} file(s) in ${target} (backups: *.dsh-rc20.bak)`,
  )
}

// ── rc.24: deepseek-harness WEB monorepo — the ui-layout external track ──────
// harness/deepseek-harness-dashboard.patch adds a 4th grid track to the real
// dashboard (packages/client/ui-layout AppFrame + columns): the panel
// publishes its width via --dsh-external-side-track, AppFrame reserves a real
// column for it and reports the granted width back, so the browser EXTENDS
// the layout natively instead of leasing margins into the page.
const WEB_PATCH = join(HERE, 'harness', 'deepseek-harness-dashboard.patch')
const APPFRAME_REL = join('packages', 'client', 'ui-layout', 'src', 'client', 'AppFrame.tsx')
const argWeb = process.argv.includes('--web-target')
  ? process.argv[process.argv.indexOf('--web-target') + 1]
  : undefined
const webCandidates = [
  ...(argWeb ? [resolve(argWeb)] : []),
  resolve(HERE, '..', 'deepseek-harness'),
  join(homedir(), 'deepseek-harness'),
  resolve(HERE, 'node_modules', 'deepseek-harness'),
]
const webTarget = webCandidates.find(dir => existsSync(join(dir, APPFRAME_REL)))
if (webTarget === undefined) {
  console.log('patch-harness-dashboard: no deepseek-harness web checkout found (tried:')
  for (const dir of webCandidates) console.log('  ' + dir)
  console.log(') — skipped. Pass --web-target <dir> to patch one explicitly.')
} else if ((await readFile(join(webTarget, APPFRAME_REL), 'utf8')).includes('data-dsh-external-track')) {
  console.log(`patch-harness-dashboard: ${webTarget} already has the external track`)
} else {
  const applied = spawnSync('git', ['apply', '--whitespace=nowarn', WEB_PATCH], { cwd: webTarget, encoding: 'utf8' })
  if (applied.status === 0) {
    console.log(`patch-harness-dashboard: applied external-track patch to ${webTarget} (AppFrame.tsx + columns.ts)`)
  } else {
    console.log(`patch-harness-dashboard: git apply failed in ${webTarget}: ${(applied.stderr || '').trim()}`)
    console.log('  If the checkout drifted from the patch base, apply harness/deepseek-harness-dashboard.patch manually (git apply --3way).')
    process.exitCode = 1
  }
}
