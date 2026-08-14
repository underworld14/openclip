// @vitest-environment jsdom
/**
 * tests/unit/clip-card-surfaces.spec.tsx — three things the clip card should have
 * been showing all along (FEAT-ybhdhz, FEAT-g39qj3) plus the save indicator
 * (FEAT-51hnwx).
 *
 *  - The card was `role="button"` with `tabIndex` and an Enter/Space handler AND
 *    nested real `<Button>`s for Approve and Reject inside it. Interactive
 *    controls inside an interactive control make AT announcement ambiguous and
 *    trap Space, since both the inner buttons and the outer role claim it.
 *  - `clipView` derived only `isApproved: status === 'approved'`, so an EXPORTED
 *    clip had no badge, no approve and no reject — it rendered as a dead card,
 *    and the user could never tell which clips they had already shipped.
 *  - The AI writes `suggested_caption` and `hashtags` for every clip, the mapper
 *    carries them and the schema persists them — and nothing displayed them. The
 *    user paid for those tokens on every generation and never saw the output.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import { installRendererEnv } from '../harness/renderer-env'
import { useProjectStore } from '@renderer/stores/projectStore'
import { ClipCard } from '@renderer/components/ClipCard'
import { clipViewModel } from '@renderer/components/clipView'
import { saveStatusLabel, relativeSince } from '@renderer/components/saveStatus'
import { clipFixture } from '../fixtures/contract'
import type { Clip } from '@shared/schema'

const clip = (over: Partial<Clip> = {}): Clip => ({ ...clipFixture, id: 'c1', ...over })

beforeEach(() => {
  installRendererEnv()
  useProjectStore.setState({ clips: [], selectedClipId: null })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ClipCard: no interactive control nested inside another', () => {
  it('is a plain container, with an explicit button for selection', () => {
    useProjectStore.setState({ clips: [clip()] })
    render(<ClipCard clip={clip()} />)

    const card = screen.getByTestId('clip-card')
    expect(card.getAttribute('role')).toBeNull()
    expect(card.getAttribute('tabindex')).toBeNull()

    const select = screen.getByTestId('clip-select')
    expect(select.tagName).toBe('BUTTON')
  })

  it('keeps the action buttons OUTSIDE the selectable region', () => {
    useProjectStore.setState({ clips: [clip()] })
    render(<ClipCard clip={clip()} />)

    const select = screen.getByTestId('clip-select')
    // Approve/Reject as siblings, not descendants — that nesting is the defect.
    for (const label of ['Approve', 'Reject']) {
      const btn = screen.getByRole('button', { name: label })
      expect(select.contains(btn)).toBe(false)
    }
  })

  it('still selects the clip when the title region is activated', async () => {
    useProjectStore.setState({ clips: [clip()] })
    render(<ClipCard clip={clip()} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('clip-select'))
    })
    expect(useProjectStore.getState().selectedClipId).toBe('c1')
  })
})

describe('ClipCard: an exported clip is not a dead card', () => {
  it('derives isExported in the view model', () => {
    expect(clipViewModel(clip({ status: 'exported' })).isExported).toBe(true)
    expect(clipViewModel(clip({ status: 'approved' })).isExported).toBe(false)
  })

  it('renders an Exported badge', () => {
    render(<ClipCard clip={clip({ status: 'exported' })} />)
    expect(screen.getByTestId('clip-exported-badge').textContent).toMatch(/exported/i)
  })
})

describe('ClipCard: the AI social copy is finally visible', () => {
  const social = clip({
    suggestedCaption: 'The one habit that changed everything',
    hashtags: ['productivity', '#focus']
  })

  it('shows the caption and the hashtags', () => {
    render(<ClipCard clip={social} />)
    expect(screen.getByTestId('clip-caption').textContent).toMatch(/one habit/i)
    const tags = screen.getByTestId('clip-hashtags').textContent ?? ''
    // Normalised: the model returns them with and without the leading '#'.
    expect(tags).toContain('#productivity')
    expect(tags).toContain('#focus')
    expect(tags).not.toContain('##')
  })

  it('copies caption and hashtags together, in paste order', async () => {
    const writeText = vi.fn(async (text: string) => {
      void text
    })
    Object.assign(navigator, { clipboard: { writeText } })

    render(<ClipCard clip={social} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('clip-copy-caption'))
    })

    expect(writeText).toHaveBeenCalledTimes(1)
    const text = writeText.mock.calls[0][0] as string
    expect(text).toContain('The one habit that changed everything')
    expect(text).toContain('#productivity #focus')
  })

  it('renders nothing when an older project has neither', () => {
    render(<ClipCard clip={clip({ suggestedCaption: undefined, hashtags: undefined })} />)
    expect(screen.queryByTestId('clip-social')).toBeNull()
  })
})

describe('saveStatusLabel: persistence is legible', () => {
  it('says nothing before the first save rather than claiming one', () => {
    // "Saved" here would be a lie — nothing has been written yet.
    expect(saveStatusLabel('idle', null, 1000)).toBeNull()
  })

  it('reports saving, saved-with-age, and failure', () => {
    expect(saveStatusLabel('saving', null, 0)).toBe('Saving…')
    expect(saveStatusLabel('saved', 1000, 1000)).toBe('Saved · just now')
    expect(saveStatusLabel('saved', 0, 30_000)).toBe('Saved · 30s ago')
    expect(saveStatusLabel('error', 0, 0)).toBe('Not saved')
  })

  it('buckets the age coarsely — a ticking clock is noise', () => {
    expect(relativeSince(2_000)).toBe('just now')
    expect(relativeSince(45_000)).toBe('45s ago')
    expect(relativeSince(120_000)).toBe('2m ago')
    expect(relativeSince(7_200_000)).toBe('2h ago')
  })
})
