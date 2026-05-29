/**
 * tests/unit/ffmpeg-export.spec.ts — pure arg-building for the frame-accurate
 * cut + 9:16 reframe + re-encode (EXPORT spine, plan E.5 / PRD §6.5/§6.9), plus
 * the export JobRunner glue against an injected fake export service (no binary).
 *
 * The argv strings are LOAD-BEARING (they map 1:1 to the verified ffmpeg command
 * proven empirically on ffmpeg-static), so we assert them exactly. The real
 * binary is exercised separately by `ffmpeg-export.serial.spec.ts` (ffprobe).
 */

import { describe, expect, it, vi } from 'vitest'
import {
  exportClipArgs,
  exportClipArgsMultiRange,
  thumbnailArgs,
  buildVf,
  cropExpr,
  outputDimensions,
  videoBitrate,
  escapeFilterPath,
  type ExportArgsOptions
} from '@main/services/ffmpeg-export'
import { createExportRunner } from '@main/services/jobs/export-runner'
import type { JobParams } from '@shared/jobs'
import type { JobEmitter, JobRunnerContext } from '@main/services/sidecar-manager'

const base: ExportArgsOptions = {
  sourcePath: '/src/in.mp4',
  outputPath: '/out/clip.mp4',
  startTime: 30,
  endTime: 58.5,
  aspectRatio: '9:16',
  quality: '1080p'
}

describe('outputDimensions', () => {
  it('maps each aspect ratio to its 1080-family output size', () => {
    expect(outputDimensions('9:16')).toEqual({ width: 1080, height: 1920 })
    expect(outputDimensions('1:1')).toEqual({ width: 1080, height: 1080 })
    expect(outputDimensions('4:5')).toEqual({ width: 1080, height: 1350 })
    expect(outputDimensions('16:9')).toEqual({ width: 1920, height: 1080 })
  })
})

describe('cropExpr / buildVf', () => {
  it('uses the PRD §6.5 / Appendix A center-crop for 9:16', () => {
    expect(cropExpr('9:16')).toBe('crop=ih*9/16:ih')
  })

  it('builds crop,scale for a plain 9:16 export (no captions)', () => {
    expect(buildVf({ aspectRatio: '9:16' })).toBe('crop=ih*9/16:ih,scale=1080:1920')
  })

  it('appends the subtitles node LAST when an ass is given (caption-burn seam)', () => {
    const vf = buildVf({ aspectRatio: '9:16', assPath: '/t/c.ass', fontsDir: '/t/fonts' })
    expect(vf).toBe('crop=ih*9/16:ih,scale=1080:1920,subtitles=/t/c.ass:fontsdir=/t/fonts')
  })

  it('escapes filtergraph-special chars in a subtitles path', () => {
    expect(escapeFilterPath('/a b/c:d.ass')).toBe('/a b/c\\:d.ass')
    const vf = buildVf({ aspectRatio: '9:16', assPath: '/Vol:1/x.ass' })
    expect(vf).toContain('subtitles=/Vol\\:1/x.ass')
  })
})

describe('videoBitrate', () => {
  it('targets 8M for 1080p and 5M for 720p', () => {
    expect(videoBitrate('1080p')).toBe('8M')
    expect(videoBitrate('720p')).toBe('5M')
  })
})

describe('exportClipArgs (the verified command)', () => {
  it('puts -ss BEFORE -i and -to as a DURATION (end - start) after -i', () => {
    const args = exportClipArgs(base)
    const ssIdx = args.indexOf('-ss')
    const iIdx = args.indexOf('-i')
    const toIdx = args.indexOf('-to')
    expect(ssIdx).toBeGreaterThan(-1)
    expect(ssIdx).toBeLessThan(iIdx) // -ss precedes -i (fast seek + re-encode)
    expect(toIdx).toBeGreaterThan(iIdx) // -to follows -i (relative duration)
    expect(args[ssIdx + 1]).toBe('30')
    expect(args[toIdx + 1]).toBe('28.5') // 58.5 - 30, NOT the absolute end
  })

  it('emits the full videotoolbox re-encode argv (NOT -c copy)', () => {
    expect(exportClipArgs(base)).toEqual([
      '-hide_banner',
      '-y',
      '-ss',
      '30',
      '-i',
      '/src/in.mp4',
      '-to',
      '28.5',
      '-vf',
      'crop=ih*9/16:ih,scale=1080:1920',
      '-c:v',
      'h264_videotoolbox',
      '-b:v',
      '8M',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      '-progress',
      'pipe:2',
      '-nostats',
      '/out/clip.mp4'
    ])
    // Must NOT stream-copy — re-encode is required for a frame-accurate cut+crop.
    expect(exportClipArgs(base)).not.toContain('copy')
  })

  it('uses libx264 -crf 18 when forceCpu (GPU fallback, PRD §14)', () => {
    const args = exportClipArgs({ ...base, forceCpu: true })
    expect(args).toContain('libx264')
    expect(args).toContain('-crf')
    expect(args[args.indexOf('-crf') + 1]).toBe('18')
    expect(args).not.toContain('h264_videotoolbox')
  })

  it('threads an ass path into the filtergraph (caption-burn seam)', () => {
    const args = exportClipArgs({ ...base, assPath: '/t/c.ass', fontsDir: '/t/fonts' })
    expect(args[args.indexOf('-vf') + 1]).toBe(
      'crop=ih*9/16:ih,scale=1080:1920,subtitles=/t/c.ass:fontsdir=/t/fonts'
    )
  })

  it('throws on a non-positive span (caller surfaces INPUT_INVALID)', () => {
    expect(() => exportClipArgs({ ...base, startTime: 40, endTime: 40 })).toThrow(/non-positive/)
    expect(() => exportClipArgs({ ...base, startTime: 40, endTime: 10 })).toThrow(/non-positive/)
  })
})

describe('exportClipArgsMultiRange (Part I.4 jump-cuts)', () => {
  const keepRanges: [number, number][] = [
    [30, 40],
    [44, 58.5]
  ]

  it('builds a select+setpts filtergraph over the kept spans (no -ss/-to)', () => {
    const args = exportClipArgsMultiRange({ ...base, keepRanges })
    const fc = args[args.indexOf('-filter_complex') + 1]
    // video: OR of between() over kept spans, re-stamped, then crop+scale.
    expect(fc).toContain(
      "[0:v]select='between(t,30,40)+between(t,44,58.5)',setpts=N/FRAME_RATE/TB,crop=ih*9/16:ih,scale=1080:1920[v]"
    )
    // audio: same selection, re-stamped.
    expect(fc).toContain("[0:a]aselect='between(t,30,40)+between(t,44,58.5)',asetpts=N/SR/TB[a]")
    expect(args).toEqual(expect.arrayContaining(['-map', '[v]', '-map', '[a]']))
    expect(args).not.toContain('-ss') // the select handles the ranges, not a seek
    expect(args.at(-1)).toBe('/out/clip.mp4')
  })

  it('appends the subtitles burn (compressed-timeline .ass) as the last video node', () => {
    const args = exportClipArgsMultiRange({
      ...base,
      keepRanges,
      assPath: '/t/c.ass',
      fontsDir: '/t/fonts'
    })
    const fc = args[args.indexOf('-filter_complex') + 1]
    expect(fc).toContain('scale=1080:1920,subtitles=/t/c.ass:fontsdir=/t/fonts[v]')
  })

  it('throws without keep ranges (use the single-range path instead)', () => {
    expect(() => exportClipArgsMultiRange({ ...base })).toThrow(/keepRanges/)
  })
})

describe('thumbnailArgs', () => {
  it('grabs a single reframed frame (-vframes 1) at the given time', () => {
    expect(
      thumbnailArgs({
        sourcePath: '/src/in.mp4',
        outputPath: '/out/thumb.jpg',
        atTime: 31.2,
        aspectRatio: '9:16'
      })
    ).toEqual([
      '-hide_banner',
      '-y',
      '-ss',
      '31.2',
      '-i',
      '/src/in.mp4',
      '-vframes',
      '1',
      '-vf',
      'crop=ih*9/16:ih,scale=1080:1920',
      '/out/thumb.jpg'
    ])
  })
})

// ============================================================================
// export-runner glue (injected fake export service — no real ffmpeg)
// ============================================================================

function fakeEmitter(): { emit: JobEmitter<'export'>; events: unknown[] } {
  const events: unknown[] = []
  const emit: JobEmitter<'export'> = {
    progress: (pct, stage, etaMs) => events.push({ t: 'progress', pct, stage, etaMs }),
    partial: (data) => events.push({ t: 'partial', data }),
    done: (result) => events.push({ t: 'done', result }),
    error: (code, message, retriable) => events.push({ t: 'error', code, message, retriable })
  }
  return { emit, events }
}

function fakeCtx(): JobRunnerContext {
  return { signal: new AbortController().signal, trackPid: () => {}, jobId: 'export-test-1' }
}

const params: JobParams['export'] = {
  projectId: 'p1',
  clipId: 'clip-1',
  sourcePath: '/src/in.mp4',
  startTime: 30,
  endTime: 58.5,
  aspectRatio: '9:16',
  outputPath: '/out/clip.mp4',
  quality: '1080p'
}

describe('createExportRunner', () => {
  it('streams 0→100 progress and returns the export result', async () => {
    const exportClip = vi.fn(async (o: { onProgress?: (p: number) => void }) => {
      o.onProgress?.(50)
      return { outputPath: '/out/clip.mp4', width: 1080, height: 1920, durationMs: 28_500 }
    })
    const runner = createExportRunner({ exportClip })
    const { emit, events } = fakeEmitter()

    const result = await runner(params, emit, fakeCtx())

    expect(result).toEqual({
      outputPath: '/out/clip.mp4',
      width: 1080,
      height: 1920,
      durationMs: 28_500
    })
    // It passed the resolved span + aspect through to the export service.
    expect(exportClip).toHaveBeenCalledWith(
      expect.objectContaining({
        startTime: 30,
        endTime: 58.5,
        aspectRatio: '9:16',
        outputPath: '/out/clip.mp4',
        quality: '1080p'
      })
    )
    // Emitted at least an initial, a mid (50), and a final (100) progress.
    const pcts = events
      .filter((e): e is { t: 'progress'; pct: number } => (e as { t: string }).t === 'progress')
      .map((e) => e.pct)
    expect(pcts).toContain(0)
    expect(pcts).toContain(50)
    expect(pcts).toContain(100)
  })

  it('only resolves fontsdir when burning captions (assPath set)', async () => {
    const exportClip = vi.fn(async () => ({
      outputPath: '/out/clip.mp4',
      width: 1080,
      height: 1920,
      durationMs: 1000
    }))
    const fontsDir = vi.fn(() => '/fonts')
    const runner = createExportRunner({ exportClip, fontsDir })

    await runner(params, fakeEmitter().emit, fakeCtx())
    expect(fontsDir).not.toHaveBeenCalled()
    expect(exportClip).toHaveBeenLastCalledWith(expect.objectContaining({ fontsDir: undefined }))

    await runner({ ...params, assPath: '/t/c.ass' }, fakeEmitter().emit, fakeCtx())
    expect(fontsDir).toHaveBeenCalled()
    expect(exportClip).toHaveBeenLastCalledWith(
      expect.objectContaining({ assPath: '/t/c.ass', fontsDir: '/fonts' })
    )
  })

  it('propagates a service failure (manager maps it to a typed error)', async () => {
    const runner = createExportRunner({
      exportClip: async () => {
        throw new Error('ffmpeg exited with code 1')
      }
    })
    await expect(runner(params, fakeEmitter().emit, fakeCtx())).rejects.toThrow(/code 1/)
  })
})
