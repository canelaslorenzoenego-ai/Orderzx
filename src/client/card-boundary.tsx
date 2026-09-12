/**
 * Error boundary for slot components.
 *
 * A throwing slot component takes down the whole conversation view in DSH —
 * the React root above it has no boundary of its own at that seat. Since every
 * card here reads host-shaped JSON that can change between versions, the blast
 * radius of a bad assumption is the user's chat. That is not an acceptable trade
 * for a presentation nicety, so each card is wrapped.
 *
 * The fallback is a one-line notice rather than nothing: a silently empty card
 * is indistinguishable from a card that never rendered, which makes a real bug
 * look like a missing feature.
 *
 * @module @dsh-community/dsh-browser/client/card-boundary
 */

import { Component } from 'react'
import type { CSSProperties, ErrorInfo, ReactNode } from 'react'

interface Props {
  label: string
  children: ReactNode
}

interface State {
  error: Error | null
}

export class CardBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface to the host console rather than swallowing: a card that throws on
    // every render is a bug the developer needs to see.
    console.error(`[dsh-browser] card "${this.props.label}" failed to render`, error, info?.componentStack)
  }

  override render(): ReactNode {
    const { error } = this.state
    if (error) {
      return (
        <div style={fallbackStyles} role="status">
          <span style={{ fontWeight: 600 }}>browser</span>
          <span style={detailStyles}>{truncate(error.message || 'card failed to render')}</span>
        </div>
      )
    }
    return this.props.children
  }
}

function truncate(message: string, max = 160): string {
  return message.length > max ? `${message.slice(0, max)}…` : message
}

const fallbackStyles: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 9px',
  borderRadius: 8,
  fontSize: 11.5,
  border: '1px solid rgba(248,81,73,0.32)',
  background: 'rgba(248,81,73,0.08)',
  color: 'var(--dsw-text-secondary, #b8b8c2)',
  minWidth: 0,
}

const detailStyles: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  color: '#f85149',
  fontSize: 10.5,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
}
