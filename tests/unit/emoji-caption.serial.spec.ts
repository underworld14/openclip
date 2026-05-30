/**
 * tests/unit/emoji-caption.serial.spec.ts — @serial real-FFmpeg proof that an
 * auto-emoji caption actually BURNS an emoji glyph (Part K / openclip-bfs).
 *
 * Burns two captions built by the real `buildAss` over the fixture with
 * `build/fonts` on the libass fontsdir: "fire 🔥" (autoEmoji:'local') vs "fire"
 * (autoEmoji:'off'). The caption region MUST differ — the 🔥 codepoint rendered a
 * glyph — while a region with no caption stays identical.
 *
 * NOTE on the bundled font: `build/fonts/NotoEmoji-Regular.ttf` is what guarantees
 * the glyph renders on hosts WITHOUT a system emoji font (the packaged app isolates
 * libass to the bundled fontsdir). On a dev machine libass may instead pull the
 * glyph from a system emoji font via fontconfig/CoreText — so this test asserts the
 * user-visible behavior (an emoji burns) rather than which font supplied it.
 *
 * Structural only (PRD §18 — per-region PSNR, no pixel diff). @serial: spawns the
 * real binary; SKIPS when ffmpeg is unavailable so the mocked suite stays green.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { exportClip } from '@main/services/ffmpeg-export'
import { buildAss, DEFAULT_CAPTION_STYLE } from '@main/services/ass-captions'
import { ensureFixtures, ffmpegAvailable, resolveFfmpeg } from '../harness/fixtures'

const HAVE_FFMPEG = ffmpegAvailable()
const BUILD_FONTS = join(process.cwd(), 'build', 'fonts')

/** Average PSNR (dB) of a crop region between two clips; Infinity ⇒ identical. */
function regionPsnr(a: string, b: string, cropExpr: string): number {
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

describe('@serial emoji caption burn — auto-emoji renders a glyph', () => {
  it.skipIf(!HAVE_FFMPEG)(
    'an autoEmoji caption burns 🔥 (caption region differs vs the same caption with no emoji)',
    async () => {
      const { videoMp4 } = ensureFixtures()
      const tmp = mkdtempSync(join(tmpdir(), 'openclip-emoji-'))
      try {
        // Real generator: "fire" → 🔥 (EMOJI_DICT) when autoEmoji:'local'.
        const baseStyle = { ...DEFAULT_CAPTION_STYLE, position: 'middle' as const, fontSize: 160 }
        const words = [{ word: 'fire', start: 0.2, end: 1.8, confidence: 1 }]
        const assOn = buildAss({
          words,
          clipStart: 0,
          clipEnd: 2,
          style: { ...baseStyle, autoEmoji: 'local' }
        })
        const assOff = buildAss({
          words,
          clipStart: 0,
          clipEnd: 2,
          style: { ...baseStyle, autoEmoji: 'off' }
        })
        expect(assOn).toContain('🔥')
        expect(assOff).not.toContain('🔥')

        const onPath = join(tmp, 'on.ass')
        const offPath = join(tmp, 'off.ass')
        writeFileSync(onPath, assOn, 'utf8')
        writeFileSync(offPath, assOff, 'utf8')

        const common = {
          sourcePath: videoMp4,
          startTime: 1.0,
          endTime: 3.0,
          aspectRatio: '9:16' as const,
          quality: '1080p' as const,
          forceCpu: true,
          fontsDir: BUILD_FONTS,
          binPath: resolveFfmpeg()
        }
        const onOut = join(tmp, 'on.mp4')
        const offOut = join(tmp, 'off.mp4')
        await exportClip({ ...common, outputPath: onOut, assPath: onPath })
        await exportClip({ ...common, outputPath: offOut, assPath: offPath })

        // The 🔥 glyph rendered: the centered caption band differs between on/off…
        const band = '1080:600:0:660'
        const emojiPsnr = regionPsnr(onOut, offOut, band)
        expect(Number.isFinite(emojiPsnr)).toBe(true)
        expect(emojiPsnr).toBeLessThan(60)
        // …while a region with no caption (top of frame) is identical.
        expect(regionPsnr(onOut, offOut, '1080:300:0:0')).toBeGreaterThan(60)
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    }
  )
})
