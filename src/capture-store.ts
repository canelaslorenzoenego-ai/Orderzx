/**
 * Capture store: sequential frame/screenshot files under one defended root.
 *
 * Kept separate from `host.ts` so that filesystem policy lives in exactly one
 * place. The routes' containment check (`classifyCapturePath`) and this module
 * must agree on the root, or a capture the tools wrote becomes a 404 the panel
 * cannot explain.
 *
 * Everything here is bounded: a session capturing at 5 fps for an hour would
 * otherwise write ~18,000 JPEGs. `prune` runs on teardown and on a step count,
 * and only ever deletes inside our own directory.
 *
 * @module @dsh-community/dsh-browser/capture-store
 */

import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { captureDir, nextCapturePath } from './access.js'

export interface CaptureRecord {
  path: string
  bytes: number
  at: number
}

/**
 * Write a capture and return its path.
 *
 * `mode: 0o600` and a `0o700` directory: captures can contain a logged-in
 * session's page content, which is credential-adjacent. They are not world-
 * readable artifacts.
 */
export async function saveCapture(sessionId: string, sequence: number, data: Uint8Array, ext: 'jpg' | 'png' = 'jpg'): Promise<CaptureRecord> {
  const path = nextCapturePath(sessionId, sequence, ext)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, Buffer.from(data), { mode: 0o600 })
  return { path, bytes: data.byteLength, at: Date.now() }
}

/** A recorded clip: ordered frame paths plus the playback envelope. */
export interface ClipManifest {
  id: string
  sessionId: string
  at: number
  fps: number
  seconds: number
  title: string
  url: string
  frames: { path: string; bytes: number; url?: string }[]
}

/**
 * Write a clip manifest beside the session's captures (same 0o600 policy —
 * a clip of a logged-in page is as credential-adjacent as a screenshot).
 */
export async function saveClipManifest(sessionId: string, manifest: ClipManifest): Promise<string> {
  const dir = join(captureDir(), sessionId, 'clips')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `${manifest.id}.json`)
  await writeFile(path, JSON.stringify(manifest), { mode: 0o600 })
  return path
}

export async function readClipManifest(path: string): Promise<ClipManifest | undefined> {
  try {
    const { readFile } = await import('node:fs/promises')
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const manifest = parsed as ClipManifest
    if (typeof manifest.id !== 'string' || !Array.isArray(manifest.frames)) return undefined
    return manifest
  } catch {
    return undefined
  }
}

/**
 * Delete all but the newest `keep` captures for a session.
 *
 * `keep: 0` wipes the session directory, which is what teardown wants.
 *
 * Deliberately implemented with an explicit filename sort rather than mtime:
 * sequence numbers are ours and monotonic, mtimes are not trustworthy across
 * filesystems, and a sort on `<n>.<ext>` is unambiguous.
 */
export async function prune(sessionId: string, keep: number): Promise<number> {
  const dir = join(captureDir(), sessionId)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return 0 // never existed; nothing to prune
  }
  const captures = entries
    .map(name => ({ name, sequence: Number.parseInt(name.split('.')[0] ?? '', 10) }))
    .filter(entry => Number.isFinite(entry.sequence))
    .sort((a, b) => b.sequence - a.sequence) // newest first

  if (keep <= 0) {
    await rm(dir, { recursive: true, force: true })
    return captures.length
  }
  const stale = captures.slice(keep)
  for (const entry of stale) {
    await rm(join(dir, entry.name), { force: true }).catch(() => undefined)
  }
  return stale.length
}

/** Total bytes held for a session — reported in `browser_status`. */
export async function storeSize(sessionId: string): Promise<{ files: number; bytes: number }> {
  const dir = join(captureDir(), sessionId)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return { files: 0, bytes: 0 }
  }
  let bytes = 0
  let files = 0
  for (const name of entries) {
    const info = await stat(join(dir, name)).catch(() => undefined)
    if (info?.isFile()) {
      files += 1
      bytes += info.size
    }
  }
  return { files, bytes }
}

/** Prune every session directory. Called on plugin unload as a final sweep. */
export async function pruneAll(keep: number): Promise<number> {
  let roots: string[]
  try {
    roots = await readdir(captureDir())
  } catch {
    return 0
  }
  let removed = 0
  for (const root of roots) removed += await prune(root, keep)
  return removed
}
