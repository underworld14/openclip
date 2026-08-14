/**
 * src/main/services/encoder-probe.ts — which video encoder can this machine
 * actually use? (FEAT-5hnsby / PRD §14 "App probes capabilities at startup;
 * Settings shows the active backend".)
 *
 * THE PROBE RUNS THE ENCODER; IT DOES NOT READ A LIST. `ffmpeg -encoders` lists
 * `h264_videotoolbox` on machines that cannot open an encode session with it —
 * VMs, headless sessions, or a Mac already at its concurrent-session limit — and
 * the failure only appears at open time as
 * `cannot create compression session: -12903`. Grepping the encoder list answered
 * "available" on exactly those machines and let a doomed export start anyway.
 * This is the same lesson the CI work landed on in BUG-zcqyb7, which is why the
 * probe encodes one frame instead of asking.
 *
 * Cached for the process lifetime: hardware capability does not change while the
 * app runs, and the probe costs a subprocess.
 */

import { spawnSync } from 'node:child_process'
import type { EncoderBackend } from '@shared/channels'
import { ffmpegPath } from '@main/utils/paths'

let cached: EncoderBackend | null = null

/**
 * Encode a single frame with `h264_videotoolbox` and report whether it worked.
 * Pure-ish: the ffmpeg path is injectable so this is testable without a binary.
 */
export function probeEncoder(resolveFfmpeg: () => string = ffmpegPath): EncoderBackend {
  let ffmpeg: string
  try {
    ffmpeg = resolveFfmpeg()
  } catch {
    return 'unknown'
  }
  if (!ffmpeg) return 'unknown'

  const r = spawnSync(
    ffmpeg,
    // prettier-ignore
    [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=0.1',
      '-c:v', 'h264_videotoolbox', '-frames:v', '1',
      '-f', 'null', '-'
    ],
    { encoding: 'utf8', timeout: 20_000 }
  )
  // `error` is set when the binary could not be spawned at all — that is not the
  // same as "the GPU encoder is unusable", so don't claim CPU on that basis.
  if (r.error) return 'unknown'
  return r.status === 0 ? 'hardware' : 'cpu'
}

/** The probe result for this process, computed once. */
export function encoderBackend(resolveFfmpeg?: () => string): EncoderBackend {
  if (cached === null) cached = probeEncoder(resolveFfmpeg)
  return cached
}

/** TEST-ONLY: forget the cached probe result. */
export function __resetEncoderProbeForTests(): void {
  cached = null
}
