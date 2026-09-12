/**
 * act → deterministic cache (Ui.Vision's other half).
 *
 * When `browser_act` resolves an instruction confidently, the RESOLUTION
 * (role + accessible name of what was acted on) is cached under
 * (page pattern, normalized instruction). A repeat call verifies the identity
 * against the LIVE tree first: exactly one match → the cached resolution
 * replays deterministically and the result says `cache: 'hit'`. Zero or
 * several matches → normal scoring runs and the entry is refreshed on
 * success. The cache can never act on a stale element, because a hit
 * requires re-finding the element by identity in the current snapshot.
 *
 * Pure functions + types only; tools.ts owns the disk.
 *
 * @module @dsh-community/dsh-browser/act-cache
 */

export interface ActCacheEntry {
  role: string
  name: string
  verb: string
  savedAt: number
  hits: number
}

/** Entries beyond this age are pruned on load — pages drift, caches rot. */
export const ACT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** Hard cap: this is a compounding aid, not a transcript. */
export const ACT_CACHE_MAX = 200

/** Lowercase, whitespace-collapsed — "Click  'Sign in' " and "click 'sign in'" differ, but spacing noise should not matter. */
export function normalizeInstruction(instruction: string): string {
  return instruction.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200)
}

/**
 * Cache key: host + pathname + normalized instruction.
 *
 * The query string is deliberately EXCLUDED — list pages paginate through
 * query params while keeping the same controls — and the ref is never part
 * of the key, because refs die on every re-render.
 */
export function actCacheKey(url: string, instruction: string): string {
  let pattern = url
  try {
    const parsed = new URL(url)
    pattern = `${parsed.host}${parsed.pathname}`
  } catch {
    // not a URL (about:blank etc.) — the raw string is a fine pattern
  }
  return `${pattern} :: ${normalizeInstruction(instruction)}`
}

/** Drop expired entries and enforce the cap, newest-first. Pure. */
export function pruneActCache(entries: Record<string, ActCacheEntry>, now = Date.now()): Record<string, ActCacheEntry> {
  const kept = Object.entries(entries)
    .filter(([, entry]) => entry && typeof entry.savedAt === 'number' && now - entry.savedAt < ACT_CACHE_TTL_MS && typeof entry.role === 'string' && typeof entry.name === 'string')
    .sort((a, b) => b[1].savedAt - a[1].savedAt)
    .slice(0, ACT_CACHE_MAX)
  return Object.fromEntries(kept)
}

/** Parse disk JSON defensively — a corrupt cache file is an empty cache, never a crash. */
export function parseActCache(raw: string): Record<string, ActCacheEntry> {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return pruneActCache(parsed as Record<string, ActCacheEntry>)
  } catch {
    return {}
  }
}
