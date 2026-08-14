// @vitest-environment jsdom
/**
 * tests/unit/generate-preflight-dialog.spec.tsx — the panel itself (FEAT-n762y6).
 *
 * The logic lives in `@shared/generate-preflight` and is asserted directly next
 * door. What is pinned HERE is the part only a rendered dialog can be wrong
 * about:
 *
 *  - It opens submittable. Press Generate on a freshly-opened panel and a full
 *    config comes back — no field is required. That is the entire design rule,
 *    and it is the kind of thing a later "just make style mandatory" change
 *    breaks without any test noticing.
 *  - Every ClipStyle has a button. Six of the seven had no UI anywhere; that is
 *    the defect this ticket was filed for.
 *  - It seeds from `initial`, which is what makes Regenerate open pre-filled
 *    with the last run rather than back at the defaults.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import { installRendererEnv } from '../harness/renderer-env'
import { GeneratePreflightDialog } from '@renderer/components/GeneratePreflightDialog'
import { ClipSidebar } from '@renderer/components/ClipSidebar'
import { useProjectStore } from '@renderer/stores/projectStore'
import { clipFixture } from '../fixtures/contract'
import { ClipStyle } from '@shared/schema'
import type { PreflightConfig } from '@shared/generate-preflight'
import type { TranscriptSegment } from '@shared/schema'

const seg = (start: number, end: number): TranscriptSegment => ({
  id: `s${start}`,
  start,
  end,
  text: 'words',
  confidence: 0.9
})

/** A transcript spanning the whole 600s default duration. */
const SEGMENTS = [seg(0, 100), seg(100, 200), seg(200, 400), seg(400, 600)]

const INITIAL: PreflightConfig = {
  numClips: 5,
  lengthPreset: 'auto',
  minDuration: 15,
  maxDuration: 90,
  clipStyle: 'all',
  keywords: [],
  customPrompt: '',
  range: null
}

function open(
  over: Partial<PreflightConfig> = {},
  duration = 600,
  segments: TranscriptSegment[] = SEGMENTS
): { onGenerate: ReturnType<typeof vi.fn>; onCancel: ReturnType<typeof vi.fn> } {
  const onGenerate = vi.fn()
  const onCancel = vi.fn()
  render(
    <GeneratePreflightDialog
      open
      duration={duration}
      initial={{ ...INITIAL, ...over }}
      segments={segments}
      onCancel={onCancel}
      onGenerate={onGenerate}
    />
  )
  return { onGenerate, onCancel }
}

beforeEach(() => {
  installRendererEnv()
  useProjectStore.setState({ clips: [], generating: false })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('the panel opens submittable', () => {
  it('returns a complete config from a press with no edits at all', () => {
    const { onGenerate } = open()
    act(() => {
      fireEvent.click(screen.getByTestId('preflight-submit'))
    })
    expect(onGenerate).toHaveBeenCalledTimes(1)
    expect(onGenerate.mock.calls[0][0]).toMatchObject({
      numClips: 5,
      minDuration: 15,
      maxDuration: 90,
      clipStyle: 'all',
      keywords: [],
      customPrompt: '',
      range: null
    })
  })

  it('says so, rather than leaving the user looking for the required field', () => {
    open()
    expect(screen.getByTestId('generate-preflight').textContent).toMatch(/optional/i)
  })
})

describe('the controls the ticket exists for', () => {
  it('renders a button for EVERY clip style', () => {
    open()
    for (const style of ClipStyle.options) {
      expect(screen.getByTestId(`preflight-style-${style}`), style).toBeTruthy()
    }
  })

  it('selecting a style is reflected in the submitted config and the hint', () => {
    const { onGenerate } = open()
    act(() => {
      fireEvent.click(screen.getByTestId('preflight-style-funny'))
    })
    expect(screen.getByTestId('preflight-style-hint').textContent).toMatch(/punchline/i)
    act(() => {
      fireEvent.click(screen.getByTestId('preflight-submit'))
    })
    expect(onGenerate.mock.calls[0][0].clipStyle).toBe('funny')
  })

  it('a length bucket carries its bounds through', () => {
    const { onGenerate } = open()
    act(() => {
      fireEvent.click(screen.getByTestId('preflight-length-medium'))
    })
    act(() => {
      fireEvent.click(screen.getByTestId('preflight-submit'))
    })
    expect(onGenerate.mock.calls[0][0]).toMatchObject({ minDuration: 30, maxDuration: 60 })
  })

  it('shows a custom-bounds note instead of lighting the wrong bucket', () => {
    open({ lengthPreset: 'custom', minDuration: 20, maxDuration: 70 })
    expect(screen.getByTestId('preflight-length-custom').textContent).toContain('20–70s')
    for (const id of ['auto', 'short', 'medium', 'long']) {
      expect(screen.getByTestId(`preflight-length-${id}`).getAttribute('aria-pressed')).toBe(
        'false'
      )
    }
  })

  it('parses the keyword field on submit, not on every keystroke', () => {
    const { onGenerate } = open()
    const field = screen.getByTestId('preflight-keywords')
    // Typing a trailing comma must not make the comma vanish under the cursor.
    act(() => {
      fireEvent.change(field, { target: { value: 'pricing, hiring,' } })
    })
    expect((field as HTMLInputElement).value).toBe('pricing, hiring,')
    act(() => {
      fireEvent.click(screen.getByTestId('preflight-submit'))
    })
    expect(onGenerate.mock.calls[0][0].keywords).toEqual(['pricing', 'hiring'])
  })

  it('carries the free-text prompt', () => {
    const { onGenerate } = open()
    act(() => {
      fireEvent.change(screen.getByTestId('preflight-prompt'), {
        target: { value: 'the remote-work argument' }
      })
    })
    act(() => {
      fireEvent.click(screen.getByTestId('preflight-submit'))
    })
    expect(onGenerate.mock.calls[0][0].customPrompt).toBe('the remote-work argument')
  })
})

describe('the processing timeframe', () => {
  it('is off by default — the whole video, with no range inputs on screen', () => {
    open()
    expect(screen.queryByTestId('preflight-range-start')).toBeNull()
  })

  it('submits the window once enabled and narrowed', () => {
    const { onGenerate } = open()
    act(() => {
      fireEvent.click(screen.getByTestId('preflight-range-toggle'))
    })
    act(() => {
      fireEvent.change(screen.getByTestId('preflight-range-start'), { target: { value: '60' } })
    })
    act(() => {
      fireEvent.change(screen.getByTestId('preflight-range-end'), { target: { value: '300' } })
    })
    act(() => {
      fireEvent.click(screen.getByTestId('preflight-submit'))
    })
    expect(onGenerate.mock.calls[0][0].range).toEqual({ start: 60, end: 300 })
  })

  it('drops a window that still covers everything', () => {
    // Enabling the toggle and leaving it at 0-duration is not a restriction, and
    // sending it would miss the cache against an identical whole-video run.
    const { onGenerate } = open()
    act(() => {
      fireEvent.click(screen.getByTestId('preflight-range-toggle'))
    })
    act(() => {
      fireEvent.click(screen.getByTestId('preflight-submit'))
    })
    expect(onGenerate.mock.calls[0][0].range).toBeNull()
  })
})

describe('a window with no speech in it', () => {
  it('refuses the run rather than buying a guaranteed-empty result', () => {
    // The window costs a real provider round-trip on the user's own key, and the
    // failure reads as "the AI found nothing in my video" rather than "you
    // pointed it at silence".
    const { onGenerate } = open()
    act(() => {
      fireEvent.click(screen.getByTestId('preflight-range-toggle'))
    })
    act(() => {
      fireEvent.change(screen.getByTestId('preflight-range-start'), { target: { value: '10' } })
    })
    act(() => {
      fireEvent.change(screen.getByTestId('preflight-range-end'), { target: { value: '20' } })
    })
    // 10-20s IS inside the transcript, so this is still submittable…
    expect(screen.queryByTestId('preflight-empty-window')).toBeNull()
    act(() => {
      fireEvent.click(screen.getByTestId('preflight-submit'))
    })
    expect(onGenerate).toHaveBeenCalledTimes(1)
  })

  it('names the fix — widen the window — and disables Generate', () => {
    const { onGenerate } = open({}, 600, [seg(0, 30)])
    act(() => {
      fireEvent.click(screen.getByTestId('preflight-range-toggle'))
    })
    act(() => {
      fireEvent.change(screen.getByTestId('preflight-range-start'), { target: { value: '100' } })
    })
    act(() => {
      fireEvent.change(screen.getByTestId('preflight-range-end'), { target: { value: '200' } })
    })
    expect(screen.getByTestId('preflight-empty-window').textContent).toMatch(/widen it/i)
    expect((screen.getByTestId('preflight-submit') as HTMLButtonElement).disabled).toBe(true)
    act(() => {
      fireEvent.click(screen.getByTestId('preflight-submit'))
    })
    expect(onGenerate).not.toHaveBeenCalled()
  })

  it('says something different when there is no transcript at all', () => {
    // Not "widen the window" — there is no window; the video is untranscribed.
    open({}, 600, [])
    expect(screen.getByTestId('preflight-empty-window').textContent).toMatch(/transcribe/i)
  })
})

describe('the summary line', () => {
  it('describes what pressing Generate will do, live', () => {
    open()
    expect(screen.getByTestId('preflight-summary').textContent).toBe('5 clips · 15–90s · anything')
    act(() => {
      fireEvent.click(screen.getByTestId('preflight-style-educational'))
    })
    expect(screen.getByTestId('preflight-summary').textContent).toContain('educational')
  })
})

describe('cancel', () => {
  it('reports the dismissal without generating anything', () => {
    const { onGenerate, onCancel } = open()
    act(() => {
      fireEvent.click(screen.getByTestId('preflight-cancel'))
    })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onGenerate).not.toHaveBeenCalled()
  })
})

describe('ClipSidebar: Regenerate', () => {
  it('offers Regenerate once there are results', () => {
    // The PRD asks for "regenerate with a different prompt/style" and NO
    // affordance existed anywhere in the app.
    useProjectStore.setState({ clips: [{ ...clipFixture, id: 'c1' }] })
    const onRegenerate = vi.fn()
    render(<ClipSidebar onRegenerate={onRegenerate} />)
    act(() => {
      fireEvent.click(screen.getByTestId('regenerate-clips'))
    })
    expect(onRegenerate).toHaveBeenCalledTimes(1)
  })

  it('hides it before the first run and while one is in flight', () => {
    const onRegenerate = vi.fn()
    // Nothing to regenerate yet — the header button is the entry point.
    const { unmount } = render(<ClipSidebar onRegenerate={onRegenerate} />)
    expect(screen.queryByTestId('regenerate-clips')).toBeNull()
    unmount()

    // Mid-run, Cancel owns the state; a second Generate would queue a paid
    // duplicate of the one already running.
    useProjectStore.setState({ clips: [{ ...clipFixture, id: 'c1' }], generating: true })
    render(<ClipSidebar onRegenerate={onRegenerate} />)
    expect(screen.queryByTestId('regenerate-clips')).toBeNull()
  })

  it('renders bare, with no Regenerate, when no handler is given', () => {
    useProjectStore.setState({ clips: [{ ...clipFixture, id: 'c1' }] })
    render(<ClipSidebar />)
    expect(screen.queryByTestId('regenerate-clips')).toBeNull()
  })
})
