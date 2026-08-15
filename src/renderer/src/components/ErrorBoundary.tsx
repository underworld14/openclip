/**
 * ErrorBoundary — the last line of defence against a blank window
 * (EPIC-k83ghw / BUG-fcg251).
 *
 * Before this, ANY uncaught render error left the window permanently blank:
 * no message, no reload button, nothing shown at all. The only way out was
 * force-quitting the whole app and relaunching — not something a
 * non-technical user has any reason to think of.
 *
 * Deliberately dependency-free: this is the fallback for when something ELSE
 * in the render tree just broke, so it must not import any of the app's own
 * UI primitives (Button, `cn`, tailwind-merge, Tailwind's generated classes)
 * — if the crash originated in one of those, importing it here would crash
 * the boundary itself and bring back the exact blank window this exists to
 * prevent. Inline styles only.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary] a render error reached the top of the tree', error, info)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div
        data-testid="error-boundary"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '10px',
          height: '100vh',
          width: '100vw',
          padding: '24px',
          textAlign: 'center',
          background: '#0a0a0a',
          color: '#f5f5f5',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
        }}
      >
        <div style={{ fontSize: '15px', fontWeight: 600 }}>Something went wrong</div>
        <div style={{ fontSize: '13px', color: '#a3a3a3', maxWidth: '420px', lineHeight: 1.5 }}>
          OpenClip hit an unexpected error and could not continue. Reloading will not lose your work
          — projects are saved to disk as you go.
        </div>
        <button
          type="button"
          data-testid="error-boundary-reload"
          onClick={() => window.location.reload()}
          style={{
            marginTop: '8px',
            padding: '8px 18px',
            borderRadius: '6px',
            border: '1px solid #404040',
            background: '#1a1a1a',
            color: '#f5f5f5',
            fontSize: '13px',
            cursor: 'pointer'
          }}
        >
          Reload
        </button>
      </div>
    )
  }
}

export default ErrorBoundary
