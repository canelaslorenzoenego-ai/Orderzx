#!/usr/bin/env node
/**
 * rc.20 — apply the EXTEND-ONLY dashboard patch to an installed dsh-android
 * (DeepSeek Harness Android client) checkout.
 *
 * The two files in `harness/dsh-android-client/` are the harness's own
 * dashboard sources, modified so the device panel can never cover the
 * conversation: the modal/full-screen overlay fallback is gone, narrow
 * viewports dock as the phone split, and the layout lease gained a forced
 * `!important` sheet plus a MutationObserver/interval watchdog so harness
 * re-renders (or hostile `position: fixed; width: 100vw` shells) can no longer
 * decay the push into an overlay.
 *
 * Idempotent: re-running over an already-patched tree is a no-op (compares
 * bytes). Originals are backed up to `<file>.dsh-rc20.bak` once.
 *
 *   node scripts/patch-harness-dashboard.mjs [--target /path/to/dsh-android]
 *
 * Without --target it probes, in order: ../dsh-android, ~/dsh-android,
 * ~/research/dsh-android, node_modules/@zseven-w/dsh-android.
 */
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const HERE = resolve(import.meta.dirname, '..')
const FILES = ['android-panel-dock.ts', 'android-panel-host.tsx']

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
  process.exit(0)
}

let patched = 0
let same = 0
for (const name of FILES) {
  const from = join(HERE, 'harness', 'dsh-android-client', name)
  const to = join(target, 'src', 'client', name)
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
