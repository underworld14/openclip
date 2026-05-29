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
import { existsSync, mkdirSync } from 'node:fs'
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

  if (!existsSync(videoMp4)) {
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
        videoMp4
      ],
      { encoding: 'utf8' }
    )
    if (r.status !== 0) throw new Error(`ffmpeg fixture (video) failed: ${r.stderr ?? r.error}`)
  }

  if (!existsSync(audioWav)) {
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
        audioWav
      ],
      { encoding: 'utf8' }
    )
    if (r.status !== 0) throw new Error(`ffmpeg fixture (audio) failed: ${r.stderr ?? r.error}`)
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
