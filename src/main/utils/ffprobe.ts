/**
 * src/main/utils/ffprobe.ts — probe source-video metadata (T-Media, E.3).
 *
 * Runs the bundled `ffprobe` (resolved via `utils/paths.ts`) to read duration,
 * resolution and fps (PRD §6.1 / Appendix A) and maps the JSON into the frozen
 * `SourceVideo` shape that seeds a Project (PRD §9.3). The mapper
 * (`parseFfprobeJson`) is pure + unit-tested; `probeVideo` spawns the binary.
 *
 *   ffprobe -v quiet -print_format json -show_format -show_streams <file>
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { SourceVideo } from '@shared/schema'
import { ffprobePath } from '@main/utils/paths'
import { assertSafePathArg } from '@main/utils/safe-arg'

const execFileAsync = promisify(execFile)

// ============================================================================
// Minimal structural typing of the ffprobe JSON we read
// ============================================================================

interface FfprobeStream {
  codec_type?: string
  width?: number
  height?: number
  r_frame_rate?: string
  avg_frame_rate?: string
  /** Per-stream duration tag (fallback when the container omits format.duration). */
  duration?: string
}

interface FfprobeFormat {
  filename?: string
  duration?: string
  format_name?: string
}

export interface FfprobeJson {
  streams?: FfprobeStream[]
  format?: FfprobeFormat
}

// ============================================================================
// Pure helpers
// ============================================================================

/** Evaluate an ffprobe frame-rate ratio string (`"30000/1001"`) → fps (3dp). */
export function parseFrameRate(ratio: string | undefined): number {
  if (!ratio) return 0
  const [numStr, denStr = '1'] = ratio.split('/')
  const num = Number(numStr)
  const den = Number(denStr)
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0 || num === 0) return 0
  return Math.round((num / den) * 1000) / 1000
}

/**
 * Thrown for a file that probes cleanly but has no audio stream (EPIC-k83ghw /
 * BUG-aryvgg): a screen recording made without a microphone, a muted export, or
 * silent b-roll used to pass probing, commit a project, and then die minutes
 * later inside audio extraction with a raw ffmpeg error. OpenClip's whole
 * pipeline (transcribe, clip detection) is built on the audio track, so this is
 * caught at the earliest possible point with a plain, actionable sentence
 * instead of a stderr dump the user cannot act on.
 */
export class NoAudioTrackError extends Error {
  constructor() {
    super(
      "This video has no audio track, so OpenClip can't transcribe it or find clips. " +
        'Try a file that has narration, dialogue, or sound.'
    )
    this.name = 'NoAudioTrackError'
  }
}

/**
 * Map an `ffprobe -show_format -show_streams` JSON document into `SourceVideo`.
 * Throws when the file has no video stream (the importer surfaces INPUT_INVALID),
 * or `NoAudioTrackError` when it has no audio stream (BUG-aryvgg).
 */
export function parseFfprobeJson(json: FfprobeJson, path: string): SourceVideo {
  const video = (json.streams ?? []).find((s) => s.codec_type === 'video')
  if (!video) {
    throw new Error(`ffprobe: no video stream in ${path}`)
  }
  const hasAudio = (json.streams ?? []).some((s) => s.codec_type === 'audio')
  if (!hasAudio) {
    throw new NoAudioTrackError()
  }
  const fps = parseFrameRate(video.r_frame_rate) || parseFrameRate(video.avg_frame_rate)
  return {
    path,
    duration: finiteDuration(json),
    resolution: { width: video.width ?? 0, height: video.height ?? 0 },
    fps,
    format: json.format?.format_name ?? ''
  }
}

/**
 * Resolve a FINITE, non-negative duration in seconds (audit fix openclip-bro).
 * ffprobe emits the literal string `"N/A"` for `format.duration` on some real
 * containers (fragmented MP4, certain MKV/transport streams, live captures), and
 * `Number("N/A")` is NaN — which Zod rejects for `SourceVideo.duration` and which
 * NaN-poisons the timeline / progress math downstream. Prefer the format duration,
 * fall back to the longest per-stream duration tag, else 0 (a finite "unknown" the
 * UI can render as such rather than NaN).
 */
function finiteDuration(json: FfprobeJson): number {
  const fmt = Number(json.format?.duration)
  if (Number.isFinite(fmt) && fmt > 0) return fmt
  let best = 0
  for (const s of json.streams ?? []) {
    const d = Number(s.duration)
    if (Number.isFinite(d) && d > best) best = d
  }
  return best
}

// ============================================================================
// Spawn
// ============================================================================

/** Probe a video file and return its `SourceVideo` metadata (PRD §6.1). */
export async function probeVideo(filePath: string, binPath?: string): Promise<SourceVideo> {
  const bin = binPath ?? ffprobePath()
  // Guard the trailing positional path against option injection (audit fix
  // openclip-6l6): a filePath beginning with '-' would be parsed by ffprobe as a flag.
  const safePath = assertSafePathArg(filePath, 'filePath')
  const { stdout } = await execFileAsync(
    bin,
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', safePath],
    { maxBuffer: 16 * 1024 * 1024 }
  )
  return parseFfprobeJson(JSON.parse(stdout) as FfprobeJson, safePath)
}
