// @vitest-environment jsdom
/**
 * tests/unit/caption-style-panel.spec.tsx — the caption gallery is VISUAL, and
 * it is where the user can see it (FEAT-0s2tnc).
 *
 * The gallery was 13 `<button>`s whose only description was a raw HTML `title`
 * attribute, buried inside the Export dialog. "Hormozi", "MrBeast", "Beast Pop",
 * "Captionate" mean nothing without seeing them: the most visible thing the app
 * produces was chosen from a list of names, in a modal the user only opens after
 * deciding everything else.
 *
 * What is pinned here is what makes a thumbnail a PREVIEW rather than a swatch:
 *
 *  - Every preset renders, and each renders the SAME words — a gallery that
 *    varies two things at once compares nothing.
 *  - Each thumbnail carries that preset's OWN styling. A gallery where every
 *    tile looked identical would pass any test that only counted tiles.
 *  - One word is styled as "currently spoken", because the highlight colour is
 *    the thing that distinguishes most of these presets from each other.
 *  - Selection writes `captionTemplateId` to project settings, which is the
 *    single value the export and the preview both read.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import { installRendererEnv } from '../harness/renderer-env'
import { useProjectStore } from '@renderer/stores/projectStore'
import { CaptionStylePanel } from '@renderer/components/CaptionStylePanel'
import { CAPTION_PRESETS } from '@renderer/components/captionPresets'
import {
  FALLBACK_SAMPLE,
  sampleActiveIndex,
  sampleCaptionWords
} from '@renderer/components/captionSample'
import { projectFixture } from '../fixtures/contract'
import type { WordTimestamp } from '@shared/schema'

const word = (w: string, i: number): WordTimestamp => ({
  word: w,
  start: i * 0.3,
  end: i * 0.3 + 0.25,
  confidence: 0.9
})

function seed(words: string[], templateId?: string): void {
  useProjectStore.setState({
    currentProject: {
      ...projectFixture,
      settings: { ...projectFixture.settings, captionTemplateId: templateId }
    },
    transcript: { language: 'en', segments: [], words: words.map(word) }
  })
}

beforeEach(() => {
  installRendererEnv()
})

afterEach(() => {
  cleanup()
})

describe('sampleCaptionWords: the phrase every thumbnail renders', () => {
  it('takes three CONSECUTIVE real words from the transcript', () => {
    // A real phrase is what the template will actually have to render;
    // cherry-picking the shortest words would flatter every preset equally.
    expect(sampleCaptionWords(['this', 'is', 'the', 'best'].map(word))).toEqual([
      'this',
      'is',
      'the'
    ])
  })

  it('falls back when there is no transcript yet', () => {
    // The panel is reachable before transcription finishes.
    expect(sampleCaptionWords(undefined)).toEqual(FALLBACK_SAMPLE)
    expect(sampleCaptionWords([])).toEqual(FALLBACK_SAMPLE)
    expect(sampleCaptionWords([word('one', 0)])).toEqual(FALLBACK_SAMPLE)
  })

  it('skips a window containing a word too long to fit', () => {
    // Clipping a word in a STYLE preview reads as the style being broken, so the
    // scan slides past the offending word and takes the FIRST window that fits.
    const words = ['antidisestablishmentarianism', 'a', 'b', 'ok', 'fine'].map(word)
    expect(sampleCaptionWords(words)).toEqual(['a', 'b', 'ok'])
  })

  it('falls back rather than truncating when nothing fits', () => {
    expect(sampleCaptionWords(['xxxxxxxxxxxxxxxxxxxx'.repeat(1)].map(word))).toEqual(
      FALLBACK_SAMPLE
    )
  })

  it('drops whitespace-only tokens', () => {
    expect(sampleCaptionWords([' ', 'a', 'b', 'c'].map(word))).toEqual(['a', 'b', 'c'])
  })

  it('highlights the MIDDLE word, so both neighbours show the base colour', () => {
    expect(sampleActiveIndex(3)).toBe(1)
    expect(sampleActiveIndex(1)).toBe(0)
  })
})

describe('CaptionStylePanel: thumbnails, not name chips', () => {
  it('renders a thumbnail for Default plus every preset', () => {
    seed(['this', 'is', 'huge'])
    render(<CaptionStylePanel />)
    expect(screen.getAllByTestId('caption-template-thumb')).toHaveLength(CAPTION_PRESETS.length + 1)
  })

  it('renders the SAME words in every thumbnail', () => {
    // A gallery that varies two things at once compares nothing.
    seed(['alpha', 'bravo', 'charlie'])
    render(<CaptionStylePanel />)
    const thumbs = screen.getAllByTestId('caption-template-thumb')
    for (const thumb of thumbs) {
      const words = [...thumb.querySelectorAll('[data-testid="caption-template-word"]')].map((n) =>
        n.textContent?.trim()
      )
      expect(words).toEqual(['alpha', 'bravo', 'charlie'])
    }
  })

  it('uses the USER’S words, and says so', () => {
    seed(['pricing', 'is', 'hard'])
    render(<CaptionStylePanel />)
    expect(screen.getAllByTestId('caption-template-word')[0].textContent?.trim()).toBe('pricing')
    expect(screen.getByTestId('caption-style-source').textContent).toMatch(/your transcript/i)
  })

  it('says "sample text" when there is no transcript to draw from', () => {
    seed([])
    render(<CaptionStylePanel />)
    expect(screen.getByTestId('caption-style-source').textContent).toMatch(/sample/i)
    expect(screen.getAllByTestId('caption-template-word')[0].textContent?.trim()).toBe(
      FALLBACK_SAMPLE[0]
    )
  })

  it('gives each thumbnail its OWN styling', () => {
    // The failure this catches: a gallery of identically-styled tiles, which
    // would satisfy any test that merely counted them.
    seed(['this', 'is', 'huge'])
    render(<CaptionStylePanel />)
    const fonts = new Set(
      screen
        .getAllByTestId('caption-template-line')
        .map((line) => (line as HTMLElement).style.fontFamily)
    )
    expect(fonts.size).toBeGreaterThan(1)
    // …and the highlight colours differ too, which is the other half of what
    // makes one preset recognisable from another at thumbnail size.
    const highlights = new Set(
      screen
        .getAllByTestId('caption-template-thumb')
        .map(
          (t) => (t.querySelector('[data-word-active="true"]') as HTMLElement | null)?.style.color
        )
    )
    expect(highlights.size).toBeGreaterThan(1)
  })

  it('marks exactly one word per thumbnail as currently spoken', () => {
    // The highlight colour is what distinguishes most of these presets; with no
    // active word every thumbnail would show only the base fill.
    seed(['this', 'is', 'huge'])
    render(<CaptionStylePanel />)
    for (const thumb of screen.getAllByTestId('caption-template-thumb')) {
      const active = [...thumb.querySelectorAll('[data-word-active="true"]')]
      expect(active).toHaveLength(1)
      expect(active[0].textContent?.trim()).toBe('is')
    }
  })

  it('sizes the text off the tile WIDTH, so the crop is true scale', () => {
    seed(['this', 'is', 'huge'])
    render(<CaptionStylePanel />)
    const frame = screen.getAllByTestId('caption-template-frame')[0]
    // The tile's width stands in for the full 1080-px export canvas and the
    // height is cropped to the caption band. Showing the whole 9:16 frame at a
    // width that fits in a strip put the text at ~6px — faithful, and a gallery
    // of indistinguishable smudges.
    expect(frame.className).not.toContain('aspect-[9/16]')
    // `cqw` font sizing in caption-css depends on this.
    expect(frame.style.containerType).toBe('inline-size')
    const line = screen.getAllByTestId('caption-template-line')[0]
    expect(line.style.fontSize).toMatch(/cqw$/)
  })

  it('is accessible by name, not just by sight', () => {
    seed(['this', 'is', 'huge'])
    render(<CaptionStylePanel />)
    // Exact, not a loose regex: 'Hormozi' and 'Hormozi Bold' are both presets,
    // and a picker whose accessible names don't distinguish them is not usable
    // by anyone relying on them.
    const hormozi = screen.getByRole('button', {
      name: 'Caption template: Hormozi. Bold condensed text with a bright green highlight'
    })
    expect(hormozi.getAttribute('aria-pressed')).toBe('false')
  })
})

describe('CaptionStylePanel: selection', () => {
  it('writes captionTemplateId to project settings', () => {
    // The single value the export and the preview both read — this is what keeps
    // "what I picked" and "what gets burned" the same thing.
    seed(['this', 'is', 'huge'])
    render(<CaptionStylePanel />)
    const hormozi = screen
      .getAllByTestId('caption-template-thumb')
      .find((t) => t.getAttribute('data-template-id') === 'hormozi')!
    act(() => {
      fireEvent.click(hormozi)
    })
    expect(useProjectStore.getState().currentProject?.settings.captionTemplateId).toBe('hormozi')
  })

  it('marks the persisted template as selected on mount', () => {
    seed(['this', 'is', 'huge'], 'mrbeast')
    render(<CaptionStylePanel />)
    const selected = screen
      .getAllByTestId('caption-template-thumb')
      .filter((t) => t.getAttribute('data-active') === 'true')
    expect(selected).toHaveLength(1)
    expect(selected[0].getAttribute('data-template-id')).toBe('mrbeast')
  })

  it('treats an absent template id as Default selected', () => {
    seed(['this', 'is', 'huge'], undefined)
    render(<CaptionStylePanel />)
    const selected = screen
      .getAllByTestId('caption-template-thumb')
      .filter((t) => t.getAttribute('data-active') === 'true')
    expect(selected).toHaveLength(1)
    expect(selected[0].getAttribute('data-template-id')).toBe('')
  })

  it('renders nothing without an open project', () => {
    useProjectStore.setState({ currentProject: null })
    render(<CaptionStylePanel />)
    expect(screen.queryByTestId('caption-style-panel')).toBeNull()
  })
})
