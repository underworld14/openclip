/**
 * tests/unit/import-controller.spec.ts — the framework-free import-controller core
 * (G.4). Drives the consent gate, model gate, progress banding, and the G.3
 * re-import flush with every seam injected — no React/jsdom, pure node vitest.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  createImportController,
  CONSENT_KEY,
  type ImportControllerDeps,
  type ImportControllerStore
} from '@renderer/hooks/import-controller'
import type { Project, SourceVideo } from '@shared/schema'

function fakeStorage(initial: Record<string, string> = {}): {
  getItem(k: string): string | null
  setItem(k: string, v: string): void
  map: Map<string, string>
} {
  const map = new Map(Object.entries(initial))
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v)
  }
}

const SOURCE: SourceVideo = {
  path: '/dl/v.mp4',
  duration: 100,
  resolution: { width: 1920, height: 1080 },
  fps: 30,
  format: 'mp4'
}

function fakeProject(id: string, name = 'p'): Project {
  return {
    id,
    name,
    createdAt: 0,
    updatedAt: 0,
    sourceVideo: SOURCE,
    transcript: { language: '', segments: [], words: [] },
    clips: [],
    // settings is irrelevant to the controller; cast to keep the fixture small.
    settings: {} as Project['settings'],
    exportHistory: []
  }
}

/** Build a controller with sensible fakes; override per test. */
function build(overrides: Partial<ImportControllerDeps> = {}): {
  ctl: ReturnType<typeof createImportController>
  setCurrentProject: ReturnType<typeof vi.fn>
  saveProject: ReturnType<typeof vi.fn>
  runImportPipeline: ReturnType<typeof vi.fn>
  runUrlDownload: ReturnType<typeof vi.fn>
  adoptSource: ReturnType<typeof vi.fn>
  reclaimMedia: ReturnType<typeof vi.fn>
  cancelJob: ReturnType<typeof vi.fn>
  onNeedModel: ReturnType<typeof vi.fn>
  pcts: number[]
  storage: ReturnType<typeof fakeStorage>
} {
  const setCurrentProject = vi.fn()
  const saveProject = vi.fn(async () => {})
  const onNeedModel = vi.fn()
  const storage = (overrides.storage as ReturnType<typeof fakeStorage>) ?? fakeStorage()

  let current: Project | null = null
  const store: ImportControllerStore = {
    getCurrentProject: () => current,
    setCurrentProject: (p) => {
      current = p
      setCurrentProject(p)
    },
    appendTranscriptPartial: vi.fn(),
    hydrateTranscript: vi.fn(),
    saveProject
  }

  const runImportPipeline = vi.fn(
    async (o: {
      onProgress?: (p: number, s: string) => void
      onTranscript?: (t: unknown) => void
    }) => {
      o.onProgress?.(0, 'probing')
      o.onProgress?.(100, 'done')
      o.onTranscript?.({ language: 'en', segments: [], words: [] })
      return {
        sourceVideo: SOURCE,
        wavPath: '/w.wav',
        transcript: { language: 'en', segments: [], words: [] }
      }
    }
  )

  const runUrlDownload = vi.fn(async (o: { onProgress?: (p: number, s: string) => void }) => {
    o.onProgress?.(50, 'downloading')
    o.onProgress?.(100, 'downloaded')
    return { filePath: '/dl/v.mp4', title: 'Real Video Title', bytes: 1234 }
  })

  const adoptSource = vi.fn(async (_pid: string, fp: string) => ({
    path: `/media/PID/${fp.split('/').pop()}`
  }))

  const reclaimMedia = vi.fn(async (): Promise<void> => {})
  const cancelJob = vi.fn(async (): Promise<void> => {})

  const ctl = createImportController({
    bridge: {
      model: { status: async () => [{ model: 'base', installed: true }] },
      jobs: { cancel: cancelJob }
    } as unknown as ImportControllerDeps['bridge'],
    store,
    createBlankProject: (name, sv) => ({ ...fakeProject('blank-internal', name), sourceVideo: sv }),
    genId: () => 'PID',
    storage,
    onNeedModel,
    adoptSource,
    reclaimMedia,
    runImportPipeline: runImportPipeline as unknown as ImportControllerDeps['runImportPipeline'],
    runUrlDownload: runUrlDownload as unknown as ImportControllerDeps['runUrlDownload'],
    ...overrides
  })

  const pcts: number[] = []
  ctl.subscribe(() => pcts.push(ctl.getState().pct))

  return {
    ctl,
    setCurrentProject,
    saveProject,
    runImportPipeline,
    runUrlDownload,
    adoptSource,
    reclaimMedia,
    cancelJob,
    onNeedModel,
    pcts,
    storage
  }
}

describe('import-controller: consent gate (PRD §20.4)', () => {
  it('blocks the first URL import behind consent and starts NO download', async () => {
    const { ctl, runUrlDownload } = build({ storage: fakeStorage() })
    await ctl.importUrl('https://youtu.be/M5XbNdzPuDQ')
    expect(ctl.getState().needsConsent).toBe(true)
    expect(ctl.getState().busy).toBe(false)
    expect(runUrlDownload).not.toHaveBeenCalled()
  })

  it('acceptConsent persists the flag and resumes the pending download exactly once', async () => {
    const storage = fakeStorage()
    const { ctl, runUrlDownload } = build({ storage })
    await ctl.importUrl('https://youtu.be/M5XbNdzPuDQ')
    ctl.acceptConsent()
    // acceptConsent kicks off importUrl asynchronously; let microtasks drain.
    await new Promise((r) => setTimeout(r, 0))
    expect(storage.map.get(CONSENT_KEY)).toBe('1')
    expect(ctl.getState().needsConsent).toBe(false)
    expect(runUrlDownload).toHaveBeenCalledTimes(1)
  })

  it('declineConsent clears state and starts nothing', async () => {
    const { ctl, runUrlDownload } = build({ storage: fakeStorage() })
    await ctl.importUrl('https://youtu.be/x')
    ctl.declineConsent()
    expect(ctl.getState().needsConsent).toBe(false)
    expect(runUrlDownload).not.toHaveBeenCalled()
  })

  it('skips the gate once consent is already granted', async () => {
    const { ctl, runUrlDownload } = build({ storage: fakeStorage({ [CONSENT_KEY]: '1' }) })
    await ctl.importUrl('https://youtu.be/x')
    expect(ctl.getState().needsConsent).toBe(false)
    expect(runUrlDownload).toHaveBeenCalledTimes(1)
  })
})

describe('import-controller: model gate (PRD §13)', () => {
  it('calls onNeedModel and leaves busy=false when the model is absent (no pipeline)', async () => {
    const onNeedModel = vi.fn()
    const { ctl, runImportPipeline } = build({
      onNeedModel,
      bridge: {
        model: { status: async () => [{ model: 'base', installed: false }] }
      } as unknown as ImportControllerDeps['bridge']
    })
    await ctl.importFile('/movies/a.mp4')
    expect(onNeedModel).toHaveBeenCalledWith('base')
    expect(ctl.getState().busy).toBe(false)
    expect(runImportPipeline).not.toHaveBeenCalled()
  })
})

describe('import-controller: progress banding', () => {
  it('keeps URL download in the 0..20 band, then the pipeline in 20..100', async () => {
    const { ctl, pcts } = build({ storage: fakeStorage({ [CONSENT_KEY]: '1' }) })
    await ctl.importUrl('https://youtu.be/x')
    // Download (pct 50→ scaled 10, 100→20) must never exceed 20.
    const downloadBand = pcts.filter((p) => p <= 20)
    expect(downloadBand).toContain(10)
    expect(downloadBand).toContain(20)
    // Pipeline then scales 0..100 into 20..100 → reaches 100, never below 20 after.
    expect(Math.max(...pcts)).toBe(100)
    expect(pcts.every((p) => p >= 0 && p <= 100)).toBe(true)
  })

  it('file import bands the pipeline across the full 0..100', async () => {
    const { ctl, pcts } = build()
    await ctl.importFile('/movies/a.mp4')
    expect(Math.max(...pcts)).toBe(100)
  })
})

describe('import-controller: re-import data integrity (G.3)', () => {
  it('flush-saves the COMPOSED open project (live clips) BEFORE replacing it', async () => {
    const existing = fakeProject('OLD-ID', 'Old Project') // raw doc: clips: []
    // The live clips slice has an approved clip that is NOT on the raw currentProject
    // (clips live in their own slice — currentProject.clips is stale). composeProject
    // is what carries them; the flush MUST save that, not the raw doc.
    const composed: Project = {
      ...existing,
      clips: [{ id: 'c1', status: 'approved' } as unknown as Project['clips'][number]]
    }
    const order: string[] = []
    const saved: Project[] = []
    const saveProject = vi.fn(async (p: Project) => {
      saved.push(p)
      order.push(`save:${p.id}`)
    })
    const setCurrentProject = vi.fn((p: Project) => {
      order.push(`set:${p.id}`)
    })
    let current: Project | null = existing
    const store: ImportControllerStore = {
      getCurrentProject: () => current,
      composeProject: () => (current ? composed : null),
      setCurrentProject: (p) => {
        current = p
        setCurrentProject(p)
      },
      appendTranscriptPartial: vi.fn(),
      hydrateTranscript: vi.fn(),
      saveProject
    }
    const { ctl } = build({ store } as Partial<ImportControllerDeps>)
    await ctl.importFile('/movies/new.mp4')

    // The open project is saved first (with its LIVE clips), then the NEW project
    // (fresh id) is set — never a silent clobber/orphan, never stale empty clips.
    expect(order).toEqual(['save:OLD-ID', 'set:PID'])
    expect(saved[0].id).toBe('OLD-ID')
    expect(saved[0].clips).toHaveLength(1) // composed live clips, not the raw []
  })

  it('does not flush-save when there is no open project', async () => {
    const { ctl, saveProject, setCurrentProject } = build()
    await ctl.importFile('/movies/first.mp4')
    expect(saveProject).not.toHaveBeenCalled()
    expect(setCurrentProject).toHaveBeenCalledWith(expect.objectContaining({ id: 'PID' }))
  })
})

describe('import-controller: managed media adoption (Part H)', () => {
  it('URL import adopts the download into media and marks the source app-owned', async () => {
    const { ctl, adoptSource, setCurrentProject, runImportPipeline } = build({
      storage: fakeStorage({ [CONSENT_KEY]: '1' })
    })
    await ctl.importUrl('https://youtu.be/x')

    // Adopt is called with the new project id + the downloaded path, BEFORE the
    // pipeline runs on the adopted path.
    expect(adoptSource).toHaveBeenCalledWith('PID', '/dl/v.mp4')
    expect(runImportPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/media/PID/v.mp4' })
    )
    const project = setCurrentProject.mock.calls.at(-1)?.[0]
    expect(project.sourceVideo.path).toBe('/media/PID/v.mp4')
    expect(project.sourceVideo.appOwned).toBe(true)
  })

  it('file import does NOT adopt and the source is not app-owned', async () => {
    const { ctl, adoptSource, setCurrentProject } = build()
    await ctl.importFile('/Users/me/Movies/original.mp4')
    expect(adoptSource).not.toHaveBeenCalled()
    const project = setCurrentProject.mock.calls.at(-1)?.[0]
    expect(project.sourceVideo.path).toBe('/Users/me/Movies/original.mp4')
    expect(project.sourceVideo.appOwned).toBe(false)
  })

  it('reclaims the adopted media when an app-owned import fails after adopt (openclip-e5s)', async () => {
    const { ctl, adoptSource, reclaimMedia } = build({
      storage: fakeStorage({ [CONSENT_KEY]: '1' }),
      runImportPipeline: vi.fn(async () => {
        throw new Error('transcribe failed')
      }) as unknown as ImportControllerDeps['runImportPipeline']
    })
    await ctl.importUrl('https://youtu.be/x')
    // The download was adopted into persistent media before the (failing) pipeline; the
    // orphan dir must be reclaimed now, not left for the next-launch sweep.
    expect(adoptSource).toHaveBeenCalledWith('PID', '/dl/v.mp4')
    expect(reclaimMedia).toHaveBeenCalledWith('PID')
    expect(ctl.getState().error).toBeTruthy()
  })

  it('does NOT reclaim media when a (non-app-owned) file import fails (openclip-e5s)', async () => {
    const { ctl, reclaimMedia } = build({
      runImportPipeline: vi.fn(async () => {
        throw new Error('transcribe failed')
      }) as unknown as ImportControllerDeps['runImportPipeline']
    })
    await ctl.importFile('/Users/me/Movies/original.mp4')
    expect(reclaimMedia).not.toHaveBeenCalled()
  })

  it('cancel() aborts the in-flight job via the bridge (openclip-2bm)', async () => {
    let release: (v: { filePath: string; title: string; bytes: number }) => void = () => {}
    const runUrlDownload = vi.fn((o: { onStart?: (id: string) => void }) => {
      o.onStart?.('DL-JOB-1') // the controller records this as the active job
      return new Promise((r) => {
        release = r as typeof release
      })
    })
    const { ctl, cancelJob } = build({
      storage: fakeStorage({ [CONSENT_KEY]: '1' }),
      runUrlDownload: runUrlDownload as unknown as ImportControllerDeps['runUrlDownload']
    })
    const importing = ctl.importUrl('https://youtu.be/x')
    await Promise.resolve() // let ensureModel + onStart fire
    await Promise.resolve()
    expect(ctl.getState().busy).toBe(true)
    await ctl.cancel()
    expect(cancelJob).toHaveBeenCalledWith('DL-JOB-1')
    // Let the (now-irrelevant) download settle so the import promise resolves.
    release({ filePath: '/dl/v.mp4', title: 't', bytes: 1 })
    await importing
  })

  it('cancel() is a no-op when nothing is importing (openclip-2bm)', async () => {
    const { ctl, cancelJob } = build()
    await ctl.cancel()
    expect(cancelJob).not.toHaveBeenCalled()
  })

  it('does NOT reclaim once the project is committed, even if a later step throws (e5s review)', async () => {
    // The pipeline succeeds and the project goes live (setCurrentProject), then setView
    // throws. The media belongs to a project the user can now see — it must NOT be
    // deleted out from under them.
    const { ctl, reclaimMedia, setCurrentProject } = build({
      storage: fakeStorage({ [CONSENT_KEY]: '1' }),
      ui: {
        setView: () => {
          throw new Error('view boom')
        }
      } as unknown as ImportControllerDeps['ui']
    })
    await ctl.importUrl('https://youtu.be/x')
    expect(setCurrentProject).toHaveBeenCalledWith(expect.objectContaining({ id: 'PID' }))
    expect(reclaimMedia).not.toHaveBeenCalled()
  })

  it('an adopt failure surfaces an error and does not create a project', async () => {
    const adoptSource = vi.fn(async () => {
      throw new Error('disk full')
    })
    const { ctl, setCurrentProject } = build({
      storage: fakeStorage({ [CONSENT_KEY]: '1' }),
      adoptSource
    } as Partial<ImportControllerDeps>)
    await ctl.importUrl('https://youtu.be/x')
    expect(ctl.getState().error).toMatch(/disk full/)
    expect(setCurrentProject).not.toHaveBeenCalled()
  })
})

describe('import-controller: transcription language (Part I cross-language)', () => {
  it('threads getLanguage() into the pipeline for a file import', async () => {
    const { ctl, runImportPipeline } = build({
      getLanguage: () => 'id'
    } as Partial<ImportControllerDeps>)
    await ctl.importFile('/movies/a.mp4')
    expect(runImportPipeline).toHaveBeenCalledWith(expect.objectContaining({ language: 'id' }))
  })

  it('threads getLanguage() into the pipeline for a URL import', async () => {
    const { ctl, runImportPipeline } = build({
      storage: fakeStorage({ [CONSENT_KEY]: '1' }),
      getLanguage: () => 'id'
    } as Partial<ImportControllerDeps>)
    await ctl.importUrl('https://youtu.be/x')
    expect(runImportPipeline).toHaveBeenCalledWith(expect.objectContaining({ language: 'id' }))
  })

  it('passes language: undefined when no getLanguage is provided (auto-detect)', async () => {
    const { ctl, runImportPipeline } = build()
    await ctl.importFile('/movies/a.mp4')
    expect(runImportPipeline).toHaveBeenCalledWith(expect.objectContaining({ language: undefined }))
  })
})
