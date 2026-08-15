/**
 * src/main/services/jobs/extract-audio-runner.ts — the `extract-audio` JobRunner
 * (EPIC-k83ghw / BUG-sg6kqg). Registered with the sidecar via
 * `registerRunner('extract-audio', …)` from `ipc/audio.ts` so `JOB_START(
 * 'extract-audio', …)` spawns ffmpeg and streams real progress over the per-job
 * MessagePort, with the child PID tracked for cooperative cancel + kill-on-quit.
 *
 * Replaces the old `audio:extract` plain `invoke` (PRD §6.1), which had no
 * progress, no PID tracking and no cancel — on a multi-hour source the UI
 * showed a frozen bar with a Cancel button that did nothing (the ffmpeg child
 * was unreachable from the renderer's cancel path).
 */

import type { JobResult, JobParams } from '@shared/jobs'
import type { JobRunner, JobEmitter, JobRunnerContext } from '@main/services/sidecar-manager'
import { extractAudio, type ExtractAudioOptions } from '@main/services/ffmpeg-extract'
import { probeVideo } from '@main/utils/ffprobe'
import { isPackagedApp } from '@main/utils/paths'

// ============================================================================
// Injectable dependencies (real defaults; tests pass fakes)
// ============================================================================

export interface ExtractAudioRunnerDeps {
  /** Resolve the source's duration for the ffmpeg progress denominator. */
  probeVideo?: (filePath: string) => Promise<{ duration: number }>
  /** The extraction driver (injected for tests). */
  extractAudio?: (opts: ExtractAudioOptions) => Promise<{ wavPath: string; cached: boolean }>
}

/**
 * Build the `extract-audio` runner. Probes the source for a duration (best
 * effort — extraction still works without one, just without a progress
 * denominator), then extracts the content-addressed 16kHz mono WAV, streaming
 * 0..100 progress and tracking the ffmpeg PID for cancel/kill-on-quit.
 */
export function createExtractAudioRunner(
  deps: ExtractAudioRunnerDeps = {}
): JobRunner<'extract-audio'> {
  const probe = deps.probeVideo ?? probeVideo
  const extract = deps.extractAudio ?? extractAudio

  return async (
    params: JobParams['extract-audio'],
    emit: JobEmitter<'extract-audio'>,
    ctx: JobRunnerContext
  ): Promise<JobResult['extract-audio']> => {
    emit.progress(0, 'extracting')

    // Tolerate probe failure — extraction still works, just without a duration
    // denominator (the progress bar then sits at the last known pct until done).
    let durationSec: number | undefined
    try {
      durationSec = (await probe(params.sourcePath)).duration
    } catch {
      durationSec = undefined
    }

    const { wavPath, cached } = await extract({
      projectId: params.projectId,
      sourcePath: params.sourcePath,
      durationSec,
      signal: ctx.signal,
      onSpawn: (pid) => ctx.trackPid(pid),
      onExit: (pid) => ctx.untrackPid?.(pid),
      onProgress: (pct) => emit.progress(pct, 'extracting')
    })

    emit.progress(100, 'extracting')
    return { wavPath, cached }
  }
}

// ============================================================================
// E2E fake-sidecar runner (plan E.10): OPENCLIP_FAKE_TRANSCRIBE skips the real
// ffmpeg decode so the vertical-slice E2E can drive extract→transcribe without
// a media file (mirrors the old audio:extract handler's fake-mode branch).
// ============================================================================

function createFakeExtractAudioRunner(): JobRunner<'extract-audio'> {
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 15))
  return async (params, emit): Promise<JobResult['extract-audio']> => {
    await tick()
    emit.progress(50, 'extracting')
    await tick()
    emit.progress(100, 'extracting')
    return { wavPath: `/tmp/openclip/${params.projectId}/cache/audio.16k.wav`, cached: false }
  }
}

/**
 * The default runner: env-stubbed fake for E2E, else the real ffmpeg services.
 * `!isPackagedApp()` (BUG-hqbett): a packaged app must never let a stray
 * `OPENCLIP_FAKE_TRANSCRIBE` in the environment silently swap the real ffmpeg
 * extraction for a no-op fake that returns a fabricated WAV path.
 */
export const extractAudioRunner: JobRunner<'extract-audio'> =
  process.env.OPENCLIP_FAKE_TRANSCRIBE && !isPackagedApp()
    ? createFakeExtractAudioRunner()
    : createExtractAudioRunner()
