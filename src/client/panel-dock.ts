/**
 * The dock lease: how the dashboard actually "extends".
 *
 * DSH has no panel seat to register into, so the plugin mounts its own fixed
 * right-hand column on `document.body`. A fixed column would COVER the
 * conversation, which is unusable — so we take a lease on the DSH root's
 * `margin-right` and push the AppFrame over by exactly the panel width. The
 * dashboard genuinely gets narrower; nothing is occluded.
 *
 * The lease is the important part. Three things make it a lease rather than an
 * assignment:
 *
 *  1. **We restore what we found, not what we assume.** The prior inline
 *     `margin-right` is captured and put back on release. Writing `''` would
 *     clobber a margin another plugin (or the host theme) set.
 *  2. **Only one plugin can hold it.** If the value we find is not what we last
 *     wrote, someone else took over and we back off to an overlay rather than
 *     fighting them for the same property. Two plugins animating one margin
 *     produces a strobing layout.
 *  3. **It degrades.** Narrow viewport, missing root, or a lost lease → the
 *     panel becomes a centered overlay. Still usable, just covering content.
 *
 * @module @dsh-community/dsh-browser/client/panel-dock
 */

import type { CSSProperties } from 'react'

/** Attribute marking the DSH root element we push over. */
export const PANEL_DOCK_ATTRIBUTE = 'data-dsh-browser-panel-dock'

/**
 * Below this viewport width there is no room for a side-by-side layout, so the
 * panel goes full-bleed as an overlay instead of stealing margin.
 */
export const DOCK_MIN_VIEWPORT_WIDTH = 900

/** Never push the app frame over by more than this fraction of the viewport. */
export const DOCK_MAX_FOREIGN_FRACTION = 0.62

/** Candidate selectors for the DSH root, in order of specificity. */
const ROOT_SELECTORS = [
  '[data-dsh-app-frame]',
  '[data-app-frame]',
  '#dsh-app',
  'main[data-dsh-root]',
  'main',
] as const

export interface PanelDockLease {
  /** The element we are pushing. Null when the dock is unavailable. */
  readonly element: HTMLElement | null
  /** Push the app frame over by `px`. No-op without a lease. */
  setMargin(px: number): void
  /** True while we still own the margin (nobody else wrote to it). */
  isValid(): boolean
  /** Restore the prior margin and give up the claim. */
  release(): void
}

/**
 * Find the DSH root element.
 *
 * Falls back through increasingly generic selectors and finally to `body`'s
 * first element child, because a host that renamed its app frame should still
 * get a working panel rather than a silent overlay.
 */
export function findDockElement(doc: Document): HTMLElement | null {
  for (const selector of ROOT_SELECTORS) {
    const found = doc.querySelector<HTMLElement>(selector)
    if (found) return found
  }
  const first = doc.body?.firstElementChild
  return first instanceof HTMLElement ? first : null
}

/**
 * Claim the dock.
 *
 * Returns a lease whose `element` is null when docking is impossible (no root,
 * viewport too narrow, or the margin is already owned). Callers must handle the
 * null case by rendering an overlay.
 */
export function claimPanelDock(doc: Document, widthPx: number): PanelDockLease {
  const element = findDockElement(doc)
  if (!element || doc.defaultView === null) return unavailable()
  if (doc.defaultView.innerWidth < DOCK_MIN_VIEWPORT_WIDTH) return unavailable()

  const prior = element.style.marginRight
  const priorTransition = element.style.transition
  // A non-empty margin we did not write means someone else owns it.
  if (prior !== '' && element.getAttribute(PANEL_DOCK_ATTRIBUTE) !== 'true') return unavailable()

  const clamped = clampMargin(widthPx, doc.defaultView.innerWidth)
  element.setAttribute(PANEL_DOCK_ATTRIBUTE, 'true')
  // Animate the push so the extension reads as motion, not a jump. 180ms is
  // fast enough to feel immediate and slow enough to be perceived.
  element.style.transition = priorTransition || 'margin-right 180ms cubic-bezier(0.22, 0.61, 0.36, 1)'
  element.style.marginRight = `${clamped}px`

  let released = false
  let expected = `${clamped}px`

  return {
    element,
    setMargin(px: number) {
      if (released) return
      // Someone else wrote to the margin: stop fighting them and let the caller
      // fall back to an overlay on the next validity check.
      if (element.style.marginRight !== expected) return
      const next = clampMargin(px, doc.defaultView?.innerWidth ?? widthPx * 2)
      expected = `${next}px`
      element.style.marginRight = expected
    },
    isValid() {
      if (released) return false
      if (!element.isConnected) return false
      return element.style.marginRight === expected
    },
    release() {
      if (released) return
      released = true
      // Restore exactly what we found. Not '' — that would clobber a margin the
      // host or another plugin set before we arrived.
      element.style.marginRight = prior
      element.style.transition = priorTransition
      if (prior === '') element.removeAttribute(PANEL_DOCK_ATTRIBUTE)
    },
  }
}

function unavailable(): PanelDockLease {
  return {
    element: null,
    setMargin() {},
    isValid: () => false,
    release() {},
  }
}

export function clampMargin(px: number, viewportWidth: number): number {
  const max = Math.floor(viewportWidth * DOCK_MAX_FOREIGN_FRACTION)
  return Math.max(0, Math.min(px, max))
}

// ── panel width bounds ──────────────────────────────────────────────────────

export const PANEL_DEFAULT_WIDTH = 460
export const PANEL_MIN_WIDTH = 320
export const PANEL_MAX_WIDTH = 1100
/** Landscape content (a desktop viewport) wants more room than portrait. */
export const PANEL_LANDSCAPE_WIDTH = 720
export const PANEL_LEFT_CLEARANCE = 220

export function clampPanelWidth(px: number): number {
  if (!Number.isFinite(px)) return PANEL_DEFAULT_WIDTH
  return Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, Math.round(px)))
}

/**
 * The width a browser frame wants, given its natural pixel size.
 *
 * A desktop viewport is landscape and reads badly in a 460px column, so the
 * panel auto-widens while the content is landscape — and restores the user's
 * portrait width when it goes back, without fighting a manual drag made during
 * the landscape stint.
 */
export function desiredPanelWidth(
  frame: { width: number; height: number } | undefined,
  userWidth: number,
  userDraggedDuringLandscape: boolean,
): number {
  if (!frame || frame.width <= 0 || frame.height <= 0) return clampPanelWidth(userWidth)
  const isLandscape = frame.width > frame.height
  if (!isLandscape) return clampPanelWidth(userWidth)
  if (userDraggedDuringLandscape) return clampPanelWidth(userWidth)
  return clampPanelWidth(Math.max(userWidth, PANEL_LANDSCAPE_WIDTH))
}

/** Base inline styles for the docked surface. */
export function dockedSurfaceStyles(width: number, extending: boolean): CSSProperties {
  return {
    position: 'fixed',
    top: 0,
    right: 0,
    bottom: 0,
    width: `${width}px`,
    // Slide in from the right during the `extend` stage; the dock margin
    // animates on the same 180ms curve so the two stay in step.
    transform: extending ? 'translateX(100%)' : 'translateX(0)',
    transition: 'transform 180ms cubic-bezier(0.22, 0.61, 0.36, 1), width 180ms cubic-bezier(0.22, 0.61, 0.36, 1)',
    display: 'flex',
    flexDirection: 'column',
    zIndex: 60,
    pointerEvents: 'auto',
  }
}

/** Fallback overlay styles, used when the dock lease is unavailable. */
/**
 * Overlay backdrop.
 *
 * `narrow` (phone) drops the dim and the centering: the sheet covers the whole
 * viewport, so a dark scrim behind it would only cost a repaint, and centering
 * a full-size child fights the mobile keyboard. `safe-area-inset-*` padding
 * keeps the header out from under a notch and the footer above the home bar.
 */
export function overlaySurfaceStyles(width: number, narrow = false): CSSProperties {
  if (narrow) {
    return {
      position: 'fixed',
      inset: 0,
      display: 'flex',
      alignItems: 'stretch',
      justifyContent: 'stretch',
      background: 'var(--dsw-bg-primary, #101014)',
      zIndex: 60,
      pointerEvents: 'auto',
      paddingTop: 'env(safe-area-inset-top, 0px)',
      paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      paddingLeft: 'env(safe-area-inset-left, 0px)',
      paddingRight: 'env(safe-area-inset-right, 0px)',
    }
  }
  void width
  return {
    position: 'fixed',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0, 0, 0, 0.44)',
    zIndex: 60,
    pointerEvents: 'auto',
  }
}
