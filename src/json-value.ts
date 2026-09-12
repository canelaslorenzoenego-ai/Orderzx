/**
 * The lossless-JSON type every tool result must satisfy.
 *
 * The registry snapshots `execute`'s return value as lossless JSON in one
 * recursive pass, validates it against `output.schema`, freezes it, and hands it
 * to `output.render`. Returning anything outside this type — a Date, a Map, a
 * class instance, `undefined` inside an array — is an `isError`, and the failure
 * surfaces as a schema/renderer error rather than as something the model can act
 * on. So the type is narrow on purpose.
 *
 * @module @dsh-community/dsh-browser/json-value
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** Runtime guard, for values crossing a boundary we do not control. */
export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return true
    case 'number':
      return Number.isFinite(value)
    case 'object':
      if (Array.isArray(value)) return value.every(isJsonValue)
      return Object.values(value as Record<string, unknown>).every(isJsonValue)
    default:
      return false
  }
}

/**
 * Coerce an unknown value into lossless JSON, dropping what cannot survive.
 *
 * Use at the edges — a page `evaluate` result, a driver's own object — never as
 * a substitute for building the canonical value correctly in the first place.
 */
export function toJsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > 12) return null
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return Number(value)
  if (Array.isArray(value)) return value.map(item => toJsonValue(item, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = toJsonValue(item, depth + 1)
    }
    return out
  }
  return String(value)
}
