// @vitest-environment jsdom
/**
 * tests/unit/clip-reject-undo.spec.tsx — Reject hides, it does not destroy
 * (FEAT-k28j7h).
 *
 * `rejectClip` was `clips.filter((c) => c.id !== id)` — the clip was spliced out
 * of the store and autosave persisted that ~800ms later. One misclick destroyed
 * an AI result permanently, and `grep -rn "window.confirm|AlertDialog"` over the
 * renderer returned nothing: there was not a single confirmation or undo path in
 * the app. Reject was doing double duty as both "hide" and "destroy".
 *
 * It also had NO test coverage of any kind (`grep -rn rejectClip tests/` → zero),
 * which is how it stayed that way.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import { installRendererEnv } from '../harness/renderer-env'
import { useProjectStore } from '@renderer/stores/projectStore'
import { partitionRejected } from '@renderer/components/clipView'
import { ClipSidebar } from '@renderer/components/ClipSidebar'
import { clipFixture } from '../fixtures/contract'
import type { Clip } from '@shared/schema'

const clip = (id: string, over: Partial<Clip> = {}): Clip => ({
  ...clipFixture,
  id,
  title: `Clip ${id}`,
  ...over
})

beforeEach(() => {
  installRendererEnv()
  useProjectStore.setState({ clips: [], selectedClipId: null, provisionalClips: [] })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('rejectClip: the clip survives', () => {
  it('marks it rejected instead of deleting it', () => {
    useProjectStore.setState({ clips: [clip('a'), clip('b')] })
    act(() => useProjectStore.getState().rejectClip('a'))

    const clips = useProjectStore.getState().clips
    // The whole point: still two clips, one of them merely hidden.
    expect(clips).toHaveLength(2)
    expect(clips.find((c) => c.id === 'a')!.status).toBe('rejected')
    expect(clips.find((c) => c.id === 'b')!.status).toBe(clipFixture.status)
  })

  it('restoreClip puts it back in the list', () => {
    useProjectStore.setState({ clips: [clip('a')] })
    act(() => useProjectStore.getState().rejectClip('a'))
    act(() => useProjectStore.getState().restoreClip('a'))
    expect(useProjectStore.getState().clips[0].status).toBe('suggested')
  })

  it('leaves other clips untouched', () => {
    useProjectStore.setState({ clips: [clip('a'), clip('b'), clip('c')] })
    act(() => useProjectStore.getState().rejectClip('b'))
    const { visible, hidden } = partitionRejected(useProjectStore.getState().clips)
    expect(visible.map((c) => c.id)).toEqual(['a', 'c'])
    expect(hidden.map((c) => c.id)).toEqual(['b'])
  })

  // EPIC-k83ghw / BUG-gasxqq: rejecting the SELECTED clip used to leave the
  // preview/timeline/export target pointed at it — it stays `find`-able by
  // id, only its status changes, so nothing downstream noticed the reject.
  describe('rejecting the SELECTED clip moves the selection', () => {
    it('to the next non-rejected clip', () => {
      useProjectStore.setState({ clips: [clip('a'), clip('b'), clip('c')], selectedClipId: 'b' })
      act(() => useProjectStore.getState().rejectClip('b'))
      expect(useProjectStore.getState().selectedClipId).toBe('c')
    })

    it('to the previous non-rejected clip when it was the last one', () => {
      useProjectStore.setState({ clips: [clip('a'), clip('b'), clip('c')], selectedClipId: 'c' })
      act(() => useProjectStore.getState().rejectClip('c'))
      expect(useProjectStore.getState().selectedClipId).toBe('b')
    })

    it('to null when it was the only clip', () => {
      useProjectStore.setState({ clips: [clip('a')], selectedClipId: 'a' })
      act(() => useProjectStore.getState().rejectClip('a'))
      expect(useProjectStore.getState().selectedClipId).toBeNull()
    })

    it('leaves an unrelated selection untouched', () => {
      useProjectStore.setState({ clips: [clip('a'), clip('b')], selectedClipId: 'a' })
      act(() => useProjectStore.getState().rejectClip('b'))
      expect(useProjectStore.getState().selectedClipId).toBe('a')
    })
  })
})

describe('ClipSidebar: hidden clips are one click away, not gone', () => {
  it('drops a rejected clip from the list but offers to show it', async () => {
    useProjectStore.setState({ clips: [clip('a'), clip('b', { status: 'rejected' })] })
    render(<ClipSidebar />)

    // Only the visible clip is listed, and the count reflects that.
    expect(screen.getByText('Clip a')).toBeTruthy()
    expect(screen.queryByText('Clip b')).toBeNull()
    expect(screen.getByTestId('hidden-clips-toggle').textContent).toMatch(/1 hidden/)
  })

  it('reveals the hidden clip on demand, with a way back', async () => {
    useProjectStore.setState({ clips: [clip('a'), clip('b', { status: 'rejected' })] })
    render(<ClipSidebar />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('hidden-clips-toggle'))
    })
    expect(screen.getByText('Clip b')).toBeTruthy()

    // And restoring it from there returns it to the main list.
    await act(async () => {
      fireEvent.click(screen.getAllByTestId('clip-restore')[0])
    })
    expect(useProjectStore.getState().clips.find((c) => c.id === 'b')!.status).toBe('suggested')
  })

  it('shows no hidden affordance when nothing is hidden', () => {
    useProjectStore.setState({ clips: [clip('a')] })
    render(<ClipSidebar />)
    expect(screen.queryByTestId('hidden-clips-toggle')).toBeNull()
  })

  it('still shows the empty state only when there are genuinely no clips', () => {
    // A project whose every clip is hidden is not an empty project — telling the
    // user to "run Auto Generate Clips" there would be actively misleading.
    useProjectStore.setState({ clips: [clip('a', { status: 'rejected' })] })
    render(<ClipSidebar />)
    expect(screen.queryByText(/No clips yet/)).toBeNull()
    expect(screen.getByTestId('hidden-clips-toggle')).toBeTruthy()
  })
})

describe('BrandKitEditor: delete is two-step', () => {
  it('does not delete on the first click, and can be cancelled', async () => {
    const bridge = installRendererEnv()
    const del = vi.fn(async () => ({ deleted: true }))
    bridge.brand.delete = del as unknown as typeof bridge.brand.delete

    const { BrandKitEditor } = await import('@renderer/components/BrandKitEditor')
    render(<BrandKitEditor />)

    // Select the first saved brand so the editor (and its Delete) is on screen.
    const chip = await screen.findByTestId('brand-chip')
    await act(async () => {
      fireEvent.click(chip)
    })

    await act(async () => {
      fireEvent.click(screen.getByTestId('brand-delete'))
    })
    // First click ARMS the confirm — a hand-built brand kit is not recoverable,
    // so this one asks rather than offering an undo after the fact.
    expect(del).not.toHaveBeenCalled()
    expect(screen.getByTestId('brand-delete-confirm')).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByTestId('brand-delete-cancel'))
    })
    expect(del).not.toHaveBeenCalled()
    expect(screen.queryByTestId('brand-delete-confirm')).toBeNull()
  })

  it('deletes on the confirming click', async () => {
    const bridge = installRendererEnv()
    const del = vi.fn(async () => ({ deleted: true }))
    bridge.brand.delete = del as unknown as typeof bridge.brand.delete

    const { BrandKitEditor } = await import('@renderer/components/BrandKitEditor')
    render(<BrandKitEditor />)
    const chip = await screen.findByTestId('brand-chip')
    await act(async () => {
      fireEvent.click(chip)
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('brand-delete'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('brand-delete-confirm'))
    })
    expect(del).toHaveBeenCalledTimes(1)
  })
})
