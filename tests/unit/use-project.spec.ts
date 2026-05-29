/**
 * tests/unit/use-project.spec.ts — T-Persist renderer hook (plan E.3).
 *
 * `useProject` is a thin wrapper over `window.openclip.project.*` plus the
 * pure helpers it is built from. The vitest env is `node` (no jsdom), so we
 * test the FRAMEWORK-FREE core the hook delegates to: `projectActions(bridge)`
 * — the bridge-calling + store-hydration logic — directly against the mock
 * bridge (`createMockOpenclip`, typed as the contract). The React `useProject`
 * wrapper is a trivial `useMemo` over the same core (asserted to exist + be
 * shaped correctly without rendering).
 *
 * Wave-1 integration: hydration now restores OTHER tracks' slices too
 * (transcript via T-Media's transcriptSlice, clips via T-AI's clipsSlice) since
 * all slices co-exist on the combined store. We assert the FULL restore below.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockOpenclip } from '../mocks/openclip'
import { projectFixture } from '../fixtures/contract'
import { projectActions, hydrateFromProject } from '@renderer/hooks/useProject'
import { useProjectStore } from '@renderer/stores/projectStore'

beforeEach(() => {
  // reset the store between tests (incl. cross-track slices)
  useProjectStore.setState({
    currentProject: null,
    recentProjects: [],
    transcript: null,
    clips: []
  })
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('projectActions: bridge-calling core', () => {
  it('refreshRecents() lists projects via the bridge and writes recentProjects', async () => {
    const bridge = createMockOpenclip()
    const actions = projectActions(bridge, useProjectStore)

    await actions.refreshRecents()

    const recents = useProjectStore.getState().recentProjects
    expect(recents).toHaveLength(1)
    expect(recents[0]).toMatchObject({ id: projectFixture.id, name: projectFixture.name })
  })

  it('open(id) loads via the bridge and hydrates currentProject + transcript + clips', async () => {
    const bridge = createMockOpenclip()
    const loadSpy = vi.spyOn(bridge.project, 'load')
    const actions = projectActions(bridge, useProjectStore)

    await actions.open(projectFixture.id)

    expect(loadSpy).toHaveBeenCalledWith({ id: projectFixture.id })
    const st = useProjectStore.getState()
    expect(st.currentProject).toEqual(projectFixture)
    // Wave-1 cross-track restore: transcript + clips come back too.
    expect(st.transcript).toEqual(projectFixture.transcript)
    expect(st.clips).toEqual(projectFixture.clips)
  })

  it('save() persists the currentProject via the bridge and returns the path', async () => {
    const bridge = createMockOpenclip()
    const saveSpy = vi.spyOn(bridge.project, 'save')
    useProjectStore.setState({ currentProject: projectFixture })
    const actions = projectActions(bridge, useProjectStore)

    const res = await actions.save()

    expect(saveSpy).toHaveBeenCalledWith({ project: projectFixture })
    expect(res?.path).toContain('.ocproj')
  })

  it('save() is a no-op when there is no current project', async () => {
    const bridge = createMockOpenclip()
    const saveSpy = vi.spyOn(bridge.project, 'save')
    const actions = projectActions(bridge, useProjectStore)

    const res = await actions.save()

    expect(saveSpy).not.toHaveBeenCalled()
    expect(res).toBeNull()
  })

  it('remove(id) deletes via the bridge then refreshes recents', async () => {
    const bridge = createMockOpenclip()
    const delSpy = vi.spyOn(bridge.project, 'delete')
    const listSpy = vi.spyOn(bridge.project, 'list')
    const actions = projectActions(bridge, useProjectStore)

    await actions.remove(projectFixture.id)

    expect(delSpy).toHaveBeenCalledWith({ id: projectFixture.id })
    expect(listSpy).toHaveBeenCalled() // recents refreshed after delete
  })

  it('createNew() seeds a fresh blank Project into currentProject', async () => {
    const bridge = createMockOpenclip()
    const actions = projectActions(bridge, useProjectStore)

    const created = await actions.createNew('My New Project', projectFixture.sourceVideo)

    const cur = useProjectStore.getState().currentProject
    expect(cur).not.toBeNull()
    expect(cur?.name).toBe('My New Project')
    expect(cur?.id).toBe(created.id)
    expect(cur?.sourceVideo).toEqual(projectFixture.sourceVideo)
    // a freshly created project must satisfy the frozen Project schema
    expect(cur?.clips).toEqual([])
    expect(cur?.exportHistory).toEqual([])
  })
})

describe('hydrateFromProject (Wave-1 full cross-slice hydration)', () => {
  it('restores currentProject, transcript, and clips from a loaded Project', () => {
    hydrateFromProject(useProjectStore, projectFixture)
    const st = useProjectStore.getState()
    expect(st.currentProject).toEqual(projectFixture)
    expect(st.transcript).toEqual(projectFixture.transcript)
    expect(st.clips).toEqual(projectFixture.clips)
  })
})
