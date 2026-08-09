/**
 * tests/harness/fixtures.ts — generate tiny deterministic media fixtures with
 * the REAL FFmpeg binary (plan E.10 / PRD §18): `testsrc2` video + `sine` audio,
 * 3–5s, fixed fps + GOP `-g 12`. Used by `@serial` real-binary structural tests
 * (ffprobe assertions) downstream; created lazily + cached so the bulk mocked
 * suite never pays for them.
 *
 * No large binaries / model weights are committed; fixtures are generated into
 * `tests/fixtures/.generated/` (gitignored) on demand.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'

/** Resolve the dev ffmpeg binary (override via OPENCLIP_FFMPEG / ffmpeg-static). */
export function resolveFfmpeg(): string {
  if (process.env.OPENCLIP_FFMPEG) return process.env.OPENCLIP_FFMPEG
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const p = require('ffmpeg-static') as string | null
    if (p) return p
  } catch {
    /* fall through */
  }
  return 'ffmpeg'
}

export interface FixturePaths {
  /** A 4s 1280x720 25fps testsrc2 + sine MP4 with GOP 12. */
  videoMp4: string
  /** A 4s 16kHz mono sine WAV (the audio-extraction target shape). */
  audioWav: string
  dir: string
}

/** Directory holding generated (gitignored) fixtures. */
export function fixturesDir(): string {
  return join(process.cwd(), 'tests', 'fixtures', '.generated')
}

/**
 * Generate (or reuse cached) synthetic fixtures. Returns their paths. Throws if
 * FFmpeg is unavailable — callers in `@serial` real-binary suites should guard
 * on `ffmpegAvailable()`.
 */
export function ensureFixtures(): FixturePaths {
  const dir = fixturesDir()
  mkdirSync(dir, { recursive: true })
  const ffmpeg = resolveFfmpeg()
  const videoMp4 = join(dir, 'testsrc2.mp4')
  const audioWav = join(dir, 'sine.16k.wav')

  // Generate ATOMICALLY (audit fix openclip-lzk): write to a temp file then renameSync
  // into place, so existsSync(target) is only ever true for a COMPLETE file. ffmpeg's
  // `-y` writes the target incrementally, so a non-atomic generation let a concurrent
  // @serial test read a half-written mp4 → "moov atom not found" flakes.
  if (!existsSync(videoMp4)) {
    const tmp = `${videoMp4}.${process.pid}.tmp.mp4`
    const r = spawnSync(
      ffmpeg,
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=1280x720:rate=25:duration=4',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=4',
        '-g',
        '12', // fixed GOP for frame-accurate cut tests
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        tmp
      ],
      { encoding: 'utf8' }
    )
    if (r.status !== 0) throw new Error(`ffmpeg fixture (video) failed: ${r.stderr ?? r.error}`)
    renameSync(tmp, videoMp4)
  }

  if (!existsSync(audioWav)) {
    const tmp = `${audioWav}.${process.pid}.tmp.wav`
    const r = spawnSync(
      ffmpeg,
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=4',
        '-ar',
        '16000',
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        tmp
      ],
      { encoding: 'utf8' }
    )
    if (r.status !== 0) throw new Error(`ffmpeg fixture (audio) failed: ${r.stderr ?? r.error}`)
    renameSync(tmp, audioWav)
  }

  return { videoMp4, audioWav, dir }
}

/** Whether the real FFmpeg binary can be invoked (guard for @serial suites). */
export function ffmpegAvailable(): boolean {
  try {
    const r = spawnSync(resolveFfmpeg(), ['-version'], { encoding: 'utf8' })
    return r.status === 0
  } catch {
    return false
  }
}

/**
 * Whether the resolved FFmpeg can actually ENCODE with `h264_videotoolbox` — the macOS
 * HW encoder `codecArgs()` picks whenever an export does NOT set `forceCpu`
 * (ffmpeg-export.ts). Guard every GPU-path @serial smoke on this; the `forceCpu`
 * (libx264) ones are portable and need only `ffmpegAvailable()`.
 *
 * This probe really runs a one-frame encode, because the two cheaper guards each let a
 * broken environment through and both cost a red CI run to learn:
 *
 *   1. `ffmpegAvailable()` — too weak. `ffmpeg-static` is a devDependency, so ffmpeg is
 *      invokable on a LINUX runner too, where VideoToolbox (a macOS framework) does not
 *      exist: the smokes ran and died with `Unknown encoder` (exit 8), run 31293580008.
 *   2. Grepping `ffmpeg -encoders` — still too weak. On a GitHub `macos-14` runner the
 *      encoder IS listed, then fails to open: `cannot create compression session: -12903`
 *      (run 31294181503). Those runners are VMs with no HW video-encode session.
 *
 * Listing a codec is not the same as being able to use it, so ask the question the specs
 * actually ask. ~1 spawn per spec file; `-f null` discards the muxed output.
 */
export function videotoolboxAvailable(): boolean {
  try {
    const r = spawnSync(
      resolveFfmpeg(),
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x240:rate=5:duration=0.2',
        '-c:v',
        'h264_videotoolbox',
        '-frames:v',
        '1',
        '-f',
        'null',
        '-'
      ],
      { encoding: 'utf8' }
    )
    return r.status === 0
  } catch {
    return false
  }
}
