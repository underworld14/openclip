// @vitest-environment jsdom
/**
 * tests/unit/error-boundary.spec.tsx — a top-level render error must not
 * leave the window permanently blank (EPIC-k83ghw / BUG-fcg251).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ErrorBoundary } from '@renderer/components/ErrorBoundary'

function Boom(): React.JSX.Element {
  throw new Error('kaboom')
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ErrorBoundary', () => {
  it('renders children normally when nothing throws', () => {
    render(
      <ErrorBoundary>
        <div>hello</div>
      </ErrorBoundary>
    )
    expect(screen.getByText('hello')).toBeTruthy()
    expect(screen.queryByTestId('error-boundary')).toBeNull()
  })

  it('catches a render error and offers Reload instead of a blank window', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    )
    expect(screen.getByTestId('error-boundary')).toBeTruthy()
    expect(screen.getByTestId('error-boundary-reload')).toBeTruthy()
  })

  it('Reload calls window.location.reload, not a dead button', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // jsdom's `location.reload` is non-configurable, so it cannot be spied on
    // directly — replace the whole `location` object for this assertion.
    const reload = vi.fn()
    const original = window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, reload }
    })
    try {
      render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
      )
      fireEvent.click(screen.getByTestId('error-boundary-reload'))
      expect(reload).toHaveBeenCalledTimes(1)
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original })
    }
  })
})
