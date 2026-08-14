/**
 * tests/unit/force-cpu.spec.ts — the "force CPU" Setting reaches the encoder, and
 * a dead hardware encoder falls back instead of failing (BUG-jt3d62 / FEAT-5hnsby).
 *
 * `Settings.forceCpu` has existed since the schema was written, is defaulted in
 * both main and the renderer store, and `codecArgs()` has always honoured it —
 * but `JobParams['export']` had no field to carry it, so `grep -rn forceCpu src/`
 * found the declaration and the consumer and never a call site joining them. The
 * toggle was inert: every export encoded with `h264_videotoolbox` whatever the
 * user picked, and a Mac that cannot open a VideoToolbox session had no way out —
 * the export just died with SIDECAR_CRASH.
 *
 * The parts that must hold together:
 *   1. the argv actually flips to libx264,
 *   2. the renderer puts the Setting into the job params,
 *   3. a hardware-encoder failure retries once on CPU — and *only* that failure.
 */

import { describe, expect, it, vi } from 'vitest'
import { codecArgs, isHardwareEncoderFailure } from '@main/services/ffmpeg-export'
import { buildExportParams } from '@renderer/stores/projectStore/exportSlice'
import { createExportRunner } from '@main/services/jobs/export-runner'
import { encoderLabel } from '@renderer/components/settingsView'
import { probeEncoder } from '@main/services/encoder-probe'
import { clipFixture, projectFixture } from '../fixtures/contract'

describe('codecArgs: the encoder actually flips', () => {
  it('selects libx264 when forceCpu is set, videotoolbox otherwise', () => {
    expect(codecArgs({ forceCpu: true, quality: '1080p' })).toContain('libx264')
    expect(codecArgs({ forceCpu: true, quality: '1080p' })).not.toContain('h264_videotoolbox')
    expect(codecArgs({ forceCpu: false, quality: '1080p' })).toContain('h264_videotoolbox')
    expect(codecArgs({ forceCpu: undefined, quality: '1080p' })).toContain('h264_videotoolbox')
  })
})

describe('buildExportParams: the Setting reaches the job params', () => {
  const base = {
    projectId: projectFixture.id,
    clip: clipFixture,
    source: projectFixture.sourceVideo,
    settings: { aspectRatio: '9:16' as const },
    outputPath: '/out/clip.mp4'
  }

  it('carries forceCpu through to JobParams', () => {
    expect(buildExportParams({ ...base, forceCpu: true }).forceCpu).toBe(true)
  })

  it('omits it when the Setting is off, so the argv is unchanged', () => {
    expect(buildExportParams({ ...base, forceCpu: false }).forceCpu).toBe(false)
    expect(buildExportParams(base).forceCpu).toBeUndefined()
  })
})

describe('isHardwareEncoderFailure: narrow by design', () => {
  it('recognises the VideoToolbox session failure', () => {
    expect(
      isHardwareEncoderFailure(
        new Error(
          'Error while opening encoder - videotoolbox: cannot create compression session: -12903'
        )
      )
    ).toBe(true)
    expect(isHardwareEncoderFailure(new Error('h264_videotoolbox: Function not implemented'))).toBe(
      true
    )
  })

  it('does NOT match unrelated failures — a broken export must fail fast', () => {
    // Retrying these on the CPU would just fail twice as slowly.
    expect(isHardwareEncoderFailure(new Error('No such file or directory'))).toBe(false)
    expect(isHardwareEncoderFailure(new Error('Invalid data found when processing input'))).toBe(
      false
    )
    expect(isHardwareEncoderFailure(new Error('Conversion failed!'))).toBe(false)
    expect(isHardwareEncoderFailure(undefined)).toBe(false)
  })
})

describe('export runner: automatic CPU fallback', () => {
  const params = {
    projectId: 'p1',
    clipId: 'c1',
    sourcePath: '/v/in.mp4',
    outputPath: '/v/out.mp4',
    startTime: 0,
    endTime: 5,
    aspectRatio: '9:16' as const,
    quality: '1080p' as const
  }
  const ctx = { jobId: 'export-1', trackPid: () => {}, untrackPid: () => {} }
  const emit = { progress: () => {}, partial: () => {}, done: () => {}, error: () => {} }
  const ok = { outputPath: '/v/out.mp4', width: 1080, height: 1920, durationSec: 5 }
  /** Everything that would otherwise touch Electron's `app` or the filesystem. */
  const stubs = {
    fontsDir: () => '/fonts',
    resolveAssPath: () => '/tmp/x.ass',
    removeJobTemp: () => {}
  }
  const run = (
    p: typeof params & { forceCpu?: boolean },
    exportClip: unknown
  ): Promise<{ outputPath: string }> =>
    createExportRunner({ ...stubs, exportClip } as never)(p, emit as never, ctx as never)

  it('retries once on libx264 when the hardware encoder cannot start', async () => {
    const calls: boolean[] = []
    const exportClip = vi.fn(async (o: { forceCpu?: boolean }) => {
      calls.push(o.forceCpu === true)
      if (o.forceCpu !== true) {
        throw new Error('videotoolbox: cannot create compression session: -12903')
      }
      return ok
    })

    const result = await run(params, exportClip)

    expect(calls).toEqual([false, true]) // hardware first, then CPU
    expect(result.outputPath).toBe('/v/out.mp4')
  })

  it('does not retry when the user already asked for CPU', async () => {
    const exportClip = vi.fn(async () => {
      throw new Error('videotoolbox: cannot create compression session: -12903')
    })
    await expect(run({ ...params, forceCpu: true }, exportClip)).rejects.toThrow(
      /compression session/
    )
    expect(exportClip).toHaveBeenCalledTimes(1)
  })

  it('does not retry an unrelated failure', async () => {
    const exportClip = vi.fn(async () => {
      throw new Error('Invalid data found when processing input')
    })
    await expect(run(params, exportClip)).rejects.toThrow(/Invalid data/)
    expect(exportClip).toHaveBeenCalledTimes(1)
  })
})

describe('encoder probe + label', () => {
  it('reports unknown when ffmpeg cannot be resolved, never a guess', () => {
    expect(
      probeEncoder(() => {
        throw new Error('not found')
      })
    ).toBe('unknown')
    expect(probeEncoder(() => '')).toBe('unknown')
  })

  it('describes the active backend, combining the probe and the Setting', () => {
    expect(encoderLabel('hardware', false)).toMatch(/videotoolbox/i)
    expect(encoderLabel('cpu', false)).toMatch(/libx264/i)
    // Forced CPU on a capable Mac must not read as "hardware".
    expect(encoderLabel('hardware', true)).toMatch(/libx264/i)
    expect(encoderLabel('hardware', true)).toMatch(/forced/i)
    // An unprobed backend says so rather than claiming one.
    expect(encoderLabel(undefined, false)).toMatch(/checking/i)
  })
})
