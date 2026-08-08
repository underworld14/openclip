/**
 * tests/unit/ffmpeg-export.serial.spec.ts — @serial real-FFmpeg structural test
 * for the EXPORT path (plan E.5 done-when / E.7 / PRD §18 "FFmpeg structural
 * assertions, no pixel diff"). Runs the REAL bundled ffmpeg (ffmpeg-static, which
 * HAS h264_videotoolbox) on a synthetic fixture and ffprobe-asserts the output:
 *   - resolution = 1080×1920
 *   - codec      = h264
 *   - duration / frame count within ±1 frame of the requested cut span
 *   - first-frame PTS ≈ 0 (cut accuracy)
 *
 * @serial — runs single-file (machine-global lock): it spawns the real binary
 * and may use the Metal/VideoToolbox encoder (plan E.7). It SKIPS gracefully
 * when ffmpeg is unavailable so the bulk mocked suite stays green.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { exportClip, generateThumbnail } from '@main/services/ffmpeg-export'
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

interface ProbedStream {
  width: number
  height: number
  codec_name: string
  nb_read_frames: string
  avg_frame_rate: string
}

function probe(path: string): { stream: ProbedStream; durationSec: number; firstPts: number } {
  const json = JSON.parse(
    execFileSync(
      ffprobeBin(),
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-count_frames',
        '-show_entries',
        'stream=width,height,codec_name,nb_read_frames,avg_frame_rate',
        '-show_entries',
        'format=duration',
        '-of',
        'json',
        path
      ],
      { encoding: 'utf8' }
    )
  ) as { streams: ProbedStream[]; format: { duration: string } }

  // `csv=p=0` of a single entry yields e.g. "0.000000," (trailing comma) — take
  // the first CSV field so `Number(...)` doesn't choke on the comma → NaN.
  const ptsRaw = execFileSync(
    ffprobeBin(),
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'frame=pts_time',
      '-read_intervals',
      '%+#1',
      '-of',
      'csv=p=0',
      path
    ],
    { encoding: 'utf8' }
  )
  const firstPts = Number(ptsRaw.trim().split(',')[0])

  return {
    stream: json.streams[0],
    durationSec: Number(json.format.duration),
    firstPts
  }
}

describe('@serial ffmpeg-export — real cut + 9:16 reframe re-encode', () => {
  it.skipIf(!HAVE_FFMPEG)(
    'exports a 1080×1920 h264 clip whose duration is within ±1 frame of the cut',
    async () => {
      const { videoMp4 } = ensureFixtures()
      const tmp = mkdtempSync(join(tmpdir(), 'openclip-export-'))
      try {
        const out = join(tmp, 'clip.mp4')
        // Cut [1.0, 3.5) of the 25fps fixture → a 2.5s = 62.5≈63-frame clip.
        const start = 1.0
        const end = 3.5
        const result = await exportClip({
          sourcePath: videoMp4,
          outputPath: out,
          startTime: start,
          endTime: end,
          aspectRatio: '9:16',
          quality: '1080p',
          binPath: resolveFfmpeg()
        })

        expect(result.width).toBe(1080)
        expect(result.height).toBe(1920)
        expect(result.durationMs).toBe(2500)
        expect(existsSync(out)).toBe(true)

        const { stream, durationSec, firstPts } = probe(out)
        // Structural assertions (PRD §18) — no pixel diff.
        expect(stream.width).toBe(1080)
        expect(stream.height).toBe(1920)
        expect(stream.codec_name).toBe('h264')

        // Frame rate of the fixture is 25fps → one frame = 0.04s.
        const fps = 25
        const oneFrameSec = 1 / fps
        const requested = end - start

        // Duration within ±1 frame of the requested span.
        expect(Math.abs(durationSec - requested)).toBeLessThanOrEqual(oneFrameSec + 1e-6)

        // Frame count within ±1 of the expected (re-encoded frames).
        const expectedFrames = Math.round(requested * fps)
        const actualFrames = Number(stream.nb_read_frames)
        expect(Math.abs(actualFrames - expectedFrames)).toBeLessThanOrEqual(1)

        // Cut accuracy: the output's first frame starts at PTS 0 (re-encode, not copy).
        expect(firstPts).toBeLessThanOrEqual(oneFrameSec + 1e-6)
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(!HAVE_FFMPEG)('exports a libx264 (forceCpu) clip at 1080×1920 h264', async () => {
    const { videoMp4 } = ensureFixtures()
    const tmp = mkdtempSync(join(tmpdir(), 'openclip-export-cpu-'))
    try {
      const out = join(tmp, 'clip-cpu.mp4')
      await exportClip({
        sourcePath: videoMp4,
        outputPath: out,
        startTime: 0.5,
        endTime: 1.5,
        aspectRatio: '9:16',
        quality: '1080p',
        forceCpu: true,
        binPath: resolveFfmpeg()
      })
      const { stream } = probe(out)
      expect(stream.width).toBe(1080)
      expect(stream.height).toBe(1920)
      expect(stream.codec_name).toBe('h264')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it.skipIf(!HAVE_FFMPEG)('generates a 1080×1920 reframed thumbnail (-vframes 1)', async () => {
    const { videoMp4 } = ensureFixtures()
    const tmp = mkdtempSync(join(tmpdir(), 'openclip-thumb-'))
    try {
      const out = join(tmp, 'thumb.jpg')
      const { thumbnailPath } = await generateThumbnail({
        sourcePath: videoMp4,
        outputPath: out,
        atTime: 1.0,
        aspectRatio: '9:16',
        binPath: resolveFfmpeg()
      })
      expect(thumbnailPath).toBe(out)
      const { stream } = probe(out)
      expect(stream.width).toBe(1080)
      expect(stream.height).toBe(1920)
      expect(stream.codec_name).toBe('mjpeg')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it.skipIf(!HAVE_FFMPEG)(
    'a 2-up SPLIT export is bounded to the CLIP span, not the whole source (review-critical guard)',
    async () => {
      const { videoMp4 } = ensureFixtures() // 1280×720 25fps 4s
      const tmp = mkdtempSync(join(tmpdir(), 'openclip-split-'))
      try {
        const out = join(tmp, 'split.mp4')
        // Cut [1.0, 3.0) = 2.0s of the 4s source with a 2-speaker split plan. The
        // bug (missing -ss/-t) would re-encode the FULL 4s source → ~4s output.
        const result = await exportClip({
          sourcePath: videoMp4,
          outputPath: out,
          startTime: 1.0,
          endTime: 3.0,
          aspectRatio: '9:16',
          quality: '1080p',
          forceCpu: true,
          binPath: resolveFfmpeg(),
          reframePlan: {
            mode: 'split',
            regions: [
              { cropX: 0, cropY: 0, cropW: 640, cropH: 720 },
              { cropX: 640, cropY: 0, cropW: 640, cropH: 720 }
            ]
          }
        })
        expect(result.width).toBe(1080)
        expect(result.height).toBe(1920)
        const { stream, durationSec } = probe(out)
        expect(stream.width).toBe(1080)
        expect(stream.height).toBe(1920)
        expect(stream.codec_name).toBe('h264')
        // Duration ≈ the 2.0s clip span (NOT the 4s source) — within ~3 frames.
        expect(Math.abs(durationSec - 2.0)).toBeLessThanOrEqual(0.12)
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    }
  )
  it.skipIf(!HAVE_FFMPEG)(
    'a silence-removal export renders exactly the kept spans (real-binary jump-cut guard)',
    async () => {
      const { videoMp4 } = ensureFixtures() // 1280×720 25fps 4s
      const tmp = mkdtempSync(join(tmpdir(), 'openclip-jumpcut-'))
      try {
        const out = join(tmp, 'cut.mp4')
        // Cut [1.0, 3.0) = 2.0s and drop the middle 0.5s → 1.5s of kept content.
        //
        // SCOPE (verified, don't over-claim): this pins the multi-range path's OUTPUT
        // duration. It does NOT guard the BUG-ery7v7 fix itself — the `select`
        // predicates bound the output regardless of where `-t` sits, so this stays
        // green even with `-t` back on the output side or with an inflated demux
        // slack (checked: DEMUX_SLACK_SEC=2.0 still passes). The argv-position guard
        // lives in ffmpeg-export.spec.ts; the slack-leak guard is the SPLIT case
        // above, which has no `select` chain and so is bounded by `-t` directly.
        const result = await exportClip({
          sourcePath: videoMp4,
          outputPath: out,
          startTime: 1.0,
          endTime: 3.0,
          aspectRatio: '9:16',
          quality: '1080p',
          forceCpu: true,
          binPath: resolveFfmpeg(),
          keepRanges: [
            [1.0, 2.0],
            [2.5, 3.0]
          ]
        })
        expect(result.width).toBe(1080)
        const { stream, durationSec } = probe(out)
        expect(stream.width).toBe(1080)
        expect(stream.height).toBe(1920)
        expect(stream.codec_name).toBe('h264')
        // 1.0s + 0.5s kept. NOT 2.0s — that would mean the jump-cut did nothing.
        expect(Math.abs(durationSec - 1.5)).toBeLessThanOrEqual(0.12)
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    }
  )
})
