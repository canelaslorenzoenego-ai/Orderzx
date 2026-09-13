/**
 * Self-contained DSH layout push used by the dsh-android device panel host.
 *
 * Mirrors dsh-openpencil's `claimEditorWorkbenchDock` shape: DSH's root is an
 * auto-width block, so a right margin shrinks its AppFrame grid instead of
 * covering the conversation. Ownership is recorded through a dedicated data
 * attribute and the exact inline-style values are restored on release, which
 * keeps this compatible with HMR and fail-closed around another plugin that
 * already owns the root margin (including openpencil's own workbench dock).
 *
 * EXTEND-ONLY CONTRACT (rc.7): the panel must NEVER cover the conversation.
 * Three layers make the push survive hostile harness layouts:
 *
 *  1. **Inline lease** — the classic margin-right write, restored on release.
 *  2. **Forced sheet** — a `<style>` rule keyed on OUR ownership attribute
 *     re-declares `margin-right`/`max-width`/`width` with `!important`, so a
 *     shell that sizes itself with `width: 100vw` or inline fixed widths
 *     still shrinks. Inline styles lose to `!important` sheet rules.
 *  3. **Watchdog** — a MutationObserver on the root's style/class/attribute
 *     plus a 400 ms belt-and-braces interval re-assert both layers whenever
 *     the harness's React re-render wipes them. A wiped lease used to decay
 *     into "the panel floats over the chat"; now it heals in under a frame.
 *
 * `claimAndroidPanelDock` therefore only returns undefined when there is no
 * pushable element at all; callers render the docked split in every other
 * case (the modal overlay fallback is gone).
 */

export const ANDROID_PANEL_DOCK_ATTRIBUTE = 'dshAndroidPanelDockOwner'

export interface AndroidPanelDockLease {
  update: (width: number) => void
  release: () => void
  /**
   * Horizontal px another plugin's sidebar already occupies at the right
   * edge (its pre-existing root margin). The panel surface positions at
   * `right: offset` so both columns coexist instead of fighting (#2).
   */
  readonly offset: number
}

function dockWidth(width: number): string {
  return `${Math.max(0, Math.round(width))}px`
}

/**
 * How much of the viewport a foreign sidebar may occupy before the panel
 * tightens to its narrow split instead of stacking at full width. Coexistence
 * never fails the claim any more — a refused claim used to mean modal
 * overlay, which is exactly what the extend-only contract forbids.
 */
export const ANDROID_DOCK_MAX_FOREIGN_FRACTION = 0.6

/** Watchdog tick: how often we re-assert a lease the harness may have wiped. */
const WATCHDOG_INTERVAL_MS = 400

/** Root candidates, most specific first; the harness renames things. */
const ROOT_SELECTORS = ['#root', '[data-dsh-app-frame]', '[data-app-frame]', '#dsh-app', 'main'] as const

/**
 * Best-effort layout root: the element a margin push actually shrinks — the
 * DEEPEST viewport-covering painter (a `position: fixed; inset: 0` or
 * `width: 100vw` shell ignores margins written to an ancestor block).
 */
export function findAndroidDockRoot(doc: Document): HTMLElement | null {
  const win = doc.defaultView
  const vw = win?.innerWidth ?? 0
  const vh = win?.innerHeight ?? 0
  const roots: HTMLElement[] = []
  for (const selector of ROOT_SELECTORS) {
    const found = doc.querySelector<HTMLElement>(selector)
    if (found) roots.push(found)
  }
  if (roots.length === 0) {
    const first = doc.body?.firstElementChild
    if (first instanceof HTMLElement) roots.push(first)
  }
  const descend = (root: HTMLElement): HTMLElement => {
    let best = root
    let node: HTMLElement | null = root
    for (let depth = 0; node !== null && depth < 3; depth += 1) {
      const kids = Array.from(node.children) as HTMLElement[]
      const cover = kids.find(kid => {
        const rect = kid.getBoundingClientRect()
        return rect.width >= vw * 0.95 && rect.height >= vh * 0.95
      })
      if (cover === undefined) break
      best = cover
      node = cover
    }
    return best
  }
  for (const root of roots) {
    const deep = descend(root)
    if (deep !== root) return deep
  }
  const first = roots[0]
  return first === undefined ? null : descend(first)
}

/**
 * Reserve real layout space for the fixed right-hand device panel.
 *
 * A pre-existing root margin is COEXISTED with: the lease treats it as a
 * fixed right-edge offset, reserves `offset + width` through the root margin,
 * and the surface docks at `right: offset` — the device panel sits immediately
 * left of the other sidebar. A foreign sidebar that occupies most of the
 * viewport tightens the panel to its narrow split rather than refusing the
 * claim (a refusal used to mean modal overlay).
 *
 * @param root - the app root element (`#root`) the panel pushes over.
 * @param owner - stable lease owner id; a different owner of OUR attribute
 *   makes the claim fail (the surface docks without a push as last resort).
 * @param initialWidth - panel width in px reserved through the root margin.
 * @param computedMarginRight - current computed margin-right (0 = unclaimed).
 * @param viewportWidth - used to tighten (never refuse) around foreign
 *   sidebars that already occupy most of the screen.
 * @returns the lease, or undefined only when `root` is missing entirely.
 */
export function claimAndroidPanelDock(
  root: HTMLElement,
  owner: string,
  initialWidth: number,
  computedMarginRight = 0,
  viewportWidth = Number.POSITIVE_INFINITY,
): AndroidPanelDockLease | undefined {
  const existingOwner = root.dataset[ANDROID_PANEL_DOCK_ATTRIBUTE]
  if (existingOwner !== undefined && existingOwner !== owner) return undefined
  const foreign = existingOwner === undefined && Number.isFinite(computedMarginRight) && computedMarginRight > 0.5
    ? Math.round(computedMarginRight)
    : 0
  const tight = foreign > viewportWidth * ANDROID_DOCK_MAX_FOREIGN_FRACTION

  const previousMarginRight = root.style.marginRight
  const previousMinWidth = root.style.minWidth
  root.dataset[ANDROID_PANEL_DOCK_ATTRIBUTE] = owner
  root.style.minWidth = '0'

  // Forced sheet: keyed on the ownership attribute so it dies with the lease
  // and never leaks onto an unrelated root. `!important` beats the harness's
  // own inline/100vw sizing, which is the case that used to look like an
  // overlay even while the lease thought it owned the margin.
  const sheetId = `dsh-android-dock-push-${owner.replace(/[^a-zA-Z0-9_-]/g, '')}`
  const doc = root.ownerDocument
  let sheet = doc.getElementById(sheetId) as HTMLStyleElement | null
  if (sheet === null) {
    sheet = doc.createElement('style')
    sheet.id = sheetId
    sheet.setAttribute('data-android-dock-push', 'true')
    doc.head.appendChild(sheet)
  }
  const writeSheet = (px: number): void => {
    if (sheet === null) return
    sheet.textContent =
      `[${ANDROID_PANEL_DOCK_ATTRIBUTE}="${cssEscape(owner)}"]{` +
      `margin-right:${dockWidth(foreign + px)} !important;` +
      `max-width:calc(100% - ${dockWidth(foreign + px)}) !important;` +
      `width:auto !important;}`
  }

  let released = false
  let expected = dockWidth(foreign + Math.max(0, Math.round(initialWidth)))
  const apply = (width: number): void => {
    expected = dockWidth(foreign + Math.max(0, Math.round(width)))
    if (root.dataset[ANDROID_PANEL_DOCK_ATTRIBUTE] !== owner) root.dataset[ANDROID_PANEL_DOCK_ATTRIBUTE] = owner
    root.style.marginRight = expected
    writeSheet(tight ? Math.min(width, Math.round(viewportWidth * 0.4)) : width)
  }
  apply(initialWidth)

  // Watchdog: harness re-renders wipe inline styles and even attributes.
  const heal = (): void => {
    if (released) return
    if (root.dataset[ANDROID_PANEL_DOCK_ATTRIBUTE] !== owner) root.dataset[ANDROID_PANEL_DOCK_ATTRIBUTE] = owner
    if (root.style.marginRight !== expected) root.style.marginRight = expected
    // A DETACHED sheet (wiper removed it) changes nothing however perfect its
    // text is: re-attach, then refill if it was also emptied.
    if (sheet !== null && !sheet.isConnected) doc.head.appendChild(sheet)
    if (sheet === null || sheet.textContent === '') writeSheet(Math.max(0, Math.round(initialWidth)))
  }
  const observer = typeof MutationObserver === 'undefined'
    ? null
    : new MutationObserver(heal)
  observer?.observe(root, { attributes: true, attributeFilter: ['style', 'class', ANDROID_PANEL_DOCK_ATTRIBUTE] })
  const timer = setInterval(() => { heal() }, WATCHDOG_INTERVAL_MS)

  const release = (): void => {
    if (released) return
    released = true
    observer?.disconnect()
    clearInterval(timer)
    sheet?.remove()
    if (root.dataset[ANDROID_PANEL_DOCK_ATTRIBUTE] !== owner) return
    root.style.marginRight = previousMarginRight
    root.style.minWidth = previousMinWidth
    delete root.dataset[ANDROID_PANEL_DOCK_ATTRIBUTE]
  }

  return {
    update: (width: number): void => {
      if (released) return
      apply(width)
    },
    release,
    offset: foreign,
  }
}

/** Minimal CSS attribute-value escape (owners are useId() strings). */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&')
}
