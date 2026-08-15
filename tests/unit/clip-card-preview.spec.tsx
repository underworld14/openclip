// @vitest-environment jsdom
/**
 * tests/unit/clip-card-preview.spec.tsx — the results are no longer a wall of
 * identical text cards (FEAT-71ay4e).
 *
 * The card rendered a title, a score, a range, a hook sentence and four bars —
 * no image, no video, and not one syllable of what is actually SAID in the span.
 * Judging a suggestion meant clicking each card and scrubbing. Meanwhile
 * `generateThumbnail` was fully implemented at ffmpeg-export.ts with ZERO
 * callers, and `Clip.thumbnailPath` was never written by anything.
 *
 * Three surfaces are pinned here, in the order the ticket ranks them:
 *
 *  1. The transcript EXCERPT — the cheapest credibility win available. The
 *     transcript is already in the store; showing the real words next to the
 *     AI's claim about them is what makes the claim checkable.
 *  2. The poster FRAME at the clip's IN point, served over `openclip-media:`.
 *  3. The hover PREVIEW, mounted only while hovered and scoped to the clip's
 *     span with a `#t=start,end` fragment.
 *
 * The absent cases matter as much as the present ones: a project written before
 * thumbnails existed, or a clip whose span contains no speech, must render
 * cleanly rather than showing a broken image or an empty quote block.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import { installRendererEnv } from '../harness/renderer-env'
import { useProjectStore } from '@renderer/stores/projectStore'
import { ClipCard } from '@renderer/components/ClipCard'
import { clipExcerpt, clipViewModel } from '@renderer/components/clipView'
import { clipFixture, projectFixture } from '../fixtures/contract'
import type { Clip, TranscriptSegment } from '@shared/schema'

const seg = (start: number, end: number, text: string): TranscriptSegment => ({
  id: `s${start}`,
  start,
  end,
  text,
  confidence: 0.9
})

/**
 * A clip spanning 10-20s with NO thumbnail and NO trim.
 *
 * `clipFixture` ships both (`thumbnailPath` and `editedStart`/`editedEnd`), and
 * inheriting them silently would make the "absent" cases below pass for the
 * wrong reason — so they are cleared here and opted back into per test.
 */
const clip = (over: Partial<Clip> = {}): Clip => ({
  ...clipFixture,
  id: 'c1',
  startTime: 10,
  endTime: 20,
  editedStart: undefined,
  editedEnd: undefined,
  thumbnailPath: undefined,
  ...over
})

/** Seed the store with a transcript and a source video, as the app has after import. */
function seed(segments: TranscriptSegment[]): void {
  useProjectStore.setState({
    currentProject: {
      ...projectFixture,
      sourceVideo: { ...projectFixture.sourceVideo, path: '/Users/me/My Video.mp4' }
    },
    transcript: { language: 'en', segments, words: [] }
  })
}

beforeEach(() => {
  installRendererEnv()
  useProjectStore.setState({ clips: [], selectedClipId: null })
})

afterEach(() => {
  cleanup()
})

describe('clipExcerpt: the words actually spoken inside the span', () => {
  const SEGMENTS = [
    seg(0, 5, 'Before the clip.'),
    seg(8, 12, 'Straddles the in point.'),
    seg(12, 18, 'Squarely inside.'),
    seg(25, 30, 'After the clip.')
  ]

  it('joins every segment that overlaps the span, including partial ones', () => {
    // A segment straddling the IN point is part of what the viewer will HEAR,
    // so excluding it would misrepresent the clip.
    expect(clipExcerpt(SEGMENTS, 10, 20)).toBe('Straddles the in point. Squarely inside.')
  })

  it('excludes segments that merely touch the boundary', () => {
    // end === start is not an overlap; including it would put a sentence the
    // viewer never hears into the excerpt.
    expect(clipExcerpt([seg(0, 10, 'ends exactly at IN')], 10, 20)).toBeUndefined()
    expect(clipExcerpt([seg(20, 30, 'starts exactly at OUT')], 10, 20)).toBeUndefined()
  })

  it('returns undefined for no transcript and for a silent span', () => {
    // Both must be undefined, not '' — the card keys the whole quote block off
    // this value, and an empty string would render an empty bordered box.
    expect(clipExcerpt(undefined, 10, 20)).toBeUndefined()
    expect(clipExcerpt([], 10, 20)).toBeUndefined()
    expect(clipExcerpt([seg(0, 5, 'elsewhere')], 10, 20)).toBeUndefined()
    expect(clipExcerpt([seg(10, 20, '   ')], 10, 20)).toBeUndefined()
  })

  it('truncates on a word boundary, with an ellipsis', () => {
    const long = clipExcerpt([seg(10, 20, 'alpha bravo charlie delta echo')], 10, 20, 20)
    // Not 'alpha bravo charlie…' cut mid-word — a mid-word cut reads as corruption.
    expect(long).toBe('alpha bravo charlie…')
    expect(long!.length).toBeLessThanOrEqual(21)
  })

  it('does not truncate text that already fits', () => {
    expect(clipExcerpt([seg(10, 20, 'short enough')], 10, 20, 240)).toBe('short enough')
  })

  it('honours the EDITED bounds, not the original ones', () => {
    const vm = clipViewModel(clip({ editedStart: 24, editedEnd: 30 }), SEGMENTS)
    // Trimming the clip past a sentence must drop that sentence from the excerpt.
    expect(vm.excerpt).toBe('After the clip.')
  })
})

describe('ClipCard: the excerpt is rendered', () => {
  it('quotes the transcript under the hook line', () => {
    seed([seg(10, 20, 'This is what is actually said.')])
    render(<ClipCard clip={clip()} />)
    expect(screen.getByTestId('clip-excerpt').textContent).toBe('This is what is actually said.')
  })

  it('renders no quote block at all when the span has no speech', () => {
    seed([seg(0, 5, 'elsewhere')])
    render(<ClipCard clip={clip()} />)
    expect(screen.queryByTestId('clip-excerpt')).toBeNull()
  })
})

describe('ClipCard: the poster frame', () => {
  it('carries thumbnailPath through the view model', () => {
    expect(clipViewModel(clip({ thumbnailPath: '/tmp/t.jpg' })).thumbnailPath).toBe('/tmp/t.jpg')
    expect(clipViewModel(clip()).thumbnailPath).toBeUndefined()
  })

  it('renders an <img> over the privileged media scheme', () => {
    seed([])
    render(<ClipCard clip={clip({ thumbnailPath: '/tmp/openclip/demo/cache/thumb c1.jpg' })} />)
    const img = screen.getByTestId('clip-thumbnail')
    expect(img.tagName).toBe('IMG')
    // The same scheme the preview <video> uses — a bare filesystem path in an
    // <img> is blocked by the CSP and renders as a broken image.
    expect(img.getAttribute('src')).toBe(
      'openclip-media://file/tmp/openclip/demo/cache/thumb%20c1.jpg'
    )
    // Decorative: the title, range and excerpt already name the clip.
    expect(img.getAttribute('alt')).toBe('')
    expect(img.getAttribute('aria-hidden')).toBe('true')
  })

  it('renders nothing for a project written before thumbnails existed', () => {
    seed([])
    render(<ClipCard clip={clip({ thumbnailPath: undefined })} />)
    expect(screen.queryByTestId('clip-thumbnail')).toBeNull()
  })
})

describe('ClipCard: the hover preview', () => {
  const withThumb = (): Clip => clip({ thumbnailPath: '/tmp/t.jpg' })

  it('mounts no <video> until the pointer is over the card', () => {
    // The cap the ticket asks for (2-3 concurrent <video>) falls out of this:
    // with 40 results on screen, none of them hold a decoder.
    seed([])
    render(<ClipCard clip={withThumb()} />)
    expect(screen.queryByTestId('clip-preview')).toBeNull()
  })

  it('swaps the poster for a muted looping <video> scoped to the clip span', async () => {
    seed([])
    render(<ClipCard clip={withThumb()} />)
    await act(async () => {
      fireEvent.mouseEnter(screen.getByTestId('clip-card'))
    })

    const video = screen.getByTestId('clip-preview') as HTMLVideoElement
    expect(video.tagName).toBe('VIDEO')
    // Without the fragment the user would watch the top of the SOURCE, not this clip.
    expect(video.getAttribute('src')).toBe('openclip-media://file/Users/me/My%20Video.mp4#t=10,20')
    expect(video.muted).toBe(true)
    expect(video.loop).toBe(true)
    // Only one visual at a time — the poster is replaced, not stacked under it.
    expect(screen.queryByTestId('clip-thumbnail')).toBeNull()
  })

  it('uses the EDITED bounds in the time fragment', async () => {
    seed([])
    render(
      <ClipCard clip={clip({ thumbnailPath: '/tmp/t.jpg', editedStart: 11.5, editedEnd: 16 })} />
    )
    await act(async () => {
      fireEvent.mouseEnter(screen.getByTestId('clip-card'))
    })
    expect(screen.getByTestId('clip-preview').getAttribute('src')).toContain('#t=11.5,16')
  })

  it('unmounts the <video> on mouse-out, restoring the poster', async () => {
    seed([])
    render(<ClipCard clip={withThumb()} />)
    await act(async () => {
      fireEvent.mouseEnter(screen.getByTestId('clip-card'))
    })
    await act(async () => {
      fireEvent.mouseLeave(screen.getByTestId('clip-card'))
    })
    expect(screen.queryByTestId('clip-preview')).toBeNull()
    expect(screen.getByTestId('clip-thumbnail')).toBeTruthy()
  })

  it('shows no preview when there is no poster to swap out', async () => {
    // No thumbnail means generation has not run (or failed); hovering must not
    // conjure a video where the card was showing plain text.
    seed([])
    render(<ClipCard clip={clip({ thumbnailPath: undefined })} />)
    await act(async () => {
      fireEvent.mouseEnter(screen.getByTestId('clip-card'))
    })
    expect(screen.queryByTestId('clip-preview')).toBeNull()
  })

  it('BUG-qcvhcn: stays on the static poster under prefers-reduced-motion, even while hovered', async () => {
    seed([])
    const original = window.matchMedia
    window.matchMedia = ((query: string) =>
      ({
        matches: query === '(prefers-reduced-motion: reduce)',
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {}
      }) as unknown as MediaQueryList) as typeof window.matchMedia
    try {
      render(<ClipCard clip={withThumb()} />)
      await act(async () => {
        fireEvent.mouseEnter(screen.getByTestId('clip-card'))
      })
      expect(screen.queryByTestId('clip-preview')).toBeNull()
      expect(screen.getByTestId('clip-thumbnail')).toBeTruthy()
    } finally {
      window.matchMedia = original
    }
  })
})
