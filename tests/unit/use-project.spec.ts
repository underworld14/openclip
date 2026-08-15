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
import { projectFixture, clipFixture, transcriptFixture } from '../fixtures/contract'
import {
  projectActions,
  hydrateFromProject,
  closeProject,
  regeneratePosterFrames
} from '@renderer/hooks/useProject'
import { useProjectStore } from '@renderer/stores/projectStore'

beforeEach(() => {
  // reset the store between tests (incl. cross-track slices)
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
    // thumbnailPath is stripped on hydrate (BUG-08sb0x) — a temp-cache path
    // surviving in the loaded document is no proof the file still exists —
    // and open() fires (and, in this mock, already completes by the time
    // control returns here) regeneratePosterFrames to fill a fresh one in.
    expect(st.clips[0].thumbnailPath).toBe('/tmp/openclip/p1/cache/thumb-regenerated.jpg')
  })

  it('save() persists the COMPOSED project (LIVE slices), not the stale currentProject', async () => {
    const bridge = createMockOpenclip()
    const saveSpy = vi.spyOn(bridge.project, 'save')
    // Open a project whose persisted clips/transcript are STALE, then diverge the
    // live slices. save() must persist the live clips/transcript, not the snapshot.
    const liveClip = { ...clipFixture, id: 'live', title: 'LIVE CLIP' }
    const liveTranscript = { ...transcriptFixture, language: 'es' }
    useProjectStore.setState({
      currentProject: {
        ...projectFixture,
        clips: [{ ...clipFixture, id: 'stale', title: 'STALE CLIP' }]
      },
      clips: [liveClip],
      transcript: liveTranscript
    })
    const actions = projectActions(bridge, useProjectStore)

    const res = await actions.save()

    expect(saveSpy).toHaveBeenCalledTimes(1)
    const savedProject = saveSpy.mock.calls[0][0].project
    expect(savedProject.clips).toHaveLength(1)
    expect(savedProject.clips[0]).toMatchObject({ id: 'live', title: 'LIVE CLIP' })
    expect(savedProject.transcript).toMatchObject({ language: 'es' })
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
  const exportRecord = {
    id: 'er-1',
    clipId: 'clip-1',
    outputPath: '/tmp/out.mp4',
    exportedAt: 1,
    width: 1080,
    height: 1920,
    format: 'mp4'
  }

  it('restores currentProject, transcript, and clips from a loaded Project', () => {
    hydrateFromProject(useProjectStore, projectFixture)
    const st = useProjectStore.getState()
    expect(st.currentProject).toEqual(projectFixture)
    expect(st.transcript).toEqual(projectFixture.transcript)
    // thumbnailPath is stripped on hydrate (BUG-08sb0x) — see the dedicated
    // describe block below; `currentProject` itself (what a save persists)
    // still carries the original path, only the live `clips` slice is bare.
    expect(st.clips).toEqual(projectFixture.clips.map((c) => ({ ...c, thumbnailPath: undefined })))
  })

  it("hydrates exportHistory so an opened project's records survive compose/save", () => {
    // Regression: composeProject() reads exportHistory from the slice, so without
    // hydrating it on open the next save would persist [] over the real history.
    hydrateFromProject(useProjectStore, { ...projectFixture, exportHistory: [exportRecord] })
    expect(useProjectStore.getState().exportHistory).toEqual([exportRecord])
    expect(useProjectStore.getState().composeProject()?.exportHistory).toEqual([exportRecord])
  })

  it('resets exportHistory across project switches (no cross-project leak)', () => {
    hydrateFromProject(useProjectStore, { ...projectFixture, exportHistory: [exportRecord] })
    // open a different project with no export history — the singleton slice must reset
    hydrateFromProject(useProjectStore, { ...projectFixture, id: 'p2', exportHistory: [] })
    expect(useProjectStore.getState().composeProject()?.exportHistory).toEqual([])
  })

  it('clears a stale clip selection so it cannot point at the previous project (BUG-2hjt1x)', () => {
    // selectedClipId is a store singleton and was never reset anywhere. Opening a
    // different project left the selection pointing at a clip id that no longer
    // exists, which drives PreviewPlayer/Timeline off a dangling reference.
    useProjectStore.setState({ selectedClipId: 'clip-from-the-previous-project' })

    hydrateFromProject(useProjectStore, { ...projectFixture, id: 'p2' })

    expect(useProjectStore.getState().selectedClipId).toBeNull()
  })

  it('restores the saved reframe mode instead of always resetting to off (EPIC-k83ghw / BUG-8kgcxs)', () => {
    // reframeMode used to be previewSlice-only, transient state — a project
    // saved with "Follow speaker" silently reopened on plain centre-crop.
    hydrateFromProject(useProjectStore, {
      ...projectFixture,
      settings: { ...projectFixture.settings, reframeMode: 'auto' }
    })
    expect(useProjectStore.getState().reframeMode).toBe('auto')
  })

  it('defaults to off for a project that never had the field (pre-existing .ocproj)', () => {
    // projectFixture.settings carries no reframeMode key at all — exactly what
    // a `.ocproj` written before this field existed looks like.
    hydrateFromProject(useProjectStore, projectFixture)
    expect(useProjectStore.getState().reframeMode).toBe('off')
  })

  it('resets reframeMode across project switches (no cross-project leak, singleton slice)', () => {
    hydrateFromProject(useProjectStore, {
      ...projectFixture,
      settings: { ...projectFixture.settings, reframeMode: 'split' }
    })
    expect(useProjectStore.getState().reframeMode).toBe('split')
    hydrateFromProject(useProjectStore, { ...projectFixture, id: 'p2' }) // no reframeMode saved
    expect(useProjectStore.getState().reframeMode).toBe('off')
  })
})

describe('hydrateFromProject + regeneratePosterFrames (BUG-08sb0x)', () => {
  it('hydrate strips thumbnailPath in memory WITHOUT touching the loaded Project object', () => {
    hydrateFromProject(useProjectStore, projectFixture)
    expect(useProjectStore.getState().clips[0].thumbnailPath).toBeUndefined()
    // The fixture itself (what a save would persist) is untouched.
    expect(projectFixture.clips[0].thumbnailPath).toBe('/tmp/openclip/thumb-1.jpg')
  })

  it('regeneratePosterFrames fills a fresh path back in per clip', async () => {
    const bridge = createMockOpenclip()
    const thumbSpy = vi.spyOn(bridge.video, 'clipThumbnail')
    hydrateFromProject(useProjectStore, projectFixture)
    expect(useProjectStore.getState().clips[0].thumbnailPath).toBeUndefined()

    await regeneratePosterFrames(bridge, useProjectStore, projectFixture)

    expect(thumbSpy).toHaveBeenCalledWith({
      projectId: projectFixture.id,
      clipId: clipFixture.id,
      sourcePath: projectFixture.sourceVideo.path,
      atTime: clipFixture.editedStart,
      aspectRatio: projectFixture.settings.aspectRatio
    })
    expect(useProjectStore.getState().clips[0].thumbnailPath).toBe(
      '/tmp/openclip/p1/cache/thumb-regenerated.jpg'
    )
  })

  it('a failed grab is best-effort — leaves that clip without a thumbnail, does not throw', async () => {
    const bridge = createMockOpenclip()
    vi.spyOn(bridge.video, 'clipThumbnail').mockRejectedValue(new Error('ffmpeg exited 1'))
    hydrateFromProject(useProjectStore, projectFixture)

    await expect(
      regeneratePosterFrames(bridge, useProjectStore, projectFixture)
    ).resolves.toBeUndefined()
    expect(useProjectStore.getState().clips[0].thumbnailPath).toBeUndefined()
  })

  it('bails out once the user has switched away mid-regeneration (no cross-project stomp)', async () => {
    const bridge = createMockOpenclip()
    const twoClips = {
      ...projectFixture,
      clips: [clipFixture, { ...clipFixture, id: 'clip-2' }]
    }
    let resolveFirst: (v: { thumbnailPath: string }) => void = () => {}
    const firstCall = new Promise<{ thumbnailPath: string }>((r) => {
      resolveFirst = r
    })
    const thumbSpy = vi
      .spyOn(bridge.video, 'clipThumbnail')
      .mockImplementationOnce(() => firstCall)
      .mockResolvedValue({ thumbnailPath: '/should/never/be/reached.jpg' })
    hydrateFromProject(useProjectStore, twoClips)

    const pending = regeneratePosterFrames(bridge, useProjectStore, twoClips)
    // The user closes the project WHILE clip-1's grab is still in flight.
    closeProject(useProjectStore)
    resolveFirst({ thumbnailPath: '/tmp/openclip/p1/cache/thumb-regenerated.jpg' })
    await pending

    // Only clip-1's (already in-flight) call happened — never clip-2's.
    expect(thumbSpy).toHaveBeenCalledTimes(1)
    // closeProject's [] survives untouched — no stale write after the switch.
    expect(useProjectStore.getState().clips).toEqual([])
  })
})

describe('closeProject (EPIC-k83ghw / BUG-tdgtfb, BUG-8kgcxs)', () => {
  it('clears every slice hydrateFromProject would otherwise leave behind', () => {
    hydrateFromProject(useProjectStore, {
      ...projectFixture,
      settings: { ...projectFixture.settings, reframeMode: 'auto' }
    })
    useProjectStore.setState({ selectedClipId: projectFixture.clips[0]?.id ?? null })

    closeProject(useProjectStore)

    const st = useProjectStore.getState()
    expect(st.currentProject).toBeNull()
    expect(st.transcript).toBeNull()
    expect(st.clips).toEqual([])
    expect(st.exportHistory).toEqual([])
    expect(st.selectedClipId).toBeNull()
    // Otherwise a subsequent "New Project" inherited the closed project's mode.
    expect(st.reframeMode).toBe('off')
  })
})
