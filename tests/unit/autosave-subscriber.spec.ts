/**
 * tests/unit/autosave-subscriber.spec.ts — Wave-1 integration cross-wiring.
 *
 * T-Persist shipped `createAutosave` (debounce; covered by project-store.spec.ts)
 * but with NO subscriber. The integration agent wired `startAutosave` to the
 * project store so edits autosave debounced through the bridge. This proves the
 * SUBSCRIBER: store edits to `currentProject` schedule a single coalesced save,
 * unrelated slice updates and project-close (→ null) do NOT save, and teardown
 * flushes a pending write.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startAutosave } from '@renderer/stores/projectStore/autosave'
import { useProjectStore } from '@renderer/stores/projectStore'
import { projectFixture } from '../fixtures/contract'

beforeEach(() => {
  vi.useFakeTimers()
  useProjectStore.setState({
    currentProject: null,
    recentProjects: [],
    transcript: null,
    clips: []
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('startAutosave: subscribe currentProject → debounced save', () => {
  it('coalesces rapid currentProject edits into a single save of the latest', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const stop = startAutosave(useProjectStore, save, 500)

    const v1 = { ...projectFixture, name: 'v1' }
    const v2 = { ...projectFixture, name: 'v2' }
    useProjectStore.getState().setCurrentProject(v1)
    useProjectStore.getState().setCurrentProject(v2)
    expect(save).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(500)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(v2)
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

  it('does not save when an unrelated slice changes (currentProject unchanged)', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    useProjectStore.setState({ currentProject: projectFixture })
    const stop = startAutosave(useProjectStore, save, 300)

    // touch a different slice — currentProject reference is unchanged
    useProjectStore.getState().setTranscriptSearch('hook')
    await vi.advanceTimersByTimeAsync(300)
    expect(save).not.toHaveBeenCalled()
    stop()
  })

  it('teardown flushes a pending save and unsubscribes', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const stop = startAutosave(useProjectStore, save, 1000)

    useProjectStore.getState().setCurrentProject(projectFixture)
    expect(save).not.toHaveBeenCalled() // still within the quiet window
    stop() // flushes the pending write
    await Promise.resolve()
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(projectFixture)

    // after teardown, further edits do NOT trigger saves (unsubscribed)
    useProjectStore.getState().setCurrentProject({ ...projectFixture, name: 'later' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(save).toHaveBeenCalledTimes(1)
  })
})
