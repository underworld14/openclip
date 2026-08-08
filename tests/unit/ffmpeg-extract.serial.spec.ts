/**
 * tests/unit/ffmpeg-extract.serial.spec.ts — @serial real-FFmpeg structural test
 * for the AUDIO-EXTRACTION path (PRD §6.1 / §17). Runs the REAL ffmpeg through
 * `extractAudio` end-to-end — including the atomic `.tmp` → rename cache write
 * (audit fix openclip-2bg) — and ffprobe-asserts the output is genuinely a 16kHz
 * mono PCM WAV.
 *
 * This is the regression guard for the review finding on openclip-2bg: routing the
 * encode through a `.tmp` path made ffmpeg infer the muxer from the extension and
 * fail (exit 234); the unit tests missed it because they inject a fake runFfmpeg.
 * Here the REAL binary must succeed, proving `-f wav` decouples the muxer.
 *
 * @serial — spawns the real binary; SKIPS gracefully when ffmpeg is unavailable so
 * the bulk mocked suite stays green on a bare checkout.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { extractAudio } from '@main/services/ffmpeg-extract'
import { ensureFixtures, ffmpegAvailable, resolveFfmpeg } from '../harness/fixtures'

const HAVE_FFMPEG = ffmpegAvailable()

function ffprobeBin(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require('ffmpeg-ffprobe-static') as { ffprobePath?: string }
    if (m.ffprobePath && existsSync(m.ffprobePath)) return m.ffprobePath
  } catch {
    /* fall through */
  }
  return 'ffprobe'
}

function probeAudio(path: string): { codec: string; sampleRate: number; channels: number } {
  const json = JSON.parse(
    execFileSync(
      ffprobeBin(),
      [
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-show_entries',
        'stream=codec_name,sample_rate,channels',
        '-of',
        'json',
        path
      ],
      { encoding: 'utf8' }
    )
  ) as { streams: { codec_name: string; sample_rate: string; channels: number }[] }
  const s = json.streams[0]
  return { codec: s.codec_name, sampleRate: Number(s.sample_rate), channels: s.channels }
}

describe('@serial ffmpeg-extract — real 16kHz mono WAV through the atomic .tmp path', () => {
  it.skipIf(!HAVE_FFMPEG)(
    'extracts a pcm_s16le 16kHz mono WAV and serves the second call from cache',
    async () => {
      const { videoMp4 } = ensureFixtures()
      const baseTemp = mkdtempSync(join(tmpdir(), 'openclip-extract-'))

      const first = await extractAudio({
        projectId: 'smoke',
        sourcePath: videoMp4,
        baseTemp,
        binPath: resolveFfmpeg()
      })

      expect(first.cached).toBe(false)
      expect(existsSync(first.wavPath)).toBe(true)
      expect(first.wavPath).toMatch(/\.16k\.wav$/)

      const probed = probeAudio(first.wavPath)
      expect(probed.codec).toBe('pcm_s16le')
      expect(probed.sampleRate).toBe(16000)
      expect(probed.channels).toBe(1)

      // Second extraction of the same source is a content-addressed cache hit.
      const second = await extractAudio({
        projectId: 'smoke',
        sourcePath: videoMp4,
        baseTemp,
        binPath: resolveFfmpeg()
      })
      expect(second.cached).toBe(true)
      expect(second.wavPath).toBe(first.wavPath)
    }
  )
})
