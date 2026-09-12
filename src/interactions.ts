/**
 * The interaction trace: a bounded ring of gestures per session.
 *
 * The frame stream shows what the PAGE looks like. That is not the same as
 * showing what the AGENT did — a click lands between two frames, a 40-pixel
 * scroll is invisible, and a humanized Bézier move reads as "nothing happened,
 * then the cursor teleported". So every gesture is recorded separately and the
 * panel animates it over the frames: the pointer travels the real path, the
 * click pulses at the real coordinate, the scroll arrow carries the real delta.
 *
 * Bounded on purpose. This is a live trace, not a session recording — a
 * long-running browser would otherwise accumulate unbounded memory, and the
 * panel only ever needs the last few seconds to animate.
 *
 * @module @dsh-community/dsh-browser/interactions
 */

/** Who produced the gesture. The panel draws the agent's pointer, not the user's. */
export type InteractionActor = 'agent' | 'user'

/**
 * One gesture, in NORMALIZED 0..1 coordinates.
 *
 * Normalized for the same reason the control messages are: the panel can be any
 * width and the browser viewport can change underneath it. The panel multiplies
 * by the rendered frame size at paint time.
 */
export type InteractionEvent =
  | {
      type: 'move'
      /** Full path so the panel can animate the curve, not just the endpoint. */
      points: Array<{ x: number; y: number }>
    }
  | { type: 'down'; x: number; y: number; button: 'left' | 'right' | 'middle' }
  | { type: 'up'; x: number; y: number; button: 'left' | 'right' | 'middle' }
  | { type: 'click'; x: number; y: number; button: 'left' | 'right' | 'middle'; ref?: string; label?: string }
  | {
      type: 'drag'
      from: { x: number; y: number }
      to: { x: number; y: number }
      points?: Array<{ x: number; y: number }>
    }
  /** A touch-shaped drag: the panel draws a fingertip trail instead of a cursor. */
  | { type: 'swipe'; from: { x: number; y: number }; to: { x: number; y: number }; points?: Array<{ x: number; y: number }> }
  | { type: 'scroll'; deltaX: number; deltaY: number }
  /**
   * Typing. The TEXT IS NEVER RECORDED — only its length.
   *
   * The trace is served to a browser panel over loopback and lands in the
   * session log projection; a password typed into a field must not be copied
   * into either. `secret` lets the panel dim the indicator rather than show a
   * cheerful "typed 14 characters" next to a password field.
   */
  | { type: 'type'; characters: number; secret: boolean; ref?: string; label?: string }
  | { type: 'key'; key: string }
  | { type: 'navigate'; url: string; action?: 'goto' | 'back' | 'forward' | 'reload' | 'stop' }
  | { type: 'tab'; action: 'new' | 'select' | 'close'; index?: number }
  /** The element the agent is looking at — the panel outlines it for a moment. */
  | { type: 'focus'; ref: string; label?: string; box?: { x: number; y: number; width: number; height: number } }
  | { type: 'challenge'; vendor: string; state: 'awaiting-user' | 'solving' | 'resolved' }
  | { type: 'phase'; detail?: string }
  | { type: 'note'; text: string }

export interface InteractionRecord {
  /** Monotonic within a session; the panel de-dupes and orders by this. */
  seq: number
  at: number
  actor: InteractionActor
  event: InteractionEvent
}

export interface InteractionTraceOptions {
  /** How many records to keep. Default 240. */
  capacity?: number
}

const DEFAULT_CAPACITY = 240
/**
 * Hard cap on path points per gesture.
 *
 * A humanized drag samples at frame rate; an unbounded path would let one
 * gesture dominate the ring and the JSON that carries it.
 */
const MAX_PATH_POINTS = 96

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function clampPoint(point: { x: number; y: number }): { x: number; y: number } {
  return { x: clampUnit(point.x), y: clampUnit(point.y) }
}

/**
 * Normalize one event's coordinates into 0..1 and strip anything unbounded.
 *
 * Every producer already works in normalized space or in a known viewport, but
 * this is the single place the invariant is enforced — a tool that computes
 * pixels and forgets to divide would otherwise paint a cursor 1366× off-screen
 * instead of failing visibly.
 */
export function normalizeEvent(event: InteractionEvent, viewport?: { width: number; height: number }): InteractionEvent {
  const toUnit = (x: number, y: number): { x: number; y: number } => {
    // Pixels are only accepted when a viewport is supplied; otherwise a value
    // above 1 would clamp to the bottom-right corner and mislead the user.
    if (viewport && viewport.width > 0 && viewport.height > 0 && (Math.abs(x) > 1 || Math.abs(y) > 1)) {
      return { x: clampUnit(x / viewport.width), y: clampUnit(y / viewport.height) }
    }
    return { x: clampUnit(x), y: clampUnit(y) }
  }
  const path = (points: Array<{ x: number; y: number }> | undefined): Array<{ x: number; y: number }> | undefined => {
    if (!points || points.length === 0) return undefined
    const sampled = points.length > MAX_PATH_POINTS
      ? points.filter((_, index) => index % Math.ceil(points.length / MAX_PATH_POINTS) === 0 || index === points.length - 1)
      : points
    return sampled.map(point => toUnit(point.x, point.y))
  }

  switch (event.type) {
    case 'move':
      return { type: 'move', points: path(event.points) ?? [] }
    case 'down':
    case 'up': {
      const point = toUnit(event.x, event.y)
      return { ...event, ...point }
    }
    case 'click': {
      const point = toUnit(event.x, event.y)
      return {
        ...event,
        ...point,
        ...(event.ref === undefined ? {} : { ref: event.ref }),
        ...(event.label === undefined ? {} : { label: event.label.slice(0, 80) }),
      }
    }
    case 'drag':
    case 'swipe': {
      const from = toUnit(event.from.x, event.from.y)
      const to = toUnit(event.to.x, event.to.y)
      const points = path(event.points)
      return { type: event.type, from, to, ...(points ? { points } : {}) }
    }
    case 'scroll': {
      // Deltas stay in pixels (they are a magnitude, not a position) but are
      // bounded so one pathological wheel event cannot pin the arrow off-frame.
      const bound = (value: number): number => Math.max(-20_000, Math.min(20_000, Number.isFinite(value) ? value : 0))
      return { type: 'scroll', deltaX: bound(event.deltaX), deltaY: bound(event.deltaY) }
    }
    case 'type':
      return {
        type: 'type',
        characters: Math.max(0, Math.min(100_000, Math.trunc(Number.isFinite(event.characters) ? event.characters : 0))),
        secret: event.secret,
        ...(event.ref === undefined ? {} : { ref: event.ref }),
        ...(event.label === undefined ? {} : { label: event.label.slice(0, 80) }),
      }
    case 'key':
      return { type: 'key', key: event.key.slice(0, 32) }
    case 'navigate':
      return { type: 'navigate', url: event.url.slice(0, 2048), ...(event.action ? { action: event.action } : {}) }
    case 'tab':
      return { type: 'tab', action: event.action, ...(event.index === undefined ? {} : { index: event.index }) }
    case 'focus': {
      const box = event.box && viewport && viewport.width > 0
        ? {
            x: clampUnit(event.box.x / viewport.width),
            y: clampUnit(event.box.y / viewport.height),
            width: clampUnit(event.box.width / viewport.width),
            height: clampUnit(event.box.height / viewport.height),
          }
        : undefined
      return {
        type: 'focus',
        ref: event.ref,
        ...(event.label === undefined ? {} : { label: event.label.slice(0, 80) }),
        ...(box ? { box } : {}),
      }
    }
    case 'challenge':
      return event
    case 'phase':
      return { type: 'phase', ...(event.detail === undefined ? {} : { detail: event.detail.slice(0, 200) }) }
    case 'note':
      return { type: 'note', text: event.text.slice(0, 200) }
    default:
      return event
  }
}

/**
 * Per-session gesture trace.
 *
 * Push-based: the frame loop and the tools publish, the panel's interaction
 * channel fans out to every connected client. Subscribers that throw are
 * dropped, exactly like the frame subscribers — one broken connection must not
 * blind the others.
 */
export class InteractionTrace {
  #records: InteractionRecord[] = []
  #seq = 0
  #capacity: number
  #subscribers = new Set<(record: InteractionRecord) => void>()

  constructor(options: InteractionTraceOptions = {}) {
    this.#capacity = Math.max(8, options.capacity ?? DEFAULT_CAPACITY)
  }

  /** Record a gesture and fan it out. Returns the assigned sequence number. */
  publish(actor: InteractionActor, event: InteractionEvent, viewport?: { width: number; height: number }): number {
    this.#seq += 1
    const record: InteractionRecord = { seq: this.#seq, at: Date.now(), actor, event: normalizeEvent(event, viewport) }
    this.#records.push(record)
    if (this.#records.length > this.#capacity) this.#records.splice(0, this.#records.length - this.#capacity)
    for (const subscriber of [...this.#subscribers]) {
      try {
        subscriber(record)
      } catch {
        this.#subscribers.delete(subscriber)
      }
    }
    return record.seq
  }

  subscribe(listener: (record: InteractionRecord) => void): () => void {
    this.#subscribers.add(listener)
    return () => {
      this.#subscribers.delete(listener)
    }
  }

  /**
   * Records at or after `sinceSeq` (exclusive of it), oldest first.
   *
   * A client that reconnects asks for what it missed instead of re-animating
   * the whole trace. If the gap is older than the ring, `resync` tells it to
   * drop its local state rather than play a stale gesture over a fresh frame.
   */
  since(seq: number): { records: InteractionRecord[]; resync: boolean; latest: number } {
    const latest = this.#seq
    const oldest = this.#records[0]?.seq ?? 0
    if (seq > latest) return { records: [], resync: false, latest }
    if (seq < oldest - 1) return { records: [...this.#records], resync: true, latest }
    return { records: this.#records.filter(record => record.seq > seq), resync: false, latest }
  }

  /** Most recent record, or undefined before the first gesture. */
  latest(): InteractionRecord | undefined {
    return this.#records[this.#records.length - 1]
  }

  get size(): number {
    return this.#records.length
  }

  clear(): void {
    this.#records = []
  }
}
