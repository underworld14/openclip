/**
 * tests/e2e/timeline.e2e.spec.ts — the TIMELINE (P6) end-to-end proof
 * (plan E.5 done-when / E.10 #4: "export ±1 frame of the EDITED span";
 * PRD §6.6 "dragging handles retrims and a re-export reflects the new bounds").
 *
 * This is the load-bearing cross-track assertion for the minimal timeline: a
 * drag-handle RETRIM (driven through the REAL production store action
 * `dragClipHandle`, exactly what Timeline.tsx calls) changes the clip's
 * `editedStart`/`editedEnd`; the SHARED `resolveBounds` then yields the trimmed
 * span; `buildExportParams` (the real export-slice fn that applies resolveBounds)
 * builds the job params; and the REAL export job (real ffmpeg over the
 * transferred MessagePort) writes a clip whose ffprobe'd duration matches the
 * EDITED span within ±1 frame — and is DIFFERENT from the original suggested span
 * (so we know the retrim actually took effect end-to-end).
 *
 * Also drives the live DOM Timeline (handles render + keyboard mark-in/out) to
 * prove the component is wired, not just the store.
 *
 * Skips gracefully if ffmpeg-static is unavailable — and the RE-EXPORT case also
 * skips where ffmpeg cannot encode with h264_videotoolbox, which the production
 * export path uses unconditionally (no `forceCpu` in `JobParams['export']` — see
 * BUG-jt3d62). GitHub's macos-14 runners are VMs whose VideoToolbox session fails
 * to open: `cannot create compression session: -12903` (run 31294445970). The
 * keyboard mark-in/out case needs no encoder and always runs.
 */

import { test, expect, _electron as electron } from '@playwright/test'
import { join } from 'node:path'
import { mkdtempSync, existsSync, statSync } from 'node:fs'
import { spawnSync, execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { videotoolboxAvailable } from '../harness/fixtures'

function ffmpegStatic(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const p = require('ffmpeg-static') as string | null
    return p && existsSync(p) ? p : null
  } catch {
    return null
  }
}

function ffprobeStatic(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require('ffmpeg-ffprobe-static') as { ffprobePath?: string }
    if (m.ffprobePath && existsSync(m.ffprobePath)) return m.ffprobePath
  } catch {
    /* fall through */
  }
  return 'ffprobe'
}

function probeDurationSec(path: string): number {
  const out = execFileSync(
    ffprobeStatic(),
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
    { encoding: 'utf8' }
  )
  return Number(out.trim().split(',')[0])
}

const FFMPEG = ffmpegStatic()
const SRC_FPS = 30

test('Timeline P6: drag-handle retrim → re-export reflects the new bounds (±1 frame, ffprobe)', async () => {
  test.skip(!FFMPEG, 'ffmpeg-static not available')
  // This case re-exports for real, so it needs a usable GPU encoder — see the header.
  // The keyboard mark-in/out case below touches only the store + DOM and stays portable.
  test.skip(
    !!FFMPEG && !videotoolboxAvailable(),
    'ffmpeg cannot encode with h264_videotoolbox here (absent off macOS; unusable on a VM runner)'
  )

  const work = mkdtempSync(join(tmpdir(), 'openclip-timeline-e2e-'))
  const src = join(work, 'src.mp4')
  const outSuggested = join(work, 'suggested.mp4')
  const outTrimmed = join(work, 'trimmed.mp4')

  // Synthetic 8s 1920×1080 30fps source (room for the 9:16 center-crop + a trim).
  const gen = spawnSync(
    FFMPEG!,
    [
      '-hide_banner',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=1920x1080:rate=${SRC_FPS}:duration=8`,
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=8',
      '-g',
      '12',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      src
    ],
    { encoding: 'utf8' }
  )
  expect(gen.status).toBe(0)

  const userDataDir = mkdtempSync(join(tmpdir(), 'openclip-timeline-userdata-'))
  const app = await electron.launch({
    args: [join(process.cwd(), 'out', 'main', 'index.js'), `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      OPENCLIP_FAKE_TRANSCRIBE: '1',
      OPENCLIP_FFMPEG: FFMPEG!
    }
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  // ── Seed a project (8s source) + one clip with a WIDE suggested span, select
  //    it. This is the state the timeline trims. ──
  const bounds = await win.evaluate(
    ({ src }) => {
      const store = window.__openclipTest!.store
      const now = Date.now()
      const project = {
        id: 'timeline-e2e',
        name: 'Timeline P6',
        createdAt: now,
        updatedAt: now,
        sourceVideo: {
          path: src,
          duration: 8,
          resolution: { width: 1920, height: 1080 },
          fps: 30,
          format: 'mp4'
        },
        transcript: { language: 'en', segments: [], words: [] },
        clips: [],
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
      store.getState().setCurrentProject(project)
      // A wide AI-suggested span: 0.5 .. 6.5 (6.0s).
      store.getState().setClips([
        {
          id: 'clip-1',
          startTime: 0.5,
          endTime: 6.5,
          title: 'Timeline clip',
          hook: 'h',
          viralityScore: 8,
          clipType: 'hook',
          keywords: [],
          status: 'suggested'
        }
      ])
      store.getState().selectClip('clip-1')
      const suggested = window.__openclipTest!.resolveBounds(store.getState().clips[0])
      return { suggested }
    },
    { src }
  )
  // The untrimmed suggested span is 6.0s.
  expect(bounds.suggested.end - bounds.suggested.start).toBeCloseTo(6.0, 5)

  // ── The DOM Timeline renders the track + both trim handles (component wired) ──
  await expect(win.getByTestId('timeline-track')).toBeVisible()
  await expect(win.getByTestId('timeline-handle-in')).toBeVisible()
  await expect(win.getByTestId('timeline-handle-out')).toBeVisible()

  // ── Export #1: the SUGGESTED (untrimmed) span — for an explicit before/after. ──
  const r1 = await win.evaluate(
    async ({ out }) => {
      const h = window.__openclipTest!
      const store = h.store
      const project = store.getState().currentProject!
      const clip = store.getState().clips[0]
      const params = h.buildExportParams({
        projectId: project.id,
        clip,
        source: project.sourceVideo,
        settings: project.settings,
        outputPath: out
      })
      const r = await h.runExport({ bridge: window.openclip, params })
      return { durationMs: r.durationMs, startTime: params.startTime, endTime: params.endTime }
    },
    { out: outSuggested }
  )
  expect(r1.startTime).toBeCloseTo(0.5, 5)
  expect(r1.endTime).toBeCloseTo(6.5, 5)

  // ── RETRIM via the REAL production store action `dragClipHandle` (exactly what
  //    Timeline.tsx dispatches on a handle drag): drag IN to 2.0 and OUT to 4.5,
  //    yielding a 2.5s edited span. resolveBounds must then reflect editedStart/End. ──
  const edited = await win.evaluate(() => {
    const h = window.__openclipTest!
    const store = h.store
    const duration = store.getState().currentProject!.sourceVideo.duration // 8
    store.getState().dragClipHandle('clip-1', 'in', 2.0, duration)
    store.getState().dragClipHandle('clip-1', 'out', 4.5, duration)
    const clip = store.getState().clips[0]
    return {
      editedStart: clip.editedStart,
      editedEnd: clip.editedEnd,
      resolved: h.resolveBounds(clip)
    }
  })
  // The drag persisted editedStart/editedEnd and resolveBounds honors them.
  expect(edited.editedStart).toBeCloseTo(2.0, 5)
  expect(edited.editedEnd).toBeCloseTo(4.5, 5)
  expect(edited.resolved.start).toBeCloseTo(2.0, 5)
  expect(edited.resolved.end).toBeCloseTo(4.5, 5)

  // ── Export #2: the RETRIMMED span via the same real export path. ──
  const r2 = await win.evaluate(
    async ({ out }) => {
      const h = window.__openclipTest!
      const store = h.store
      const project = store.getState().currentProject!
      const clip = store.getState().clips[0]
      const params = h.buildExportParams({
        projectId: project.id,
        clip,
        source: project.sourceVideo,
        settings: project.settings,
        outputPath: out
      })
      const r = await h.runExport({ bridge: window.openclip, params })
      return { durationMs: r.durationMs, startTime: params.startTime, endTime: params.endTime }
    },
    { out: outTrimmed }
  )
  // buildExportParams applied resolveBounds → the export span is the EDITED span.
  expect(r2.startTime).toBeCloseTo(2.0, 5)
  expect(r2.endTime).toBeCloseTo(4.5, 5)

  await app.close()

  // ── ffprobe the two outputs: the retrimmed clip is a 2.5s span (the edited
  //    bounds), within ±1 frame; the suggested clip is the original 6.0s. ──
  expect(existsSync(outSuggested)).toBe(true)
  expect(existsSync(outTrimmed)).toBe(true)
  expect(statSync(outTrimmed).size).toBeGreaterThan(0)

  const oneFrame = 1 / SRC_FPS
  const suggestedDur = probeDurationSec(outSuggested)
  const trimmedDur = probeDurationSec(outTrimmed)

  // The RE-EXPORT reflects the new bounds: 2.5s edited span ±1 frame.
  expect(Math.abs(trimmedDur - 2.5)).toBeLessThanOrEqual(oneFrame + 1e-3)
  // The original suggested span was 6.0s ±1 frame.
  expect(Math.abs(suggestedDur - 6.0)).toBeLessThanOrEqual(oneFrame + 1e-3)
  // …and the retrim genuinely changed the exported span (not a no-op).
  expect(suggestedDur - trimmedDur).toBeGreaterThan(3.0)
})

test('Timeline P6: keyboard I/O mark-in/out retrims the selected clip', async () => {
  test.skip(!FFMPEG, 'ffmpeg-static not available')

  const userDataDir = mkdtempSync(join(tmpdir(), 'openclip-timeline-kbd-'))
  const app = await electron.launch({
    args: [join(process.cwd(), 'out', 'main', 'index.js'), `--user-data-dir=${userDataDir}`],
    env: { ...process.env, NODE_ENV: 'production', OPENCLIP_FAKE_TRANSCRIBE: '1' }
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  // Seed a selected clip on an 8s source.
  await win.evaluate(() => {
    const store = window.__openclipTest!.store
    const now = Date.now()
    store.getState().setCurrentProject({
      id: 'kbd-e2e',
      name: 'kbd',
      createdAt: now,
      updatedAt: now,
      sourceVideo: {
        path: '/tmp/none.mp4',
        duration: 8,
        resolution: { width: 1920, height: 1080 },
        fps: 30,
        format: 'mp4'
      },
      transcript: { language: 'en', segments: [], words: [] },
      clips: [],
      settings: {
        targetPlatform: 'all',
        aspectRatio: '9:16',
        clipStyle: 'all',
        maxClips: 5,
        minDuration: 15,
        maxDuration: 90
      },
      exportHistory: []
    })
    store.getState().setClips([
      {
        id: 'clip-1',
        startTime: 0.5,
        endTime: 6.5,
        title: 'kbd clip',
        hook: 'h',
        viralityScore: 8,
        clipType: 'hook',
        keywords: [],
        status: 'suggested'
      }
    ])
    store.getState().selectClip('clip-1')
  })

  const timeline = win.getByTestId('timeline')
  await expect(timeline).toBeVisible()
  await timeline.focus()

  // Move the playhead to 3.0 then press I (mark in).
  await win.evaluate(() => window.__openclipTest!.store.getState().setPlayhead(3.0))
  await timeline.press('i')
  // Move the playhead to 5.0 then press O (mark out).
  await win.evaluate(() => window.__openclipTest!.store.getState().setPlayhead(5.0))
  await timeline.press('o')

  const after = await win.evaluate(() => {
    const h = window.__openclipTest!
    const clip = h.store.getState().clips[0]
    return {
      editedStart: clip.editedStart,
      editedEnd: clip.editedEnd,
      resolved: h.resolveBounds(clip)
    }
  })
  expect(after.editedStart).toBeCloseTo(3.0, 5)
  expect(after.editedEnd).toBeCloseTo(5.0, 5)
  expect(after.resolved).toEqual({ start: 3.0, end: 5.0 })

  await app.close()
})
