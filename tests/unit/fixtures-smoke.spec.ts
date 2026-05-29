/**
 * tests/unit/fixtures-smoke.spec.ts — @serial real-binary smoke for the
 * synthetic-fixture harness (PRD §18 / plan E.10): generates the testsrc2+sine
 * media with the REAL FFmpeg and structurally asserts it via ffprobe (no pixel
 * diffing). The `@serial` name tag marks it for the machine-global lock (E.7);
 * it is skipped automatically if FFmpeg is unavailable so the mocked suite is
 * never blocked.
 */

import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { ensureFixtures, ffmpegAvailable } from '../harness/fixtures'

const ffprobeBin = (): string => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require('ffmpeg-ffprobe-static') as { ffprobePath?: string }
    return m.ffprobePath ?? 'ffprobe'
  } catch {
    return 'ffprobe'
  }
}

describe.skipIf(!ffmpegAvailable())(
  '@serial fixtures: synthetic media generation (real FFmpeg)',
  () => {
    it('generates a non-empty testsrc2 mp4 + 16kHz sine wav and ffprobe reads them', () => {
      const fx = ensureFixtures()

      expect(statSync(fx.videoMp4).size).toBeGreaterThan(0)
      expect(statSync(fx.audioWav).size).toBeGreaterThan(0)

      const probe = spawnSync(
        ffprobeBin(),
        ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', fx.videoMp4],
        { encoding: 'utf8' }
      )
      expect(probe.status).toBe(0)
      const meta = JSON.parse(probe.stdout) as {
        format: { duration: string }
        streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number }>
      }
      const video = meta.streams.find((s) => s.codec_type === 'video')!
      expect(video.codec_name).toBe('h264')
      expect(video.width).toBe(1280)
      expect(video.height).toBe(720)
      expect(Number(meta.format.duration)).toBeCloseTo(4, 0)

      // The audio fixture is the 16kHz mono shape the extraction pipeline targets.
      const aProbe = spawnSync(
        ffprobeBin(),
        ['-v', 'quiet', '-print_format', 'json', '-show_streams', fx.audioWav],
        { encoding: 'utf8' }
      )
      const aMeta = JSON.parse(aProbe.stdout) as {
        streams: Array<{ codec_type: string; sample_rate?: string; channels?: number }>
      }
      const audio = aMeta.streams.find((s) => s.codec_type === 'audio')!
      expect(audio.sample_rate).toBe('16000')
      expect(audio.channels).toBe(1)
    })
  }
)
