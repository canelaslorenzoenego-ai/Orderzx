/**
 * Shared inline-card styles.
 *
 * Its own module so `cards.tsx` and `client/index.tsx` can both use it without a
 * circular import: index registers the cards, so cards must not import index.
 *
 * All colors fall back through the `--dsw-*` custom properties DSH sets on its
 * root, so the cards follow the host theme instead of hard-coding a dark palette.
 *
 * @module @dsh-community/dsh-browser/client/card-styles
 */

import type { CSSProperties } from 'react'

export const CARD_STYLES: Record<string, CSSProperties> = {
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 9px',
    borderRadius: 8,
    border: '1px solid var(--dsw-border-color, rgba(128,128,128,0.22))',
    background: 'var(--dsw-bg-secondary, rgba(128,128,128,0.06))',
    fontSize: 11.5,
    lineHeight: 1.4,
    color: 'var(--dsw-text-secondary, #b8b8c2)',
    cursor: 'pointer',
    minWidth: 0,
  },
  title: {
    fontWeight: 600,
    color: 'var(--dsw-text-primary, #e6e6ea)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    minWidth: 0,
    flex: '0 1 auto',
  },
  detail: {
    flex: '1 1 auto',
    minWidth: 0,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 10.5,
    opacity: 0.82,
  },
  cue: {
    flex: '0 0 auto',
    fontSize: 10,
    opacity: 0.6,
    whiteSpace: 'nowrap',
  },
  badge: {
    flex: '0 0 auto',
    padding: '1px 6px',
    borderRadius: 999,
    fontSize: 10,
    lineHeight: 1.5,
    fontWeight: 500,
  },
}
