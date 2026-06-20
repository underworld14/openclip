/**
 * src/main/services/silence-detect.ts — detect silence intervals in a clip span
 * via FFmpeg's `silencedetect` filter (Part I.4 jump-cuts). PURE arg-builder +
 * stderr parser (unit-tested offline); the spawn is `ffmpeg-core.runFfmpeg`,
 * injectable so tests pass canned stderr and never spawn a real binary.
 *
 *   ffmpeg -ss <start> -i src -t <dur> -af silencedetect=noise=<dB>dB:d=<sec>
 *          -f null -                       (logs silence_start/_end to stderr)
 *
 * `-ss` before `-i` makes the reported timestamps 0-based (relative to the seek),
 * exactly like the export cut; `detectSilences` offsets them back to ABSOLUTE
 * source seconds so they line up with the clip bounds + transcript word times.
 */

import { runFfmpeg as defaultRunFfmpeg } from './ffmpeg-core'
import { assertSafePathArg } from '@main/utils/safe-arg'
import type { Range } from '@shared/keep-ranges'

export interface SilenceDetectTuning {
  /** Silence threshold in dBFS (quieter than this counts as silence). Default -30. */
  noiseDb?: number
  /** Minimum silence duration to report (the filter's `d=`). Default 0.5s. */
  minSilenceSec?: number
}

/** Build the `silencedetect` argv for a clip span (pure — unit-tested). */
export function silenceDetectArgs(
  sourcePath: string,
  startTime: number,
  durationSec: number,
  tuning: SilenceDetectTuning = {}
): string[] {
  const noiseDb = tuning.noiseDb ?? -30
  const minSilence = tuning.minSilenceSec ?? 0.5
  return [
    '-hide_banner',
    '-nostats',
    '-ss',
    String(startTime),
    '-i',
    // Option-injection guard (audit fix openclip-6l6).
    assertSafePathArg(sourcePath, 'sourcePath'),
    '-t',
    String(durationSec),
    '-af',
    `silencedetect=noise=${noiseDb}dB:d=${minSilence}`,
    '-f',
    'null',
    '-'
  ]
}

/**
 * Parse FFmpeg silencedetect stderr into 0-based `[start, end]` intervals. The
 * filter logs `silence_start: <t>` then `silence_end: <t> | silence_duration:…`;
 * we pair them in order. A trailing unpaired `silence_start` (silence running to
 * EOF) is closed at `endFallback` when provided.
 */
export function parseSilences(stderr: string, endFallback?: number): Range[] {
  const ranges: Range[] = []
  let openStart: number | null = null
  for (const line of stderr.split('\n')) {
    const ms = /silence_start:\s*(-?[\d.]+)/.exec(line)
    if (ms) {
      openStart = Math.max(0, parseFloat(ms[1]))
      continue
    }
    const me = /silence_end:\s*(-?[\d.]+)/.exec(line)
    if (me && openStart !== null) {
      ranges.push([openStart, parseFloat(me[1])])
      openStart = null
    }
  }
  if (openStart !== null && endFallback !== undefined && endFallback > openStart) {
    ranges.push([openStart, endFallback])
  }
  return ranges
}

export interface DetectSilencesOptions extends SilenceDetectTuning {
  sourcePath: string
  /** Absolute clip start/end (seconds). */
  startTime: number
  endTime: number
  signal?: AbortSignal
  binPath?: string
  /** Injectable ffmpeg runner (defaults to ffmpeg-core.runFfmpeg). */
  run?: (opts: { args: string[]; binPath?: string; signal?: AbortSignal }) => Promise<{
    stderr: string
  }>
}

/**
 * Detect silences in `[startTime, endTime]` and return them as ABSOLUTE source
 * `[start, end]` ranges (the parsed 0-based times offset by `startTime`). Returns
 * `[]` for a non-positive span. Never throws on "no silences" — only a real
 * ffmpeg/spawn failure rejects (the caller treats that as "no cut").
 */
export async function detectSilences(opts: DetectSilencesOptions): Promise<Range[]> {
  const dur = opts.endTime - opts.startTime
  if (!(dur > 0)) return []
  const run =
    opts.run ?? ((a) => defaultRunFfmpeg({ args: a.args, binPath: a.binPath, signal: a.signal }))
  const args = silenceDetectArgs(opts.sourcePath, opts.startTime, dur, {
    noiseDb: opts.noiseDb,
    minSilenceSec: opts.minSilenceSec
  })
  const { stderr } = await run({ args, binPath: opts.binPath, signal: opts.signal })
  // Parsed times are 0-based (relative to -ss); offset back to absolute source time.
  return parseSilences(stderr, dur).map(
    ([s, e]) => [s + opts.startTime, e + opts.startTime] as Range
  )
}
