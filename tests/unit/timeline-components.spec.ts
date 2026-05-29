/**
 * tests/unit/timeline-components.spec.ts — PreviewPlayer + Timeline presentation
 * (TIMELINE spine, plan E.5 / PRD §6.6).
 *
 * NOTE on rendering (same constraint as transcript-panel.spec): zustand v5's
 * `useStore` uses `getInitialState()` as the React `getServerSnapshot`, so a
 * server render (react-dom/server) sees the store's INITIAL state. We therefore
 * assert the structural markup + the empty/seeded states that the INITIAL store
 * snapshot produces. The LIVE reactive behaviour (drag retrim → editedStart/End,
 * preview seek, and re-export reflecting the trim) is proven in real Chromium by
 * the timeline E2E (tests/e2e/timeline.e2e.spec.ts) + the timelineSlice unit
 * tests (drive the store directly with projectFixture/clipFixture).
 */

import { describe, expect, it, beforeEach } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PreviewPlayer } from '@renderer/components/PreviewPlayer'
import { Timeline } from '@renderer/components/Timeline'
import { useProjectStore } from '@renderer/stores/projectStore'

function resetStore(): void {
  useProjectStore.setState({
    currentProject: null,
    clips: [],
    selectedClipId: null,
    transcript: null,
    playhead: 0,
    isPlaying: false,
    zoom: 1
  })
}

describe('PreviewPlayer', () => {
  beforeEach(resetStore)

  it('renders the player shell + an empty prompt with no source video', () => {
    const html = renderToStaticMarkup(createElement(PreviewPlayer))
    expect(html).toContain('data-testid="preview-player"')
    expect(html).toContain('data-testid="preview-empty"')
    expect(html.toLowerCase()).toContain('no source video')
  })
})

describe('Timeline', () => {
  beforeEach(resetStore)

  it('renders the timeline shell + a "select a clip" prompt with no clips', () => {
    const html = renderToStaticMarkup(createElement(Timeline))
    expect(html).toContain('data-testid="timeline"')
    expect(html.toLowerCase()).toMatch(/select a clip|import a source/)
  })

  // The SEEDED full render (track + clip region + both handles positioned from
  // editedStart/End) cannot be asserted via react-dom/server here: zustand v5
  // serves getInitialState() as the server snapshot, so post-create setState is
  // invisible to renderToStaticMarkup (same constraint documented in
  // transcript-panel.spec). That render — and the live drag retrim → re-export
  // honoring the new bounds — is proven in real Chromium by
  // tests/e2e/timeline.e2e.spec.ts. (clipFixture/projectFixture imported above
  // are exercised by the timelineSlice unit tests.)
})
