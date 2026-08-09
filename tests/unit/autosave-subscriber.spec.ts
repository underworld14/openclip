/**
 * tests/unit/autosave-subscriber.spec.ts — Wave-1 integration cross-wiring +
 * the persistence-cluster fix (openclip-f3d/3y8/9i7/gcz).
 *
 * T-Persist shipped `createAutosave` (debounce; covered by project-store.spec.ts)
 * but with NO subscriber. The integration agent wired `startAutosave` to the
 * project store so edits autosave debounced through the bridge. The cluster fix
 * BROADENS the trigger: clip/transcript/exportHistory edits live in SIBLING
 * slices, so a save fired only on `currentProject` reference changes would
 * persist stale clips/transcript/history. `startAutosave` now fires on ANY of
 * `currentProject | clips | transcript | exportHistory` changing, and saves the
 * COMPOSED project (live slices layered over the document).
 *
 * This proves: composed-payload saves, the new clip/transcript/exportHistory
 * triggers, transient-slice + project-close NON-saves, teardown flush, and that
 * a rejected save routes to `onError` (gcz) instead of an unhandled rejection.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startAutosave } from '@renderer/stores/projectStore/autosave'
import { useProjectStore } from '@renderer/stores/projectStore'
import {
  projectFixture,
  clipsFixture,
  transcriptFixture,
  exportRecordFixture
} from '../fixtures/contract'

beforeEach(() => {
  vi.useFakeTimers()
  useProjectStore.setState({
    currentProject: null,
    recentProjects: [],
    transcript: null,
    transcriptSearch: '',
    clips: [],
    exportHistory: []
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('startAutosave: subscribe project edits → debounced COMPOSED save', () => {
  it('coalesces rapid currentProject edits into a single save of the latest composed project', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const stop = startAutosave(useProjectStore, save, 500)

    const v1 = { ...projectFixture, name: 'v1' }
    const v2 = { ...projectFixture, name: 'v2' }
    useProjectStore.getState().setCurrentProject(v1)
    useProjectStore.getState().setCurrentProject(v2)
    expect(save).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(500)
    expect(save).toHaveBeenCalledTimes(1)
    // The saved payload is the COMPOSED project: live clips/transcript layered
    // over the latest document. With empty live slices it equals v2 with []/null
    // overrides — assert the load-bearing fields.
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: v2.id, name: 'v2' }))
    stop()
  })

  it('saves a COMPOSED project: approving a clip (sibling slice) persists status:approved', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    // Seed the project + a suggested clip in the clips slice (sibling of currentProject).
    const clip = { ...clipsFixture[0], id: 'clip-x', status: 'suggested' as const }
    useProjectStore.setState({
      currentProject: { ...projectFixture, clips: [] },
      clips: [clip],
      transcript: transcriptFixture
    })
    const stop = startAutosave(useProjectStore, save, 300)

    useProjectStore.getState().approveClip('clip-x')
    await vi.advanceTimersByTimeAsync(300)

    expect(save).toHaveBeenCalledTimes(1)
    const saved = save.mock.calls[0][0]
    expect(saved.clips).toHaveLength(1)
    expect(saved.clips[0]).toMatchObject({ id: 'clip-x', status: 'approved' })
    stop()
  })

  it('saves when the transcript slice changes (setTranscript)', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    useProjectStore.setState({ currentProject: projectFixture })
    const stop = startAutosave(useProjectStore, save, 300)

    const t = { ...transcriptFixture, language: 'es' }
    useProjectStore.getState().setTranscript(t)
    await vi.advanceTimersByTimeAsync(300)

    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0].transcript).toMatchObject({ language: 'es' })
    stop()
  })

  it('saves when the exportHistory slice changes (addExportRecord → history merge)', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    useProjectStore.setState({ currentProject: { ...projectFixture, exportHistory: [] } })
    const stop = startAutosave(useProjectStore, save, 300)

    useProjectStore.getState().addExportRecord(exportRecordFixture)
    await vi.advanceTimersByTimeAsync(300)

    expect(save).toHaveBeenCalledTimes(1)
    // The composed project must carry the LIVE export history, not the stale [].
    expect(save.mock.calls[0][0].exportHistory).toEqual([exportRecordFixture])
    stop()
  })

  it('does not save on a project close (currentProject → null)', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const stop = startAutosave(useProjectStore, save, 300)

    useProjectStore.getState().setCurrentProject(null)
    await vi.advanceTimersByTimeAsync(300)
    expect(save).not.toHaveBeenCalled()
    stop()
  })

  it('does not save when a TRANSIENT slice changes (setTranscriptSearch)', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    useProjectStore.setState({ currentProject: projectFixture })
    const stop = startAutosave(useProjectStore, save, 300)

    // search is a transient slice (not one of the 4 trigger refs) — must NOT save
    useProjectStore.getState().setTranscriptSearch('hook')
    await vi.advanceTimersByTimeAsync(300)
    expect(save).not.toHaveBeenCalled()
    stop()
  })

  it('teardown flushes a pending COMPOSED save and unsubscribes', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const stop = startAutosave(useProjectStore, save, 1000)

    useProjectStore.getState().setCurrentProject(projectFixture)
    expect(save).not.toHaveBeenCalled() // still within the quiet window
    stop() // flushes the pending write
    await Promise.resolve()
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: projectFixture.id }))

    // after teardown, further edits do NOT trigger saves (unsubscribed)
    useProjectStore.getState().setCurrentProject({ ...projectFixture, name: 'later' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('routes a rejected save to onError instead of an unhandled rejection (gcz)', async () => {
    const err = new Error('disk full')
    const save = vi.fn().mockRejectedValue(err)
    const onError = vi.fn()
    const stop = startAutosave(useProjectStore, save, 200, onError)

    useProjectStore.getState().setCurrentProject(projectFixture)
    await vi.advanceTimersByTimeAsync(200)
    await Promise.resolve()

    expect(save).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(err)
    stop()
  })
})

/**
 * Suspension (FEAT-ky1jfw). The project is now committed at PROBE time, so a
 * running transcription streams partials into an OPEN project — and `transcript`
 * is one of the four refs that trigger a save. Without a suspension a ten-minute
 * transcription would write the whole growing `.ocproj` every debounce window,
 * hundreds of times, for data the terminal `hydrateTranscript` replaces wholesale.
 */
describe('startAutosave: suspension while a job streams into the open project', () => {
  it('writes nothing while suspended, however many edits land', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    let suspended = true
    const stop = startAutosave(useProjectStore, save, 200, undefined, {
      isSuspended: () => suspended
    })

    useProjectStore.getState().setCurrentProject(projectFixture)
    for (let i = 0; i < 50; i += 1) {
      useProjectStore.getState().appendTranscriptPartial({ words: [], segments: [] })
      await vi.advanceTimersByTimeAsync(200)
    }
    expect(save).not.toHaveBeenCalled()

    suspended = false
    stop()
  })

  it('writes exactly once when the suspension lifts', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    let suspended = true
    const stop = startAutosave(useProjectStore, save, 200, undefined, {
      isSuspended: () => suspended
    })

    useProjectStore.getState().setCurrentProject(projectFixture)
    useProjectStore.getState().hydrateTranscript(transcriptFixture)
    await vi.advanceTimersByTimeAsync(200)
    expect(save).not.toHaveBeenCalled()

    // The import settles: the finished transcript must reach disk. This is the
    // one write that actually matters, and it is the one the suspension would
    // otherwise swallow.
    suspended = false
    stop.resume()
    await vi.advanceTimersByTimeAsync(200)

    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0].transcript.segments).toEqual(transcriptFixture.segments)
    stop()
  })

  it('does not write on resume when nothing was swallowed', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const stop = startAutosave(useProjectStore, save, 200, undefined, {
      isSuspended: () => true
    })

    stop.resume()
    await vi.advanceTimersByTimeAsync(200)
    expect(save).not.toHaveBeenCalled()
    stop()
  })

  it('saves normally when no suspension predicate is supplied', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const stop = startAutosave(useProjectStore, save, 200)

    useProjectStore.getState().setCurrentProject(projectFixture)
    await vi.advanceTimersByTimeAsync(200)
    expect(save).toHaveBeenCalledTimes(1)
    stop()
  })
})
