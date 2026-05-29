/**
 * tests/unit/transcript-panel.spec.ts — TranscriptPanel presentation logic.
 *
 * NOTE on rendering: zustand v5's `useStore` uses `getInitialState()` as the
 * React `getServerSnapshot`, so a server render (react-dom/server) always sees
 * the store's INITIAL state — it cannot observe runtime `setState`. We therefore
 * assert (a) the empty-state markup (initial state IS empty) and (b) the pure
 * presentation helpers the component renders from. The LIVE reactive render
 * (segments appearing as the transcribe job streams) is proven in real Chromium
 * by the vertical-slice E2E (tests/e2e/vertical-slice.e2e.spec.ts).
 */

import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TranscriptPanel } from '@renderer/components/TranscriptPanel'
import { formatTimestamp } from '@renderer/components/transcript-format'

describe('TranscriptPanel: empty state (initial store snapshot)', () => {
  it('renders the panel test id + an empty prompt with no transcript', () => {
    const html = renderToStaticMarkup(createElement(TranscriptPanel))
    expect(html).toContain('data-testid="transcript-panel"')
    expect(html.toLowerCase()).toMatch(/no transcript|transcribe/)
  })
})

describe('TranscriptPanel: formatTimestamp (segment time labels)', () => {
  it('formats seconds as m:ss (under an hour)', () => {
    expect(formatTimestamp(0)).toBe('0:00')
    expect(formatTimestamp(5)).toBe('0:05')
    expect(formatTimestamp(65)).toBe('1:05')
    expect(formatTimestamp(125.7)).toBe('2:05')
  })
  it('formats h:mm:ss past an hour', () => {
    expect(formatTimestamp(3661)).toBe('1:01:01')
  })
  it('clamps negatives to 0:00', () => {
    expect(formatTimestamp(-3)).toBe('0:00')
  })
})
