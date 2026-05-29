/**
 * tests/unit/export-runner.spec.ts — the `export` JobRunner, focused on the
 * CAPTION-BURN composition (spine, plan E.5 / PRD §6.4). Verifies — without a
 * real binary (injected fakes, PRD §18) — that:
 *   - when `captions` is present, the runner GENERATES the .ass into the per-job
 *     temp dir and threads the path + fontsdir into `exportClip` (one re-encode);
 *   - when neither `assPath` nor `captions` is given, NO subtitles are added
 *     (assPath + fontsDir stay undefined → plain export);
 *   - an explicit `assPath` takes precedence over `captions` (no regeneration);
 *   - the terminal result carries the export dimensions + duration.
 */

import { describe, it, expect, vi } from 'vitest'
import { createExportRunner } from '@main/services/jobs/export-runner'
import type { JobParams } from '@shared/jobs'
import type { JobEmitter, JobRunnerContext } from '@main/services/sidecar-manager'
import { transcriptFixture, captionStyleFixture } from '../fixtures/contract'

function fakeEmitter(): JobEmitter<'export'> {
  return {
    progress: vi.fn(),
    partial: vi.fn(),
    done: vi.fn(),
    error: vi.fn()
  }
}

function fakeCtx(): JobRunnerContext {
  return { signal: new AbortController().signal, trackPid: vi.fn(), jobId: 'export-job-1' }
}

const BASE: JobParams['export'] = {
  projectId: 'proj-1',
  clipId: 'clip-1',
  sourcePath: '/src/in.mp4',
  startTime: 10,
  endTime: 13,
  aspectRatio: '9:16',
  outputPath: '/out/clip.mp4',
  quality: '1080p'
}

const EXPORT_RESULT = { outputPath: '/out/clip.mp4', width: 1080, height: 1920, durationMs: 3000 }

describe('export-runner — caption-burn composition', () => {
  it('generates the .ass and threads assPath + fontsdir into exportClip when captions present', async () => {
    const exportClip = vi.fn().mockResolvedValue(EXPORT_RESULT)
    const writeClipCaptions = vi.fn().mockReturnValue('/tmp/job/clip-1.captions.ass')
    const fontsDir = vi.fn().mockReturnValue('/fonts')
    const resolveAssPath = vi.fn().mockReturnValue('/tmp/job/clip-1.captions.ass')

    const runner = createExportRunner({ exportClip, writeClipCaptions, fontsDir, resolveAssPath })
    const params: JobParams['export'] = {
      ...BASE,
      captions: { words: transcriptFixture.words, style: captionStyleFixture }
    }
    const result = await runner(params, fakeEmitter(), fakeCtx())

    // The .ass was generated from the clip's words, scoped to the resolved bounds.
    expect(writeClipCaptions).toHaveBeenCalledTimes(1)
    expect(writeClipCaptions).toHaveBeenCalledWith(
      expect.objectContaining({
        words: transcriptFixture.words,
        clipStart: 10,
        clipEnd: 13,
        style: captionStyleFixture
      })
    )
    // …and threaded into the SAME re-encode with the fontsdir.
    expect(exportClip).toHaveBeenCalledWith(
      expect.objectContaining({
        assPath: '/tmp/job/clip-1.captions.ass',
        fontsDir: '/fonts'
      })
    )
    expect(result).toEqual(EXPORT_RESULT)
  })

  it('adds NO subtitles (assPath + fontsDir undefined) when captions are absent', async () => {
    const exportClip = vi.fn().mockResolvedValue(EXPORT_RESULT)
    const writeClipCaptions = vi.fn()
    const fontsDir = vi.fn()

    const runner = createExportRunner({ exportClip, writeClipCaptions, fontsDir })
    await runner(BASE, fakeEmitter(), fakeCtx())

    expect(writeClipCaptions).not.toHaveBeenCalled()
    expect(fontsDir).not.toHaveBeenCalled()
    expect(exportClip).toHaveBeenCalledWith(
      expect.objectContaining({ assPath: undefined, fontsDir: undefined })
    )
  })

  it('uses an explicit assPath verbatim and does NOT regenerate', async () => {
    const exportClip = vi.fn().mockResolvedValue(EXPORT_RESULT)
    const writeClipCaptions = vi.fn()
    const fontsDir = vi.fn().mockReturnValue('/fonts')

    const runner = createExportRunner({ exportClip, writeClipCaptions, fontsDir })
    const params: JobParams['export'] = {
      ...BASE,
      assPath: '/pre/made.ass',
      captions: { words: transcriptFixture.words }
    }
    await runner(params, fakeEmitter(), fakeCtx())

    expect(writeClipCaptions).not.toHaveBeenCalled() // explicit path wins
    expect(exportClip).toHaveBeenCalledWith(
      expect.objectContaining({ assPath: '/pre/made.ass', fontsDir: '/fonts' })
    )
  })

  it('resolves the .ass path from (projectId, jobId, clipId) — per-job temp scoping', async () => {
    const exportClip = vi.fn().mockResolvedValue(EXPORT_RESULT)
    const writeClipCaptions = vi.fn((o: { assPath: string }) => o.assPath)
    // Inject the resolver (the real default uses paths.jobTempDir, which needs the
    // Electron `app` — exercised by the trunk-infra path tests). Here we assert the
    // runner threads jobId + clipId + projectId into whatever resolver is wired.
    const resolveAssPath = vi.fn(
      (projectId: string, jobId: string, clipId: string) =>
        `/tmp/openclip/${projectId}/${jobId}/clip-${clipId}.captions.ass`
    )

    const runner = createExportRunner({
      exportClip,
      writeClipCaptions,
      fontsDir: () => '/fonts',
      resolveAssPath
    })
    await runner(
      { ...BASE, captions: { words: transcriptFixture.words } },
      fakeEmitter(),
      fakeCtx()
    )

    expect(resolveAssPath).toHaveBeenCalledWith('proj-1', 'export-job-1', 'clip-1')
    const arg = writeClipCaptions.mock.calls[0][0] as { assPath: string }
    expect(arg.assPath).toBe('/tmp/openclip/proj-1/export-job-1/clip-clip-1.captions.ass')
  })
})

describe('export-runner — silence jump-cuts (Part I.4)', () => {
  it('detects silences → keepRanges threaded into captions + exportClip when removeSilence set', async () => {
    const exportClip = vi.fn().mockResolvedValue(EXPORT_RESULT)
    const writeClipCaptions = vi.fn((o: { assPath: string }) => o.assPath)
    // BASE is 10..13; a 1.5s silence at 11..12.5 → keep [10,11.05] + [12.45,13].
    const detectSilences = vi.fn(async () => [[11, 12.5]] as [number, number][])

    const runner = createExportRunner({
      exportClip,
      writeClipCaptions,
      fontsDir: () => '/fonts',
      detectSilences,
      resolveAssPath: () => '/tmp/clip.ass'
    })
    await runner(
      {
        ...BASE,
        captions: { words: transcriptFixture.words },
        removeSilence: { minSilenceSec: 0.6 }
      },
      fakeEmitter(),
      fakeCtx()
    )

    expect(detectSilences).toHaveBeenCalledWith(
      expect.objectContaining({ sourcePath: '/src/in.mp4', startTime: 10, endTime: 13 })
    )
    const keep = [
      [10, 11.05],
      [12.45, 13]
    ]
    // Captions remap onto the compressed timeline, and the cut uses the same ranges.
    expect(writeClipCaptions).toHaveBeenCalledWith(expect.objectContaining({ keepRanges: keep }))
    expect(exportClip).toHaveBeenCalledWith(expect.objectContaining({ keepRanges: keep }))
  })

  it('falls back to a normal cut (no keepRanges) when detection finds nothing', async () => {
    const exportClip = vi.fn().mockResolvedValue(EXPORT_RESULT)
    const detectSilences = vi.fn(async () => [] as [number, number][])
    const runner = createExportRunner({ exportClip, detectSilences, fontsDir: () => '/fonts' })
    await runner({ ...BASE, removeSilence: true }, fakeEmitter(), fakeCtx())
    expect(detectSilences).toHaveBeenCalledOnce()
    expect(exportClip).toHaveBeenCalledWith(expect.objectContaining({ keepRanges: undefined }))
  })

  it('never blocks the export when silence detection throws (best-effort)', async () => {
    const exportClip = vi.fn().mockResolvedValue(EXPORT_RESULT)
    const detectSilences = vi.fn(async () => {
      throw new Error('ffmpeg unavailable')
    })
    const runner = createExportRunner({ exportClip, detectSilences, fontsDir: () => '/fonts' })
    const result = await runner({ ...BASE, removeSilence: true }, fakeEmitter(), fakeCtx())
    expect(result).toEqual(EXPORT_RESULT)
    expect(exportClip).toHaveBeenCalledWith(expect.objectContaining({ keepRanges: undefined }))
  })
})
