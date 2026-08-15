/**
 * tests/unit/extract-audio-runner.spec.ts — the `extract-audio` JobRunner
 * (EPIC-k83ghw / BUG-sg6kqg). Verifies — without a real ffmpeg binary
 * (injected fakes, PRD §18) — the actual behaviour the ticket fixes:
 *   - the ffmpeg child's PID is tracked (so cancel/kill-on-quit can reach it,
 *     unlike the old plain `invoke` that had no PID to kill);
 *   - the cooperative AbortSignal is threaded through to extraction;
 *   - progress streams (not a single frozen value);
 *   - a probe failure is tolerated (extraction still succeeds without a
 *     duration denominator), matching the old handler's behaviour.
 */

import { describe, it, expect, vi } from 'vitest'
import { createExtractAudioRunner } from '@main/services/jobs/extract-audio-runner'
import type { ExtractAudioOptions } from '@main/services/ffmpeg-extract'
import type { JobParams } from '@shared/jobs'
import type { JobEmitter, JobRunnerContext } from '@main/services/sidecar-manager'

function fakeEmitter(): JobEmitter<'extract-audio'> {
  return {
    progress: vi.fn(),
    partial: vi.fn(),
    done: vi.fn(),
    error: vi.fn()
  }
}

function fakeCtx(): JobRunnerContext & { trackPid: ReturnType<typeof vi.fn> } {
  return {
    signal: new AbortController().signal,
    trackPid: vi.fn(),
    untrackPid: vi.fn(),
    jobId: 'extract-audio-job-1'
  }
}

const PARAMS: JobParams['extract-audio'] = {
  projectId: 'p1',
  sourcePath: '/src/in.mp4'
}

describe('extract-audio-runner', () => {
  it('tracks the ffmpeg PID and forwards the cooperative AbortSignal (cancel must be able to reach the child)', async () => {
    const ctx = fakeCtx()
    const extractAudio = vi.fn(async (opts: ExtractAudioOptions) => {
      opts.onSpawn?.(4242)
      return { wavPath: '/cache/audio.16k.wav', cached: false }
    })
    const runner = createExtractAudioRunner({
      probeVideo: async () => ({ duration: 120 }),
      extractAudio
    })

    await runner(PARAMS, fakeEmitter(), ctx)

    expect(ctx.trackPid).toHaveBeenCalledWith(4242)
    expect(extractAudio).toHaveBeenCalledWith(expect.objectContaining({ signal: ctx.signal }))
  })

  it('streams progress across the run (not a single frozen value)', async () => {
    const emit = fakeEmitter()
    const runner = createExtractAudioRunner({
      probeVideo: async () => ({ duration: 60 }),
      extractAudio: async (opts) => {
        opts.onProgress?.(25)
        opts.onProgress?.(75)
        return { wavPath: '/cache/audio.16k.wav', cached: false }
      }
    })

    await runner(PARAMS, emit, fakeCtx())

    const pcts = (emit.progress as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(pcts).toEqual([0, 25, 75, 100])
  })

  it('tolerates a probe failure — extraction still succeeds without a duration denominator', async () => {
    const extractAudio = vi.fn(async () => ({ wavPath: '/cache/audio.16k.wav', cached: true }))
    const runner = createExtractAudioRunner({
      probeVideo: async () => {
        throw new Error('ffprobe: no such file')
      },
      extractAudio
    })

    const result = await runner(PARAMS, fakeEmitter(), fakeCtx())

    expect(result).toEqual({ wavPath: '/cache/audio.16k.wav', cached: true })
    expect(extractAudio).toHaveBeenCalledWith(expect.objectContaining({ durationSec: undefined }))
  })

  it('returns cache hits as-is (a re-extract of an already-cached source is near-instant)', async () => {
    const runner = createExtractAudioRunner({
      probeVideo: async () => ({ duration: 60 }),
      extractAudio: async () => ({ wavPath: '/cache/audio.16k.wav', cached: true })
    })
    const result = await runner(PARAMS, fakeEmitter(), fakeCtx())
    expect(result.cached).toBe(true)
  })
})
