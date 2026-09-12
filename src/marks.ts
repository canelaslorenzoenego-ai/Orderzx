/**
 * Set-of-marks: give the model EYES it can point at.
 *
 * `browser_observe` already returns the a11y tree; `browser_observe capture`
 * already attaches a screenshot. What was missing is the bridge between them:
 * a screenshot with the interactive elements NUMBERED ON IT, plus a table
 * mapping number → ref → box. That is the set-of-marks technique (SoM) — the
 * reason vision-first agents like Skyvern and browser-use's vision mode can
 * say "click 7" instead of guessing pixel coordinates or hoping the a11y name
 * is unique.
 *
 * Design rules, all deliberate:
 *
 *  1. The marks are drawn as a temporary DOM overlay through the ISOLATED
 *     world (`evaluateIsolated`) and removed immediately after the capture.
 *     No image-compositing dependency, no canvas, no main-world objects that
 *     survive the call — and because it is real DOM, the live screencast
 *     viewers see the same numbered frame the model sees (~300ms flash).
 *  2. Selection is a PURE function (`selectMarks`) over flat a11y elements +
 *     resolved boxes, so the whole policy is smoke-testable with no browser.
 *  3. Marks are per-session and short-lived. They never outlive the refs they
 *     alias: a mark resolves to a ref, and the ref goes through the same
 *     staleness check as always (boxOf). A mark from before a navigation dies
 *     exactly like a stale ref — loudly.
 *
 * @module @dsh-community/dsh-browser/marks
 */

/** Hard cap — beyond this the screenshot is just noise and the JSON is just tokens. */
export const MAX_MARKS = 40
/** Boxes smaller than this are decoration (icons inside links, hidden inputs). */
export const MIN_MARK_PX = 4
/** Name length in the mark table; the full name stays in the observe tree. */
export const MARK_NAME_LENGTH = 60

export interface MarkBox {
  x: number
  y: number
  width: number
  height: number
}

export interface Mark {
  /** 1-based number drawn on the screenshot. */
  mark: number
  /** The snapshot ref this mark aliases — what acting tools actually take. */
  ref: string
  role: string
  name: string
  box: MarkBox
}

/** The flat element shape `observe()` produces (ref/role/name). */
export interface MarkCandidate {
  ref: string
  role: string
  name: string
  disabled?: boolean
}

/** Roles that get a mark. Mirrors tool-support's INTERACTIVE_ROLES. */
export const MARK_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option',
  'menuitem', 'tab', 'switch', 'slider', 'spinbutton', 'searchbox', 'menuitemcheckbox',
])

/**
 * Choose which elements get marks.
 *
 * `boxes` is the ref → viewport box map (from `page.boxOf`, so it is LIVE —
 * scrolled-out and hidden elements simply have no box and drop out). Order is
 * the a11y tree's document order, which reads top-to-bottom: mark 1 is the
 * first interactive element on the page, not the biggest. Deterministic input
 * order → deterministic marks → a model can reason about "the button under 7".
 *
 * When more than MAX_MARKS qualify we keep the FIRST MAX_MARKS in document
 * order rather than scoring by area: a large hero banner link is not more
 * important than the small "Sign in" the model is looking for, and truncation
 * at the tail matches how the observe tree itself truncates.
 */
export function selectMarks(
  candidates: MarkCandidate[],
  boxes: Map<string, MarkBox | undefined>,
  viewport: { width: number; height: number },
  max = MAX_MARKS,
): Mark[] {
  const marks: Mark[] = []
  for (const candidate of candidates) {
    if (marks.length >= max) break
    if (!MARK_ROLES.has(candidate.role)) continue
    if (candidate.disabled === true) continue
    const box = boxes.get(candidate.ref)
    if (!box) continue
    if (box.width < MIN_MARK_PX || box.height < MIN_MARK_PX) continue
    // Fully off-viewport boxes would draw nothing and waste a number.
    if (box.x + box.width <= 0 || box.y + box.height <= 0) continue
    if (box.x >= viewport.width || box.y >= viewport.height) continue
    marks.push({
      mark: marks.length + 1,
      ref: candidate.ref,
      role: candidate.role,
      name: candidate.name.length > MARK_NAME_LENGTH ? `${candidate.name.slice(0, MARK_NAME_LENGTH - 1)}…` : candidate.name,
      box,
    })
  }
  return marks
}

/** Distinct hues (deg) cycled per mark so neighbours never share a colour. */
const MARK_HUES = [210, 20, 140, 280, 50, 330, 180, 95]

/**
 * Build the overlay-injection script for `evaluateIsolated`.
 *
 * One fixed-position container, `pointer-events: none`, max z-index; per mark a
 * 2px outline + a numbered label chip anchored at the box's top-left (flipped
 * inside the box when it would overflow the top). All geometry is in CSS px —
 * the same space `boxOf` and the pointer overlay use, so the drawing lines up
 * with the capture 1:1 at any devicePixelRatio.
 */
export function buildOverlayScript(marks: Mark[]): string {
  const payload = JSON.stringify(
    marks.map(m => ({ m: m.mark, x: m.box.x, y: m.box.y, w: m.box.width, h: m.box.height })),
  )
  return `(() => {
  const marks = ${payload};
  const hues = ${JSON.stringify(MARK_HUES)};
  const old = document.getElementById('dsh-browser-marks');
  if (old) old.remove();
  const layer = document.createElement('div');
  layer.id = 'dsh-browser-marks';
  layer.setAttribute('aria-hidden', 'true');
  layer.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  for (const { m, x, y, w, h } of marks) {
    const hue = hues[(m - 1) % hues.length];
    const box = document.createElement('div');
    box.style.cssText = 'position:absolute;box-sizing:border-box;border:2px solid hsl(' + hue + ',90%,55%);'
      + 'border-radius:2px;background:hsla(' + hue + ',90%,55%,0.08);'
      + 'left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px;';
    const chip = document.createElement('span');
    const flip = y < 18;
    chip.textContent = String(m);
    chip.style.cssText = 'position:absolute;left:-2px;' + (flip ? 'top:-2px;' : 'top:-16px;')
      + 'min-width:14px;height:14px;padding:0 3px;box-sizing:border-box;'
      + 'background:hsl(' + hue + ',90%,45%);color:#fff;border-radius:3px;'
      + 'font:700 10px/14px ui-monospace,monospace;text-align:center;';
    box.appendChild(chip);
    layer.appendChild(box);
  }
  document.documentElement.appendChild(layer);
  return marks.length;
})()`
}

/** Remove the overlay. Idempotent — safe even if injection never landed. */
export const CLEANUP_SCRIPT = `(() => {
  const layer = document.getElementById('dsh-browser-marks');
  if (layer) layer.remove();
  return true;
})()`

// ── per-session mark table ──────────────────────────────────────────────────

/**
 * The last `browser_see` result per session, so acting tools can accept
 * `mark: 7` as an alias for a ref.
 *
 * Deliberately module-scoped rather than host state: marks are a MODEL-facing
 * convenience with the same lifetime as snapshot refs (one observe/see cycle),
 * and keeping them here means the host controller — and every fake host in the
 * smoke suite — does not grow another field. Resolution ALWAYS goes through
 * the ref's normal staleness path afterwards, so a stale mark can never click
 * something new: worst case it fails exactly like a stale ref.
 */
const marksBySession = new Map<string, Map<number, string>>()

export function setMarks(sessionId: string, marks: Mark[]): void {
  const table = new Map<number, string>()
  for (const mark of marks) table.set(mark.mark, mark.ref)
  marksBySession.set(sessionId, table)
  // Bounded like everything else in this plugin.
  if (marksBySession.size > 32) {
    const oldest = marksBySession.keys().next().value
    if (oldest !== undefined) marksBySession.delete(oldest)
  }
}

/** Resolve a 1-based mark number to its ref, or undefined if unknown. */
export function resolveMark(sessionId: string, mark: number): string | undefined {
  return marksBySession.get(sessionId)?.get(mark)
}

/** Refs die on navigation; marks alias refs, so marks die with them. */
export function clearMarks(sessionId: string): void {
  marksBySession.delete(sessionId)
}
