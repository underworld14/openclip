/**
 * tests/unit/ass-captions.serial.spec.ts — @serial real-FFmpeg structural test
 * for the CAPTION-BURN path (CAPTION-BURN spine, plan E.5 done-when / E.7 /
 * PRD §18 "FFmpeg structural assertions, no pixel diff"). Runs the REAL bundled
 * ffmpeg (which HAS libass) burning a generated karaoke `.ass` over a synthetic
 * 9:16 clip, then asserts:
 *   - resolution = 1080×1920, codec = h264 (the export canvas survives the burn)
 *   - frame count within ±1 of the requested cut
 *   - libass resolved the BUNDLED font (DejaVuSans.ttf via fontsdir) — stderr
 *     `fontselect: (DejaVu Sans, …) -> DejaVuSans`
 *   - BURNED FRAMES PRESENT: a captioned export differs (finite PSNR) from a
 *     no-caption export of the identical span — i.e. libass actually drew pixels.
 *
 * @serial — runs single-file (machine-global lock): spawns the real binary and
 * may use the Metal/VideoToolbox encoder (plan E.7). SKIPS gracefully when
 * ffmpeg is unavailable so the bulk mocked suite stays green — and the burn case
 * goes through `exportClip` WITHOUT `forceCpu`, so it additionally skips when the
 * resolved ffmpeg has no `h264_videotoolbox` (a macOS-only encoder). The fontsdir
 * case below drives ffmpeg directly with libx264 and stays portable.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import type { CaptionStyle, WordTimestamp } from '@shared/schema'
import { buildAss } from '@main/services/ass-captions'
import { exportClip } from '@main/services/ffmpeg-export'
import {
  ensureFixtures,
  ffmpegAvailable,
  resolveFfmpeg,
  videotoolboxAvailable
} from '../harness/fixtures'

const HAVE_FFMPEG = ffmpegAvailable()
/** The burn case exports without `forceCpu` → h264_videotoolbox → macOS only. */
const HAVE_GPU_ENCODER = HAVE_FFMPEG && videotoolboxAvailable()

/** The repo's bundled libass font dir (build/fonts/DejaVuSans.ttf — PRD §13/fix M3). */
const FONTS_DIR = join(process.cwd(), 'build', 'fonts')

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
}

function probe(path: string): ProbedStream {
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
        'stream=width,height,codec_name,nb_read_frames',
        '-of',
        'json',
        path
      ],
      { encoding: 'utf8' }
    )
  ) as { streams: ProbedStream[] }
  return json.streams[0]
}

/** Run an ffmpeg PSNR compare and return the average dB (Infinity if identical). */
function psnrAverage(a: string, b: string): number {
  const r = spawnSync(
    resolveFfmpeg(),
    ['-hide_banner', '-i', a, '-i', b, '-lavfi', '[0:v][1:v]psnr', '-f', 'null', '-'],
    { encoding: 'utf8' }
  )
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const m = out.match(/average:([0-9.]+|inf)/i)
  if (!m) throw new Error(`psnr: no average in ffmpeg output:\n${out}`)
  return m[1].toLowerCase() === 'inf' ? Infinity : Number(m[1])
}

const STYLE: CaptionStyle = {
  fontFamily: 'DejaVu Sans', // resolves to build/fonts/DejaVuSans.ttf via fontsdir
  fontSize: 72,
  fontColor: '#FFFFFF',
  backgroundColor: '#000000',
  position: 'bottom',
  animation: 'none',
  highlightCurrentWord: true,
  emojiEnabled: false
}

// Words spanning the cut so caption pixels appear in the middle of the clip.
const WORDS: WordTimestamp[] = [
  { word: 'Hello', start: 1.0, end: 1.4, confidence: 0.95 },
  { word: 'burned', start: 1.4, end: 1.9, confidence: 0.95 },
  { word: 'karaoke', start: 1.9, end: 2.5, confidence: 0.95 },
  { word: 'world.', start: 2.5, end: 3.2, confidence: 0.95 }
]

describe('@serial ass-captions — real libass burn over a 9:16 clip', () => {
  it.skipIf(!HAVE_GPU_ENCODER)(
    'burns karaoke captions: 1080×1920 h264, bundled font resolves, frames differ from plain',
    async () => {
      const { videoMp4 } = ensureFixtures()
      const tmp = mkdtempSync(join(tmpdir(), 'openclip-caption-'))
      try {
        // 1. Generate the karaoke .ass from the word timestamps, scoped to [0,4).
        const assPath = join(tmp, 'cap.ass')
        const ass = buildAss({ words: WORDS, clipStart: 0, clipEnd: 4, style: STYLE })
        expect(ass).toContain('Dialogue:')
        expect(ass).toContain('{\\k') // karaoke syllables present
        writeFileSync(assPath, ass, 'utf8')

        const start = 0
        const end = 3.5
        const burned = join(tmp, 'burned.mp4')
        const plain = join(tmp, 'plain.mp4')

        // 2. Burned export (crop,scale,subtitles=…:fontsdir=… — the proven order).
        await exportClip({
          sourcePath: videoMp4,
          outputPath: burned,
          startTime: start,
          endTime: end,
          aspectRatio: '9:16',
          quality: '1080p',
          assPath,
          fontsDir: FONTS_DIR,
          binPath: resolveFfmpeg()
        })

        // 3. Plain export of the SAME span (no captions) for the diff baseline.
        await exportClip({
          sourcePath: videoMp4,
          outputPath: plain,
          startTime: start,
          endTime: end,
          aspectRatio: '9:16',
          quality: '1080p',
          binPath: resolveFfmpeg()
        })

        expect(existsSync(burned)).toBe(true)
        expect(existsSync(plain)).toBe(true)

        // 4. Structural assertions (no pixel diff): canvas + codec + frame count.
        const s = probe(burned)
        expect(s.width).toBe(1080)
        expect(s.height).toBe(1920)
        expect(s.codec_name).toBe('h264')

        const fps = 25
        const expectedFrames = Math.round((end - start) * fps)
        expect(Math.abs(Number(s.nb_read_frames) - expectedFrames)).toBeLessThanOrEqual(1)

        // 5. BURNED FRAMES PRESENT: the captioned export must DIFFER from plain.
        // Identical frames → PSNR average inf; libass drew pixels → finite (low).
        const avg = psnrAverage(burned, plain)
        expect(Number.isFinite(avg)).toBe(true)
        expect(avg).toBeLessThan(50) // clearly different (caption box + glyphs)
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(!HAVE_FFMPEG)(
    'libass resolves the BUNDLED font via fontsdir (fontselect -> DejaVuSans)',
    () => {
      const { videoMp4 } = ensureFixtures()
      const tmp = mkdtempSync(join(tmpdir(), 'openclip-fontsel-'))
      try {
        const assPath = join(tmp, 'cap.ass')
        writeFileSync(
          assPath,
          buildAss({ words: WORDS, clipStart: 0, clipEnd: 4, style: STYLE }),
          'utf8'
        )
        const out = join(tmp, 'burned.mp4')
        // Run ffmpeg directly so we can read libass's fontselect stderr line.
        const r = spawnSync(
          resolveFfmpeg(),
          [
            '-hide_banner',
            '-y',
            '-ss',
            '0',
            '-i',
            videoMp4,
            '-to',
            '3',
            '-vf',
            `crop=ih*9/16:ih,scale=1080:1920,subtitles=${assPath}:fontsdir=${FONTS_DIR}`,
            '-c:v',
            'libx264',
            '-preset',
            'ultrafast',
            '-an',
            out
          ],
          { encoding: 'utf8' }
        )
        const log = `${r.stdout ?? ''}${r.stderr ?? ''}`
        expect(r.status).toBe(0)
        // libass reports the resolved face — proves the bundled DejaVuSans.ttf
        // was found via fontsdir (fix M3), not a host-installed substitute.
        expect(log).toMatch(/fontselect:\s*\(DejaVu Sans.*->\s*DejaVuSans/i)
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    }
  )
})
