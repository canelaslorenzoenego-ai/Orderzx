/**
 * Human-shaped input.
 *
 * Layer 3 of the detection model is behavioural: mouse-motion model, click and
 * keystroke timing, navigation patterns. No driver fixes navigation patterns —
 * that is calling code. This module fixes the other two.
 *
 * The rules, learned from what actually gets flagged:
 *
 *  - Never teleport the pointer. A `mouse.move(x, y)` to a distant coordinate
 *    with no intermediate events is the single easiest behavioural tell.
 *  - Never linear-interpolate either. Real hands overshoot and correct.
 *  - Keystrokes need per-key variance, not a fixed delay. Fixed-delay typing is
 *    trivially detectable by inter-key-interval distribution alone.
 *  - Dwell before acting. Humans look at a thing before clicking it.
 *  - Overshoot slightly, then correct. This is what separates a Bézier path
 *    from a convincing one.
 *
 * Everything here is pure and synchronous — no I/O, no driver types — so it is
 * unit-testable without a browser and reusable by every provider.
 *
 * @module @dsh-community/dsh-browser/engine/humanize
 */

export interface Point {
  x: number
  y: number
}

export interface HumanizePreset {
  /** Mouse speed multiplier. Lower = slower, more deliberate. */
  speed: number
  /** Per-character keystroke delay range, ms. */
  keyDelay: [min: number, max: number]
  /** Pause after the pointer settles, before the button goes down, ms. */
  preClickDwell: [min: number, max: number]
  /** Hold time for a click, ms. */
  clickHold: [min: number, max: number]
  /** Probability of overshooting the target and correcting. */
  overshootChance: number
  /** Scroll step range, px. */
  scrollStep: [min: number, max: number]
}

export const PRESETS: Record<'default' | 'careful' | 'fast', HumanizePreset> = {
  default: {
    speed: 1,
    keyDelay: [60, 220],
    preClickDwell: [70, 240],
    clickHold: [45, 120],
    overshootChance: 0.35,
    scrollStep: [120, 420],
  },
  careful: {
    speed: 0.55,
    keyDelay: [110, 340],
    preClickDwell: [180, 520],
    clickHold: [70, 170],
    overshootChance: 0.5,
    scrollStep: [80, 260],
  },
  fast: {
    speed: 1.8,
    keyDelay: [35, 110],
    preClickDwell: [30, 90],
    clickHold: [25, 60],
    overshootChance: 0.2,
    scrollStep: [240, 700],
  },
}

export type PresetName = keyof typeof PRESETS

// ── randomness ──────────────────────────────────────────────────────────────

/**
 * Seeded PRNG (mulberry32).
 *
 * Determinism is not for aesthetics: it makes the motion model unit-testable
 * and, more importantly, lets a session REPLAY a human-shaped path exactly when
 * the harness forks or replays a trajectory. Math.random() would make replays
 * diverge from the recorded session.
 */
export function createRandom(seed?: number): () => number {
  let state = seed === undefined ? (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0 : seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function range(random: () => number, [min, max]: [number, number]): number {
  return min + random() * (max - min)
}

// ── mouse path ──────────────────────────────────────────────────────────────

/**
 * Cubic Bézier with jitter and easing.
 *
 * Two control points are pushed off the straight line by a random perpendicular
 * offset proportional to distance, so short moves stay tight and long moves arc.
 * Easing is ease-in-out with a slight hesitation near the end — the deceleration
 * phase is where real pointer traces have the most samples.
 *
 * @returns Points from `from` to `to`, inclusive. `steps` is derived from
 * distance and `preset.speed` when not given.
 */
export function mousePath(from: Point, to: Point, preset: HumanizePreset, random: () => number, steps?: number): Point[] {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const distance = Math.hypot(dx, dy)
  if (distance < 1) return [{ x: to.x, y: to.y }]

  const count = steps ?? Math.max(8, Math.min(90, Math.round((distance / 12) * preset.speed)))
  // Perpendicular unit vector, for the arc.
  const nx = -dy / distance
  const ny = dx / distance
  const arc = distance * (0.12 + random() * 0.2) * (random() < 0.5 ? -1 : 1)

  const c1: Point = {
    x: from.x + dx * (0.2 + random() * 0.15) + nx * arc,
    y: from.y + dy * (0.2 + random() * 0.15) + ny * arc,
  }
  const c2: Point = {
    x: from.x + dx * (0.65 + random() * 0.15) + nx * arc * 0.55,
    y: from.y + dy * (0.65 + random() * 0.15) + ny * arc * 0.55,
  }

  const points: Point[] = []
  for (let i = 0; i <= count; i += 1) {
    const linear = i / count
    // Ease-in-out with a tail-heavy bias: more samples near the target.
    const t = linear < 0.5 ? 2 * linear * linear : 1 - Math.pow(-2 * linear + 2, 2) / 2
    const u = 1 - t
    const x = u * u * u * from.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * to.x
    const y = u * u * u * from.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * to.y
    // Sub-pixel jitter, scaled down near the end so the final point is exact.
    const jitter = (1 - t) * 1.6
    points.push({
      x: i === count ? to.x : x + (random() - 0.5) * jitter,
      y: i === count ? to.y : y + (random() - 0.5) * jitter,
    })
  }
  return points
}

/**
 * An overshoot-then-correct path.
 *
 * Fires with `preset.overshootChance`. The pointer lands a few px past the
 * target, pauses, then corrects. This is the single highest-value behavioural
 * detail after "don't teleport".
 */
export function humanClickPath(
  from: Point,
  to: Point,
  preset: HumanizePreset,
  random: () => number,
): { path: Point[]; overshot: boolean } {
  const base = mousePath(from, to, preset, random)
  if (random() >= preset.overshootChance) return { path: base, overshot: false }

  const distance = Math.hypot(to.x - from.x, to.y - from.y)
  if (distance < 60) return { path: base, overshot: false } // too close to bother

  const overshootBy = 4 + random() * 12
  const angle = Math.atan2(to.y - from.y, to.x - from.x)
  const past: Point = {
    x: to.x + Math.cos(angle) * overshootBy,
    y: to.y + Math.sin(angle) * overshootBy,
  }
  const correction = mousePath(past, to, preset, random, Math.max(4, Math.round(overshootBy / 2)))
  return { path: [...base.slice(0, -1), ...correction], overshot: true }
}

/** Inter-event delay for a mouse path: slower mid-flight, dense at the end. */
export function mouseStepDelayMs(preset: HumanizePreset, random: () => number, progress: number): number {
  const base = range(random, [3, 11]) / preset.speed
  // Cluster samples during deceleration.
  return progress > 0.75 ? base * 1.7 : base
}

// ── keyboard ────────────────────────────────────────────────────────────────

/**
 * Per-character delays.
 *
 * Not uniform random: real typing has structure. There is a longer pause after
 * a word boundary, a shorter one inside a word, and a much longer one after
 * punctuation or a capital (shift reach). Getting the *distribution* right
 * matters more than getting any individual delay right.
 */
export function keystrokeDelaysMs(text: string, preset: HumanizePreset, random: () => number): number[] {
  const [min, max] = preset.keyDelay
  const delays: number[] = []
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? ''
    const prev = text[i - 1] ?? ''
    let multiplier = 1
    if (prev === ' ') multiplier = 1.45 // post-space: word onset
    else if (/[.,;:!?]/.test(prev)) multiplier = 2.1 // post-punctuation
    else if (char === char.toUpperCase() && char !== char.toLowerCase()) multiplier = 1.6 // shift reach
    else if (/\d/.test(char) !== /\d/.test(prev)) multiplier = 1.35 // letter↔digit transition
    // Occasional hesitation, independent of character class.
    if (random() < 0.04) multiplier *= 2.6
    delays.push(min + random() * (max - min) * multiplier)
  }
  return delays
}

/**
 * A realistic typo rate.
 *
 * Returns indices where the caller should type a wrong character, then
 * Backspace, then the right one. ~2% of characters for `default`, higher for
 * `fast` (people who type fast mistype more).
 *
 * Opt-in: some workflows need exact text (pasting a token, filling a form field
 * the site validates character-by-character). Never apply this to passwords.
 */
export function typoPlan(text: string, preset: HumanizePreset, random: () => number, rate = 0.02): number[] {
  if (preset === PRESETS.fast) rate *= 1.6
  const indices: number[] = []
  for (let i = 1; i < text.length - 1; i += 1) {
    const char = text[i] ?? ''
    // Never typo whitespace or the first/last character of a token.
    if (/\s/.test(char)) continue
    if (random() < rate) indices.push(i)
  }
  return indices
}

/** A plausible wrong character for `char`: same hand, adjacent key. */
export function adjacentTypo(char: string, random: () => number): string {
  const rows = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890']
  for (const row of rows) {
    const index = row.indexOf(char.toLowerCase())
    if (index < 0) continue
    const neighbours = [row[index - 1], row[index + 1]].filter((n): n is string => typeof n === 'string')
    if (neighbours.length === 0) return char
    const pick = neighbours[Math.floor(random() * neighbours.length)] ?? char
    return char === char.toUpperCase() ? pick.toUpperCase() : pick
  }
  return char
}

// ── scroll ──────────────────────────────────────────────────────────────────

/**
 * A scroll gesture as a sequence of wheel steps with deceleration.
 *
 * One big `wheel(0, 1200)` is a tell. Real scrolling is 3–9 events that start
 * large and decay, sometimes with a small counter-scroll at the end.
 */
export function scrollGesture(
  totalDeltaY: number,
  preset: HumanizePreset,
  random: () => number,
): Array<{ deltaX: number; deltaY: number; delayMs: number }> {
  const direction = Math.sign(totalDeltaY) || 1
  const magnitude = Math.abs(totalDeltaY)
  const [minStep, maxStep] = preset.scrollStep
  const steps: Array<{ deltaX: number; deltaY: number; delayMs: number }> = []
  let remaining = magnitude

  while (remaining > 1 && steps.length < 24) {
    const step = Math.min(remaining, range(random, [minStep, maxStep]) * (1 - steps.length * 0.06))
    if (step <= 0.5) break
    steps.push({
      // Slight horizontal drift — trackpads and thumbs are never perfectly vertical.
      deltaX: (random() - 0.5) * step * 0.06,
      deltaY: step * direction,
      delayMs: range(random, [16, 70]),
    })
    remaining -= step
  }
  // Occasional small counter-scroll (overshoot correction).
  if (random() < 0.28 && steps.length > 2) {
    steps.push({ deltaX: 0, deltaY: -range(random, [12, 48]) * direction, delayMs: range(random, [40, 110]) })
  }
  return steps
}

// ── dwell / pacing ──────────────────────────────────────────────────────────

/** How long to "look at" an element before acting on it. */
export function preActionDwellMs(preset: HumanizePreset, random: () => number): number {
  return range(random, preset.preClickDwell)
}

/** Hold time for a click. */
export function clickHoldMs(preset: HumanizePreset, random: () => number): number {
  return range(random, preset.clickHold)
}

/**
 * Inter-navigation pacing.
 *
 * No driver does this and it is the layer-3 gap that gets whole sessions
 * flagged: an agent that navigates every 400 ms for 30 pages looks like nothing
 * human. Callers should await this between navigations.
 */
export function navigationDwellMs(preset: HumanizePreset, random: () => number): number {
  return range(random, [700, 2600]) / preset.speed
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
