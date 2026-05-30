/**
 * tests/unit/brand-overlay.serial.spec.ts — @serial real-FFmpeg structural test
 * for the brand-kit LOGO OVERLAY (Part K / openclip-au5). Runs the REAL bundled
 * ffmpeg on the synthetic fixture: exports the SAME clip twice (with and without a
 * `bottom-right` logo) and uses ffmpeg's `psnr` filter to prove the overlay
 * actually drew — the logo corner differs while the opposite corner is ≈identical.
 *
 * Structural assertions only (PRD §18 — no pixel diff): resolution/codec via
 * ffprobe + per-corner PSNR deltas. @serial because it spawns the real binary;
 * SKIPS gracefully when ffmpeg is unavailable so the mocked suite stays green.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { exportClip } from '@main/services/ffmpeg-export'
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

function probeWH(path: string): { width: number; height: number; codec: string } {
  const json = JSON.parse(
    execFileSync(
      ffprobeBin(),
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height,codec_name',
        '-of',
        'json',
        path
      ],
      { encoding: 'utf8' }
    )
  ) as { streams: { width: number; height: number; codec_name: string }[] }
  const s = json.streams[0]
  return { width: s.width, height: s.height, codec: s.codec_name }
}

/** Generate a 200×200 solid-red PNG-with-alpha (the brand logo). */
function makeLogoPng(path: string): void {
  const r = spawnSync(
    resolveFfmpeg(),
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=200x200',
      '-frames:v',
      '1',
      '-pix_fmt',
      'rgba',
      path
    ],
    { encoding: 'utf8' }
  )
  if (r.status !== 0) throw new Error(`logo PNG fixture failed: ${r.stderr ?? r.error}`)
}

/**
 * Average PSNR (dB) between the same crop region of two clips via ffmpeg's `psnr`
 * filter. Returns Infinity when the regions are pixel-identical (`average:inf`).
 */
function cornerPsnr(a: string, b: string, cropExpr: string): number {
  const r = spawnSync(
    resolveFfmpeg(),
    [
      '-i',
      a,
      '-i',
      b,
      '-filter_complex',
      `[0:v]crop=${cropExpr}[x];[1:v]crop=${cropExpr}[y];[x][y]psnr`,
      '-f',
      'null',
      '-'
    ],
    { encoding: 'utf8' }
  )
  const m = (r.stderr ?? '').match(/average:(inf|[0-9.]+)/)
  if (!m) throw new Error(`could not parse PSNR from ffmpeg stderr:\n${r.stderr}`)
  return m[1] === 'inf' ? Infinity : Number(m[1])
}

describe('@serial brand logo overlay — real ffmpeg', () => {
  it.skipIf(!HAVE_FFMPEG)(
    'draws a bottom-right logo: the logo corner differs, the opposite corner is ≈unchanged',
    async () => {
      const { videoMp4 } = ensureFixtures() // 1280×720 25fps 4s
      const tmp = mkdtempSync(join(tmpdir(), 'openclip-logo-'))
      try {
        const logoPng = join(tmp, 'logo.png')
        const noLogoOut = join(tmp, 'plain.mp4')
        const logoOut = join(tmp, 'logo.mp4')
        makeLogoPng(logoPng)

        const common = {
          sourcePath: videoMp4,
          startTime: 1.0,
          endTime: 3.0,
          aspectRatio: '9:16' as const,
          quality: '1080p' as const,
          forceCpu: true, // deterministic CPU encode → clean PSNR comparison
          binPath: resolveFfmpeg()
        }
        await exportClip({ ...common, outputPath: noLogoOut })
        const result = await exportClip({
          ...common,
          outputPath: logoOut,
          logoPath: logoPng,
          logoPosition: 'bottom-right',
          logoScale: 0.18,
          logoMargin: 48
        })

        // Structural: a 1080×1920 h264 clip (the overlay didn't change geometry).
        expect(result.width).toBe(1080)
        expect(result.height).toBe(1920)
        const probed = probeWH(logoOut)
        expect(probed).toEqual({ width: 1080, height: 1920, codec: 'h264' })

        // Bottom-right 300×300 block contains the ~194px logo (inset 48) → DIFFERS.
        const brPsnr = cornerPsnr(logoOut, noLogoOut, '300:300:780:1620')
        // Top-left 300×300 block has no logo → ≈identical between the two exports.
        const tlPsnr = cornerPsnr(logoOut, noLogoOut, '300:300:0:0')

        // The logo corner is measurably different (finite PSNR, well below the
        // clean corner); the opposite corner is essentially untouched.
        expect(Number.isFinite(brPsnr)).toBe(true)
        expect(brPsnr).toBeLessThan(50)
        expect(tlPsnr).toBeGreaterThan(brPsnr)
        expect(tlPsnr).toBeGreaterThan(40)
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    }
  )
})
