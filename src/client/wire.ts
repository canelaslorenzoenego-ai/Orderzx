/**
 * Client-side wire helpers.
 *
 * Everything the browser client needs to talk to the host routes: grant →
 * stream, status polling, control POSTs, session POSTs. Kept dependency-free
 * (a `fetch` implementation is injected) so the static smoke suite can drive it
 * with a fake fetcher and no harness.
 *
 * Two rules this file exists to enforce:
 *
 *  1. **Relative URLs only.** The client runs in the user's browser, which is
 *     not the sandbox/host machine. Every path is relative to the DSH origin.
 *  2. **Tokens are short-lived and re-minted.** A capability expires in 10
 *     minutes; the stream session refreshes before that rather than holding a
 *     token for the life of a panel.
 *
 * @module @dsh-community/dsh-browser/client/wire
 */

import {
  CHALLENGE_ROUTE_PATH,
  CONTROL_ROUTE_PATH,
  GRANT_ROUTE_PATH,
  SESSION_ROUTE_PATH,
  STATUS_ROUTE_PATH,
  INTERACTIONS_ROUTE_PREFIX,
  STREAM_ROUTE_PREFIX,
  CAPTURE_ROUTE_PREFIX,
} from '../protocol.js'
import type { BrowserStatus, ControlMessage, InteractionRecord, SessionMessage } from '../protocol.js'

export type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

/** Result of a `/grant` call. */
export interface GrantResult {
  /**
   * `bootstrap` comes back when NO browser exists yet: a drive-scoped control
   * token whose only accepted message is `start-browser` (the home tab's
   * launch button). There is no stream token — there is nothing to stream.
   */
  kind: 'session' | 'capture' | 'bootstrap'
  session?: string
  scope?: 'view' | 'drive'
  stream?: { token: string; expiresAt: number }
  control?: { token: string; expiresAt: number }
  token?: string
  expiresAt?: number
}

export class WireError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'WireError'
  }
}

/**
 * Request capabilities for a session.
 *
 * `scope: 'drive'` is only honoured by the host while a takeover is active; a
 * caller asking for drive without one silently receives `view`. The client must
 * therefore read `result.scope` rather than assume it got what it asked for.
 */
export async function requestGrant(
  fetcher: FetchLike,
  input: { session?: string; scope?: 'view' | 'drive' } = {},
): Promise<GrantResult> {
  const response = await fetcher(GRANT_ROUTE_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    // Same-origin only; the host fence rejects cross-site anyway.
    credentials: 'same-origin',
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new WireError(body.error ?? `grant failed (${response.status})`, response.status)
  }
  return (await response.json()) as GrantResult
}

/** Build the signed stream URL for an `<img src>`. */
export function streamUrl(token: string): string {
  return `${STREAM_ROUTE_PREFIX}?token=${encodeURIComponent(token)}`
}

/** Build the signed capture URL for an `<img src>`. */
export function captureUrl(token: string): string {
  return `${CAPTURE_ROUTE_PREFIX}?token=${encodeURIComponent(token)}`
}

/** Poll `/status`. Returns undefined (not a throw) when the token has expired. */
export async function requestStatus(fetcher: FetchLike, token: string): Promise<BrowserStatus | undefined> {
  try {
    const response = await fetcher(`${STATUS_ROUTE_PATH}?token=${encodeURIComponent(token)}`)
    if (!response.ok) return undefined
    return (await response.json()) as BrowserStatus
  } catch {
    return undefined
  }
}

/** Send human input to the browser. Requires a `drive`-scoped token. */
export async function sendControl(fetcher: FetchLike, token: string, message: ControlMessage): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetcher(`${CONTROL_ROUTE_PATH}?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
      credentials: 'same-origin',
    })
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string }
      return { ok: false, error: body.error ?? `control failed (${response.status})` }
    }
    return (await response.json()) as { ok: boolean }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Take over, resume, abort, switch frame tier, switch/start sessions.
 *
 * `body` carries the parsed response — `start-browser` answers with the new
 * session id, which the home tab needs to jump straight into the stream.
 */
export async function sendSession(
  fetcher: FetchLike,
  token: string,
  message: SessionMessage,
): Promise<{ ok: boolean; error?: string; body?: Record<string, unknown> }> {
  try {
    const response = await fetcher(`${SESSION_ROUTE_PATH}?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
      credentials: 'same-origin',
    })
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
    if (!response.ok) {
      return { ok: false, error: typeof body.error === 'string' ? body.error : `session request failed (${response.status})`, body }
    }
    return { ok: body.ok !== false, body }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Report that the human resolved (or gave up on) a challenge. */
export async function sendChallengeOutcome(
  fetcher: FetchLike,
  token: string,
  challengeId: string,
  outcome: 'passed' | 'failed' | 'abandoned',
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetcher(`${CHALLENGE_ROUTE_PATH}?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'handoff-resolved', challengeId, outcome }),
      credentials: 'same-origin',
    })
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string }
      return { ok: false, error: body.error ?? `challenge report failed (${response.status})` }
    }
    return (await response.json()) as { ok: boolean }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Refresh a capability ~1 minute before it expires. */
export const TOKEN_REFRESH_MARGIN_MS = 60_000

export function shouldRefresh(expiresAt: number, now = Date.now()): boolean {
  return expiresAt - now <= TOKEN_REFRESH_MARGIN_MS
}

/** Mint a capability for one already-written capture path. */
export async function requestCaptureGrant(fetcher: FetchLike, path: string): Promise<{ token: string; expiresAt: number } | undefined> {
  try {
    const response = await fetcher(GRANT_ROUTE_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
      credentials: 'same-origin',
    })
    if (!response.ok) return undefined
    const body = (await response.json()) as GrantResult
    if (body.kind !== 'capture' || !body.token) return undefined
    return { token: body.token, expiresAt: body.expiresAt ?? Date.now() }
  } catch {
    return undefined
  }
}

// ── interaction trace (SSE) ─────────────────────────────────────────────────

/** Build the signed interactions URL. */
export function interactionsUrl(token: string, since = 0): string {
  return `${INTERACTIONS_ROUTE_PREFIX}?token=${encodeURIComponent(token)}&since=${encodeURIComponent(String(since))}`
}

export interface InteractionSubscription {
  /** Stop reading and close the connection. Safe to call twice. */
  stop(): void
}

/**
 * Subscribe to the gesture trace over Server-Sent Events.
 *
 * Uses the page's native `fetch` and reads the body stream directly — the
 * harness may not expose `EventSource`, and a fetch reader lets us send the
 * same credentials mode as every other route. Reconnects with the last seen
 * sequence number (capped backoff) until `signal` aborts, so a hiccup in the
 * loopback server loses at most the gestures that were already off the ring.
 */
export function subscribeInteractions(options: {
  token: string
  since?: number
  onEvent: (record: InteractionRecord) => void
  onResync?: (latest: number) => void
  signal?: AbortSignal
}): InteractionSubscription {
  const { token, onEvent, onResync, signal } = options
  let since = options.since ?? 0
  let stopped = false
  let attempt = 0

  const pump = async (): Promise<void> => {
    while (!stopped && !signal?.aborted) {
      try {
        const response = await fetch(interactionsUrl(token, since), {
          credentials: 'same-origin',
          ...(signal ? { signal } : {}),
        })
        if (!response.ok || !response.body) {
          // 403/404: the token died or the session closed. Stop rather than
          // spin — the panel re-grants and re-subscribes as part of its normal
          // status polling.
          return
        }
        attempt = 0
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          buffer += decoder.decode(chunk.value, { stream: true })
          let boundary = buffer.indexOf('\n\n')
          while (boundary !== -1) {
            const raw = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            const parsed = parseSseFrame(raw)
            if (parsed) {
              if (parsed.event === 'resync') {
                const latest = (parsed.data as { latest?: number }).latest ?? 0
                since = latest
                onResync?.(latest)
              } else if (parsed.event === 'interaction') {
                const record = parsed.data as InteractionRecord
                if (typeof record.seq === 'number' && record.seq > since) since = record.seq
                onEvent(record)
              }
            }
            boundary = buffer.indexOf('\n\n')
          }
        }
      } catch {
        if (stopped || signal?.aborted) return
      }
      if (stopped || signal?.aborted) return
      // EOF or error: reconnect with capped exponential backoff.
      attempt += 1
      await new Promise(resolve => setTimeout(resolve, Math.min(10_000, 500 * 2 ** Math.min(attempt, 5))))
    }
  }

  void pump()
  return {
    stop() {
      stopped = true
    },
  }
}

/** Parse one SSE frame (`event:` / `data:` / `id:` lines). Comments ignored. */
export function parseSseFrame(raw: string): { event: string; data: unknown; id?: number } | undefined {
  let event = 'message'
  let id: number | undefined
  const dataLines: string[] = []
  for (const line of raw.split('\n')) {
    if (line.startsWith(':') || line.length === 0) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') dataLines.push(value)
    else if (field === 'id') {
      const parsed = Number.parseInt(value, 10)
      if (Number.isFinite(parsed)) id = parsed
    }
  }
  if (dataLines.length === 0) return undefined
  try {
    return { event, data: JSON.parse(dataLines.join('\n')), ...(id === undefined ? {} : { id }) }
  } catch {
    return undefined
  }
}
