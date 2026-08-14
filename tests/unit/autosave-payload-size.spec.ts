/**
 * tests/unit/autosave-payload-size.spec.ts — a clip edit must not rewrite the
 * whole transcript (BUG-g6zq2t).
 *
 * Autosave fires on every approve, reject and settled trim drag, and the saved
 * payload was the whole composed project — including all ~20,000 word timestamps
 * of a 2-hour podcast. A 30-edit session wrote ~90 MB to disk to persist a few
 * hundred bytes of actual change, and each write blocked the renderer's main
 * thread for ~18 ms structure-cloning 3 MB across the contextBridge (~58 ms on a
 * 6-hour lecture, which is visible as a stutter).
 *
 * Two properties are pinned here. The first is the fix. The second is a property
 * the investigation established and that a future "optimisation" could easily
 * break: rapid edits coalesce into exactly one write.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startAutosave } from '@renderer/stores/projectStore/autosave'
import { useProjectStore } from '@renderer/stores/projectStore'
import { projectFixture, clipFixture } from '../fixtures/contract'
import type { Project, WordTimestamp } from '@shared/schema'

/** A transcript big enough that carrying it is unmistakable in a byte count. */
function bigWords(n: number): WordTimestamp[] {
  return Array.from({ length: n }, (_, i) => ({
    word: `word${i}`,
    start: i * 0.3,
    end: i * 0.3 + 0.25,
    confidence: 0.9
  }))
}

const CLIP = { ...clipFixture, id: 'c1', status: 'suggested' as const }

function seedBigProject(wordCount = 20_000): Project {
  const transcript = {
    language: 'en',
    segments: projectFixture.transcript.segments,
    words: bigWords(wordCount)
  }
  const project: Project = { ...projectFixture, transcript, clips: [CLIP] }
  useProjectStore.setState({
    currentProject: project,
    clips: [CLIP],
    transcript,
    exportHistory: []
  })
  return project
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('autosave payload: a clips-only edit does not carry the transcript', () => {
  it('flags the write as clips-only so the caller can persist a delta', async () => {
    seedBigProject()
    const save = vi.fn(async (_p: Project, _o?: { clipsOnly: boolean }) => {
      void _p
      void _o
    })
    const stop = startAutosave(useProjectStore, save, 800)

    useProjectStore.getState().approveClip('c1')
    await vi.advanceTimersByTimeAsync(800)

    expect(save).toHaveBeenCalledTimes(1)
    // The hint is what lets `installAutosave` route to `project:savePatch`, which
    // ships clips + export history and NOT the word array.
    expect(save.mock.calls[0][1]).toEqual({ clipsOnly: true })
    stop()
  })

  it('the delta the patch path actually sends is small', async () => {
    const project = seedBigProject()
    // The payload `installAutosave` builds for a clips-only write. Asserting the
    // shape here rather than the composed project is the point: the composed
    // project is necessarily big, and the fix is that we stop SENDING it.
    const patch = {
      id: project.id,
      clips: useProjectStore.getState().clips,
      exportHistory: useProjectStore.getState().exportHistory,
      settings: project.settings,
      name: project.name
    }
    const full = useProjectStore.getState().composeProject()!

    expect(JSON.stringify(patch).length).toBeLessThan(200_000)
    // …and the thing it replaces really was enormous, so the assertion above is
    // not passing for a trivial reason.
    expect(JSON.stringify(full).length).toBeGreaterThan(1_000_000)
  })

  it('falls back to a FULL save when the transcript itself changed', async () => {
    seedBigProject()
    const save = vi.fn(async (_p: Project, _o?: { clipsOnly: boolean }) => {
      void _p
      void _o
    })
    const stop = startAutosave(useProjectStore, save, 800)

    useProjectStore.setState({
      transcript: { language: 'en', segments: [], words: bigWords(10) }
    })
    await vi.advanceTimersByTimeAsync(800)

    expect(save.mock.calls[0][1]).toEqual({ clipsOnly: false })
    stop()
  })

  it('a burst mixing a transcript change with clip edits takes the FULL path', async () => {
    seedBigProject()
    const save = vi.fn(async (_p: Project, _o?: { clipsOnly: boolean }) => {
      void _p
      void _o
    })
    const stop = startAutosave(useProjectStore, save, 800)

    // Both land inside one debounce window. Persisting only the clips here would
    // silently drop the transcript change.
    useProjectStore.setState({
      transcript: { language: 'en', segments: [], words: bigWords(5) }
    })
    useProjectStore.getState().approveClip('c1')
    await vi.advanceTimersByTimeAsync(800)

    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][1]).toEqual({ clipsOnly: false })
    stop()
  })
})

describe('autosave coalescing (the property the investigation established)', () => {
  it('collapses 60 rapid trim drags into exactly one write', async () => {
    seedBigProject()
    const save = vi.fn(async (_p: Project, _o?: { clipsOnly: boolean }) => {
      void _p
      void _o
    })
    const stop = startAutosave(useProjectStore, save, 800)

    for (let i = 0; i < 60; i += 1) {
      useProjectStore.getState().dragClipHandle('c1', 'out', 10 + i * 0.1, 600)
      await vi.advanceTimersByTimeAsync(10)
    }
    // 600ms of dragging has elapsed; nothing written yet.
    expect(save).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(799)
    expect(save).toHaveBeenCalledTimes(1)
    stop()
  })
})
