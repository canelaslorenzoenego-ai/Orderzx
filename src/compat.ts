/**
 * The compatibility contract between this plugin and ANY dsh-web / Cordis
 * generation — past, present, or future.
 *
 * The rules, in the order a harness update would hit them:
 *
 *  1. **Structural, not nominal.** The entry type-checks against both `cordis`
 *     and `@deepseek-ai/cordis` shapes; optional services (approval, vision)
 *     are reached through `ctx.inject([...])` fibers, so a harness that never
 *     ships them simply never lights that fiber.
 *  2. **Additive-only wire changes.** New status/tool/manifest fields appear;
 *     old ones never disappear and never change type. Readers therefore
 *     ignore unknown fields by construction, and a NEW plugin still parses an
 *     OLD payload.
 *  3. **Versioned, observable protocol.** `status.compat` carries the protocol
 *     number and plugin version. A client facing a NEWER protocol degrades to
 *     a visible banner instead of a blank panel; a client facing an OLDER one
 *     keeps working because of rule 2.
 *  4. **No harness internals.** Everything crosses `mountRoutes`, `ctx.effect`
 *     tool registration and the signed-route fence — the three surfaces the
 *     harness has never had to change.
 *
 * @module @dsh-community/dsh-browser/compat
 */

/** Bump ONLY for a wire change an older client cannot ignore. Additive changes are NOT bumps. */
export const PROTOCOL_VERSION = 1

/** What a client or operator can ask this build about its promises. */
export interface CompatReport {
  protocol: number
  plugin: string
  guarantees: string[]
}

export const COMPAT_GUARANTEES = [
  'additive-only wire changes: old payloads always parse',
  'unknown fields ignored by every reader',
  'optional harness services feature-detected, never required',
  'newer harness protocol degrades to a banner, never a blank panel',
] as const

export function compatReport(pluginVersion: string): CompatReport {
  return { protocol: PROTOCOL_VERSION, plugin: pluginVersion, guarantees: [...COMPAT_GUARANTEES] }
}

/**
 * How should a client built for PROTOCOL_VERSION behave against `remote`?
 * `ok` = same generation; `compat` = newer harness, older client: keep going,
 * say so; `unknown` = no compat block at all: assume protocol 1 (rule 2).
 */
export function compatMode(remote: { protocol?: unknown } | undefined | null): 'ok' | 'compat' | 'unknown' {
  const version = typeof remote?.protocol === 'number' ? remote.protocol : undefined
  if (version === undefined) return 'unknown'
  if (version === PROTOCOL_VERSION) return 'ok'
  return version > PROTOCOL_VERSION ? 'compat' : 'ok' // older harness: additive rules cover us
}
