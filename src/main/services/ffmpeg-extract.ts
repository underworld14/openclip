/**
 * src/main/services/ffmpeg-extract.ts — 16kHz mono WAV extraction (T-Media, E.3).
 *
 * Composes on the trunk's frozen `ffmpeg-core` (`runFfmpeg` + the stderr→progress
 * parser) — never re-implements spawning. Re-exported through the `ffmpeg.ts`
 * barrel so consumers `import { extractAudio } from '@main/services/ffmpeg'`.
 *
 * Verified command (PRD §6.1 / Appendix A):
 *   ffmpeg -i input -vn -acodec pcm_s16le -ar 16000 -ac 1 audio.16k.wav
 *
 * The extracted WAV is CONTENT-ADDRESSED cached under the project's cache dir
 * (PRD §17): keyed on the source file's size + mtime so re-runs of the same
 * source reuse the WAV instead of re-decoding.
 */

import { mkdir, stat, rename, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { runFfmpeg as defaultRunFfmpeg, type RunFfmpegOptions } from './ffmpeg-core'
import { cacheDirFor } from '@main/utils/paths'
import { assertSafePathArg } from '@main/utils/safe-arg'

// ============================================================================
// Pure helpers
// ============================================================================

/**
 * The verified ffmpeg argv for 16kHz mono PCM extraction. `-progress pipe:2
 * -nostats` makes ffmpeg-core's stderr parser emit progress snapshots.
 *
 * `-f wav` is EXPLICIT (not inferred from the output extension): the atomic-cache
 * write (audit fix openclip-2bg) routes the real encode to a `.tmp` path, and
 * without `-f` ffmpeg would fail to choose a muxer for `.tmp` (exit 234). Pinning
 * the muxer decouples extraction from the temp filename. (regression guard for the
 * review finding on openclip-2bg.)
 */
export function audioExtractArgs(sourcePath: string, wavPath: string): string[] {
  return [
    '-hide_banner',
    '-y',
    '-i',
    // Guard against option injection (audit fix openclip-6l6): a sourcePath beginning
    // with '-' would be parsed by ffmpeg as a flag rather than the input filename.
    assertSafePathArg(sourcePath, 'sourcePath'),
    '-vn',
    '-acodec',
    'pcm_s16le',
    '-ar',
    '16000',
    '-ac',
    '1',
    '-f',
    'wav',
    '-progress',
    'pipe:2',
    '-nostats',
    wavPath
  ]
}

/** Content-addressed WAV cache file name from a source's size + mtime (PRD §17). */
export function wavCacheKey(source: { size: number; mtimeMs: number }): string {
  return `src-${source.size}-${Math.round(source.mtimeMs)}.16k.wav`
}

// ============================================================================
// Extraction
// ============================================================================

export interface ExtractAudioOptions {
  projectId: string
  sourcePath: string
  /** Total source duration (s) so progress can be computed (from ffprobe). */
  durationSec?: number
  /** 0..100 progress callback. */
  onProgress?: (pct: number) => void
  /** Cooperative cancel. */
  signal?: AbortSignal
  /** Override the ffmpeg binary (tests / smoke). */
  binPath?: string
  /** Override the base temp dir (tests). */
  baseTemp?: string
  /** Inject the ffmpeg spawn driver (tests). Default: the real `runFfmpeg`. */
  runFfmpeg?: (opts: RunFfmpegOptions) => Promise<unknown>
}

export interface ExtractAudioResult {
  wavPath: string
  /** True when a previously-extracted WAV was reused (cache hit, PRD §17). */
  cached: boolean
}

/**
 * Extract (or reuse the cached) 16kHz mono WAV for a source video. Returns the
 * absolute WAV path. Caches content-addressed under `<temp>/openclip/<projectId>/
 * cache/` keyed on the source's size+mtime so re-imports don't re-decode.
 */
export async function extractAudio(opts: ExtractAudioOptions): Promise<ExtractAudioResult> {
  const runFfmpeg = opts.runFfmpeg ?? defaultRunFfmpeg
  const cacheDir = cacheDirFor(opts.projectId, opts.baseTemp)
  await mkdir(cacheDir, { recursive: true })

  const st = await stat(opts.sourcePath)
  const wavPath = join(cacheDir, wavCacheKey({ size: st.size, mtimeMs: st.mtimeMs }))

  // The presence of `wavPath` is the cache-hit signal, so it MUST mean "complete".
  if (existsSync(wavPath)) {
    opts.onProgress?.(100)
    return { wavPath, cached: true }
  }

  // Atomic write (audit fix openclip-2bg): ffmpeg encodes to a sibling temp in the
  // SAME cache dir, then we `rename` it onto the content-addressed path only after
  // it resolves. A cancel/SIGKILL leaves the partial under the temp name (removed in
  // the catch) — never at `wavPath` — so a killed extraction can't be served as a
  // cache hit and re-poison whisper. `rename` is atomic on the same filesystem.
  const tmpPath = join(cacheDir, `.${randomUUID()}.tmp`)
  try {
    await runFfmpeg({
      args: audioExtractArgs(opts.sourcePath, tmpPath),
      totalDurationSec: opts.durationSec,
      binPath: opts.binPath,
      signal: opts.signal,
      onProgress: (pct) => {
        if (pct !== undefined) opts.onProgress?.(pct)
      }
    })
    await rename(tmpPath, wavPath)
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {})
    throw err
  }

  return { wavPath, cached: false }
}
