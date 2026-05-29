/**
 * tests/e2e/integration-wave1.e2e.spec.ts — the INTEGRATION-OWNED Wave-1 E2E
 * (plan m10), run against the REAL built Electron app over the REAL IPC, the
 * fixed contextBridge-safe per-job MessagePort handoff, the real SidecarManager,
 * and real `.ocproj` persistence.
 *
 * Full vertical spine (binary-free via OPENCLIP_FAKE_TRANSCRIBE + the fake AI
 * transport seam in ipc/ai.ts):
 *
 *   launch → import (fake) → transcribe over the TRANSFERRED port → transcript
 *   renders → generate clips (MOCKED provider) → clip cards render → save
 *   project → reload app → load project → transcript + clips restored.
 *
 * The renderer spine is driven through `window.__openclipTest` (the REAL
 * orchestration modules + the singleton store, exposed in main.tsx), so this
 * exercises the production import-pipeline (which acquires the live job port by
 * jobId), the clips slice (real ai:generate-clips), and project save/load — then
 * asserts the actual DOM (TranscriptPanel segments + ClipCards) renders.
 *
 * userData is isolated per run via --user-data-dir so the saved `.ocproj`
 * survives the in-process reload and does not pollute the dev profile.
 */

import { test, expect, _electron as electron } from '@playwright/test'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

test('Wave-1 spine: import → transcribe → clips → save → reload → load restores all', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'openclip-e2e-'))
  const app = await electron.launch({
    args: [join(process.cwd(), 'out', 'main', 'index.js'), `--user-data-dir=${userDataDir}`],
    env: { ...process.env, NODE_ENV: 'production', OPENCLIP_FAKE_TRANSCRIBE: '1' }
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  // ── 1) Import → transcribe over the real transferred MessagePort, hydrating
  //       the transcript slice through the REAL import-pipeline. ──
  const imported = await win.evaluate(async () => {
    const h = window.__openclipTest!
    const store = h.store
    const result = await h.runImportPipeline({
      bridge: window.openclip,
      filePath: '/tmp/sample.mp4',
      projectId: 'p1',
      model: 'base',
      onPartial: (partial) => store.getState().appendTranscriptPartial(partial),
      onTranscript: (t) => store.getState().hydrateTranscript(t)
    })
    return {
      sourceVideo: result.sourceVideo,
      language: result.transcript.language,
      segmentCount: result.transcript.segments.length,
      storeSegments: store.getState().transcript?.segments.length ?? 0
    }
  })
  expect(imported.sourceVideo.duration).toBeGreaterThan(0)
  expect(imported.segmentCount).toBeGreaterThan(0)
  expect(imported.storeSegments).toBeGreaterThan(0)

  // ── transcript RENDERS in the center pane (App shows TranscriptPanel once the
  //    store transcript has segments) ──
  await expect(win.getByTestId('transcript-panel')).toBeVisible()
  const segLocator = win.getByTestId('transcript-segment')
  await expect(segLocator.first()).toBeVisible()
  await expect(win.getByText('Hello world!')).toBeVisible()

  // ── 2) Generate clips via the REAL ai:generate-clips handler (fake transport).
  //       The clips slice maps DetectedClip → Clip and seeds the sidebar. ──
  const generated = await win.evaluate(async () => {
    const store = window.__openclipTest!.store
    const segments = store.getState().transcript!.segments
    await store.getState().generateClips({
      projectId: 'p1',
      provider: 'openai',
      model: 'gpt-4o',
      segments,
      videoTitle: 'Sample',
      durationSeconds: 240,
      clipStyle: 'all',
      numClips: 5,
      targetPlatform: 'all'
    })
    const clips = store.getState().clips
    return {
      count: clips.length,
      error: store.getState().generateError,
      titles: clips.map((c) => c.title)
    }
  })
  expect(generated.error).toBeNull()
  expect(generated.count).toBeGreaterThan(0)

  // ── clip cards RENDER in the sidebar ──
  const clipCards = win.getByTestId('clip-card')
  await expect(clipCards.first()).toBeVisible()
  expect(await clipCards.count()).toBe(generated.count)

  // ── 3) Save the full project (.ocproj) via the real persistence layer. The
  //       saved doc composes the live transcript + clips slices into the
  //       Project document (autosave only syncs currentProject refs). ──
  const saved = await win.evaluate(async () => {
    const store = window.__openclipTest!.store
    const s = store.getState()
    const now = Date.now()
    const project = {
      id: 'wave1-e2e-project',
      name: 'Wave-1 Integration',
      createdAt: now,
      updatedAt: now,
      sourceVideo: s.currentProject?.sourceVideo ?? {
        path: '/tmp/sample.mp4',
        duration: 240,
        resolution: { width: 1920, height: 1080 },
        fps: 30,
        format: 'mp4'
      },
      transcript: s.transcript!,
      clips: s.clips,
      settings: {
        targetPlatform: 'all' as const,
        aspectRatio: '9:16' as const,
        clipStyle: 'all' as const,
        maxClips: 5,
        minDuration: 15,
        maxDuration: 90
      },
      exportHistory: []
    }
    const res = await window.openclip.project.save({ project })
    return { path: res.path, id: project.id }
  })
  expect(saved.path).toContain('wave1-e2e-project.ocproj')

  // ── 4) Reload the app (fresh renderer → empty store), then LOAD the project.
  //       The load path (projectActions.open → hydrateFromProject) restores the
  //       core doc + transcript slice + clips slice. ──
  await win.reload()
  await win.waitForLoadState('domcontentloaded')

  const restored = await win.evaluate(async (id) => {
    const h = window.__openclipTest!
    const store = h.store
    // fresh store after reload
    const before = {
      segments: store.getState().transcript?.segments.length ?? 0,
      clips: store.getState().clips.length
    }
    const actions = h.projectActions(window.openclip, store)
    const project = await actions.open(id)
    const after = {
      segments: store.getState().transcript?.segments.length ?? 0,
      clips: store.getState().clips.length,
      name: store.getState().currentProject?.name
    }
    return { before, after, loadedClips: project.clips.length }
  }, saved.id)

  // Fresh renderer started empty; load restored transcript + clips.
  expect(restored.before.segments).toBe(0)
  expect(restored.before.clips).toBe(0)
  expect(restored.after.segments).toBe(imported.segmentCount)
  expect(restored.after.clips).toBe(generated.count)
  expect(restored.after.name).toBe('Wave-1 Integration')

  // ── restored transcript + clips RENDER after load ──
  await expect(win.getByTestId('transcript-panel')).toBeVisible()
  await expect(win.getByText('Hello world!')).toBeVisible()
  await expect(win.getByTestId('clip-card').first()).toBeVisible()
  expect(await win.getByTestId('clip-card').count()).toBe(generated.count)

  await app.close()
})
