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
 * Map an `ffprobe -show_format -show_streams` JSON document into `SourceVideo`.
 * Throws when the file has no video stream (the importer surfaces INPUT_INVALID).
 */
export function parseFfprobeJson(json: FfprobeJson, path: string): SourceVideo {
  const video = (json.streams ?? []).find((s) => s.codec_type === 'video')
  if (!video) {
    throw new Error(`ffprobe: no video stream in ${path}`)
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
  const { stdout } = await execFileAsync(
    bin,
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { maxBuffer: 16 * 1024 * 1024 }
  )
  return parseFfprobeJson(JSON.parse(stdout) as FfprobeJson, filePath)
}
