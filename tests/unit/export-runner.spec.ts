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
