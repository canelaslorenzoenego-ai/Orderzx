/**
 * Capability tokens and the transport fence for the dsh-browser web routes.
 *
 * Ported from dsh-android's stream-access.ts with the same security posture,
 * plus one addition this plugin needs and Android does not: a **scope** on the
 * control token.
 *
 *   view   — may GET /stream and /capture. Read-only observation.
 *   drive  — may also POST /control and /session. Owns the pointer.
 *
 * That split matters because the panel hands `view` to every open tab but
 * `drive` only to the tab that explicitly took over. Without it, any page that
 * can reach the loopback route can drive the browser.
 *
 * Posture, unchanged from upstream:
 *  - HMAC-SHA256 capabilities `base64url(payload).base64url(mac)`, signed with a
 *    32-byte per-DSH-home key (`<DSH_HOME>/cache/dsh-browser/stream-access.key`,
 *    mode 0600, created atomically with `wx`); tokens expire within 10 minutes.
 *  - Every route applies the loopback/trusted-transport fence (peer address,
 *    loopback Host, Fetch-Metadata/Origin) BEFORE any capability is consulted.
 *    Host and Origin are caller-controlled data, so a LAN client cannot spoof
 *    localhost and a DNS-rebinding Host is rejected.
 *  - The capture route serves exactly one directory, walked with `lstat` (no
 *    symlinks) and finished with a `realpath` containment check.
 *
 * @module @dsh-community/dsh-browser/access
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { TOKEN_TTL_MS } from './protocol.js'
import type { CaptureTokenPayload, ControlTokenPayload, StreamTokenPayload } from './protocol.js'

const KEY_BYTES = 32
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
const MAX_TOKEN_LENGTH = 16 * 1024
/** Signing may run ahead of verification by this much before the TTL cap trips. */
const CLOCK_SKEW_MS = 60 * 1000
const MAX_CAPTURE_BYTES = 32 * 1024 * 1024
/** Session ids are ours to mint, but validate defensively anyway. */
const SESSION_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

// ── payload validation ──────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isExpiry(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

export function parseStreamPayload(value: unknown): StreamTokenPayload | undefined {
  if (!isRecord(value)) return undefined
  if (value.v !== 1 || value.kind !== 'browser-stream') return undefined
  if (typeof value.session !== 'string' || !SESSION_PATTERN.test(value.session)) return undefined
  if (!isExpiry(value.exp)) return undefined
  return { v: 1, kind: 'browser-stream', session: value.session, exp: value.exp }
}

export function parseCapturePayload(value: unknown): CaptureTokenPayload | undefined {
  if (!isRecord(value)) return undefined
  if (value.v !== 1 || value.kind !== 'browser-capture') return undefined
  if (typeof value.path !== 'string' || !isAbsolute(value.path)) return undefined
  if (!isExpiry(value.exp)) return undefined
  return { v: 1, kind: 'browser-capture', path: value.path, exp: value.exp }
}

export function parseControlPayload(value: unknown): ControlTokenPayload | undefined {
  if (!isRecord(value)) return undefined
  if (value.v !== 1 || value.kind !== 'browser-control') return undefined
  if (typeof value.session !== 'string' || !SESSION_PATTERN.test(value.session)) return undefined
  if (value.scope !== 'view' && value.scope !== 'drive') return undefined
  if (!isExpiry(value.exp)) return undefined
  return { v: 1, kind: 'browser-control', session: value.session, scope: value.scope, exp: value.exp }
}

// ── key material ────────────────────────────────────────────────────────────

export function dshHome(): string {
  const env = process.env.DSH_HOME?.trim()
  return env === undefined || env.length === 0 ? join(homedir(), '.dsh') : resolve(env)
}

/** Plugin-managed state root (mirrors the dsh-android convention). */
export function stateRoot(): string {
  return join(dshHome(), 'cache', 'dsh-browser')
}

/**
 * Capture cache: the ONLY directory the capture route will serve.
 *
 * Shared with the tools' capture store so every `browser_observe` screenshot can
 * be granted a capability without further configuration.
 */
export function captureDir(): string {
  return join(tmpdir(), 'dsh-browser', 'captures')
}

/** Persistent browser profile root (cookies, localStorage). Outside tmp. */
export function profileRoot(): string {
  return join(dshHome(), 'browser-profiles')
}

function mac(key: Buffer, payload: string): Buffer {
  return createHmac('sha256', key).update(payload).digest()
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right)
}

async function readKeyFile(path: string): Promise<Buffer> {
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('dsh-browser access key is not a regular file')
  const key = await readFile(path)
  if (key.length !== KEY_BYTES) throw new Error('dsh-browser access key has an invalid length')
  return key
}

/** Load or atomically create the per-DSH-home signing key (0600). */
export async function prepareAccessKey(): Promise<Buffer> {
  await mkdir(stateRoot(), { recursive: true, mode: 0o700 })
  const path = join(stateRoot(), 'stream-access.key')
  try {
    return await readKeyFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const candidate = randomBytes(KEY_BYTES)
  try {
    // `wx` so two processes racing to create the key cannot clobber each other.
    await writeFile(path, candidate, { flag: 'wx', mode: 0o600 })
    return candidate
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return readKeyFile(path)
  }
}

// ── controller ──────────────────────────────────────────────────────────────

export type TokenPayload = StreamTokenPayload | CaptureTokenPayload | ControlTokenPayload

export class AccessController {
  #keyPromise: Promise<Buffer> | undefined

  constructor(private readonly resolveKey: () => Promise<Buffer> = prepareAccessKey) {}

  /** Mint a stream capability for one session. */
  async signStreamToken(session: string, options: { ttlMs?: number } = {}): Promise<{ token: string; expiresAt: number }> {
    if (!SESSION_PATTERN.test(session)) throw new TypeError('dsh-browser: signStreamToken requires a session id')
    return this.#sign({ v: 1, kind: 'browser-stream', session, exp: Date.now() + this.#ttl(options.ttlMs) })
  }

  /** Mint a capture capability for one absolute path in the cache dir. */
  async signCaptureToken(path: string, options: { ttlMs?: number } = {}): Promise<{ token: string; expiresAt: number }> {
    if (!isAbsolute(path)) throw new TypeError('dsh-browser: signCaptureToken requires an absolute path')
    return this.#sign({ v: 1, kind: 'browser-capture', path, exp: Date.now() + this.#ttl(options.ttlMs) })
  }

  /** Mint a control capability. `drive` additionally authorises input POSTs. */
  async signControlToken(session: string, scope: 'view' | 'drive', options: { ttlMs?: number } = {}): Promise<{ token: string; expiresAt: number }> {
    if (!SESSION_PATTERN.test(session)) throw new TypeError('dsh-browser: signControlToken requires a session id')
    return this.#sign({ v: 1, kind: 'browser-control', session, scope, exp: Date.now() + this.#ttl(options.ttlMs) })
  }

  verifyStreamToken(token: string): Promise<StreamTokenPayload | undefined> {
    return this.#verify(token, parseStreamPayload)
  }

  verifyCaptureToken(token: string): Promise<CaptureTokenPayload | undefined> {
    return this.#verify(token, parseCapturePayload)
  }

  verifyControlToken(token: string): Promise<ControlTokenPayload | undefined> {
    return this.#verify(token, parseControlPayload)
  }

  #ttl(ttlMs: number | undefined): number {
    if (ttlMs === undefined || !Number.isFinite(ttlMs)) return TOKEN_TTL_MS
    return Math.min(TOKEN_TTL_MS, Math.max(1, Math.floor(ttlMs)))
  }

  #key(): Promise<Buffer> {
    this.#keyPromise ??= this.resolveKey()
    return this.#keyPromise
  }

  async #sign(payload: TokenPayload): Promise<{ token: string; expiresAt: number }> {
    const key = await this.#key()
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
    return { token: `${encoded}.${mac(key, encoded).toString('base64url')}`, expiresAt: payload.exp }
  }

  async #verify<Payload>(token: string, parse: (value: unknown) => Payload | undefined): Promise<Payload | undefined> {
    if (token.length === 0 || token.length > MAX_TOKEN_LENGTH || !TOKEN_PATTERN.test(token)) return undefined
    const [encoded, signature] = token.split('.')
    if (encoded === undefined || signature === undefined) return undefined
    const key = await this.#key().catch(() => undefined)
    if (key === undefined) return undefined
    let supplied: Buffer
    try {
      supplied = Buffer.from(signature, 'base64url')
    } catch {
      return undefined
    }
    // Constant-time compare BEFORE any parsing, so payload shape never leaks
    // through timing.
    if (!safeEqual(mac(key, encoded), supplied)) return undefined
    try {
      const payload = parse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')))
      if (payload === undefined) return undefined
      const now = Date.now()
      const expiresAt = (payload as { exp?: unknown }).exp
      if (typeof expiresAt !== 'number' || expiresAt <= now) return undefined
      if (expiresAt - now > TOKEN_TTL_MS + CLOCK_SKEW_MS) return undefined
      return payload
    } catch {
      return undefined
    }
  }
}

// ── loopback / trusted-browser transport fence ──────────────────────────────

function isIpv4LoopbackAddress(address: string): boolean {
  const parts = address.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * Trust the transport peer, never forwarded or caller-controlled host data.
 * Node may expose an IPv4 peer directly or as an IPv4-mapped IPv6 address,
 * including the compact hexadecimal form used by some platforms.
 */
export function isLoopbackRemoteAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  const normalized = address.toLowerCase().split('%', 1)[0]!
  if (normalized === '::1' || isIpv4LoopbackAddress(normalized)) return true
  if (!normalized.startsWith('::ffff:')) return false
  const mapped = normalized.slice('::ffff:'.length)
  if (isIpv4LoopbackAddress(mapped)) return true
  const hexadecimal = /^([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(mapped)
  return hexadecimal !== null && (Number.parseInt(hexadecimal[1]!, 16) >>> 8) === 127
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
  return isIpv4LoopbackAddress(hostname)
}

function requestAuthority(req: IncomingMessage): URL | undefined {
  const host = req.headers.host
  if (typeof host !== 'string') return undefined
  try {
    const parsed = new URL(`http://${host}`)
    if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '' || parsed.username !== '' || parsed.password !== '') {
      return undefined
    }
    return parsed
  } catch {
    return undefined
  }
}

function isLoopbackRequest(req: IncomingMessage): boolean {
  if (!isLoopbackRemoteAddress(req.socket?.remoteAddress)) return false
  const authority = requestAuthority(req)
  return authority !== undefined && isLoopbackHostname(authority.hostname)
}

function isTrustedBrowserRequest(req: IncomingMessage, requireOrigin: boolean): boolean {
  // Fetch Metadata first: a cross-site subresource request is refused outright,
  // which is what stops a random web page from pulling the stream into an <img>.
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return !requireOrigin
  if (typeof origin !== 'string') return false
  const authority = requestAuthority(req)
  if (authority === undefined) return false
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === authority.host
  } catch {
    return false
  }
}

/** The transport fence applied to every dsh-browser route, before any capability. */
export function isTrustedRequest(req: IncomingMessage, requireOrigin: boolean): boolean {
  return isLoopbackRequest(req) && isTrustedBrowserRequest(req, requireOrigin)
}

// ── capture path containment ────────────────────────────────────────────────

export type CaptureVerdict = 'ok' | 'outside' | 'missing'

/**
 * Walk `path` from the capture cache root with `lstat` (refusing any symbolic
 * link) and finish with a `realpath` containment check.
 */
export async function classifyCapturePath(path: string): Promise<CaptureVerdict> {
  const root = captureDir()
  await mkdir(root, { recursive: true, mode: 0o700 }).catch(() => undefined)
  if (!isAbsolute(path)) return 'outside'
  const rel = relative(root, path)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return 'outside'
  let current = root
  const parts = rel.split(sep)
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]
    if (part === undefined || part.length === 0 || part === '.' || part === '..') return 'outside'
    current = join(current, part)
    let info
    try {
      info = await lstat(current)
    } catch {
      return 'missing'
    }
    if (info.isSymbolicLink()) return 'outside'
    const final = index === parts.length - 1
    if (final ? !info.isFile() : !info.isDirectory()) return 'missing'
  }
  const [realRoot, realFile] = await Promise.all([realpath(root), realpath(path)])
  const relReal = relative(realRoot, realFile)
  if (relReal === '..' || relReal.startsWith(`..${sep}`) || isAbsolute(relReal)) return 'outside'
  return 'ok'
}

/**
 * Open the verified capture with `O_NOFOLLOW`, bounded in size, and re-validate
 * containment so a file swapped for a symlink between minting and fetching is
 * never served.
 */
export async function openVerifiedCapture(path: string): Promise<{ bytes: Buffer } | undefined> {
  const verdict = await classifyCapturePath(path)
  if (verdict !== 'ok') return undefined
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
  const handle = await open(path, fsConstants.O_RDONLY | noFollow).catch(() => undefined)
  if (handle === undefined) return undefined
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size <= 0 || info.size > MAX_CAPTURE_BYTES) return undefined
    const bytes = await handle.readFile()
    // Re-check after reading: a TOCTOU swap mid-read must not be served.
    if ((await classifyCapturePath(path)) !== 'ok') return undefined
    return { bytes }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** Sequential capture path: `<captureDir>/<sessionId>/<n>.jpg`. */
export function nextCapturePath(sessionId: string, sequence: number, ext: 'jpg' | 'png' = 'jpg'): string {
  if (!SESSION_PATTERN.test(sessionId)) throw new TypeError('invalid session id for capture path')
  return join(captureDir(), sessionId, `${sequence}.${ext}`)
}
