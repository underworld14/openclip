/**
 * tests/unit/ass-playres.serial.spec.ts — burn the real .ass with the real libass
 * and MEASURE the caption, per aspect ratio (BUG-y6y5mf).
 *
 * The unit spec next door asserts the arithmetic; this asserts the thing the user
 * actually sees. It renders each aspect's script onto a black canvas of that
 * aspect's real dimensions and reads the ink bounding box out of ffmpeg's `bbox`
 * filter — the same method the bug report used, so the numbers are comparable.
 *
 * The property under test: a caption occupies the SAME fraction of frame width on
 * every aspect ratio, because that is what the live preview shows (`caption-css.ts`
 * sizes in `cqw`). Measured before the fix, that fraction collapsed to 0.70× on
 * 4:5, 0.5625× on 1:1 and 0.316× on 16:9 — the "~30% too small" in the report.
 *
 * `@serial` + skipIf: real binary, one machine, self-skips on a bare checkout.
 */

import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildAss } from '@main/services/ass-captions'
import { outputDimensions } from '@main/services/ffmpeg-export'
import { resolveFfmpeg, ffmpegAvailable } from '../harness/fixtures'

/** The repo's bundled faces — `paths.fontsDir()` needs Electron's `app`. */
const FONTS_DIR = join(process.cwd(), 'build', 'fonts')
import type { AspectRatio, WordTimestamp } from '@shared/schema'

const WORDS: WordTimestamp[] = [
  { word: 'Hello', start: 0.0, end: 0.5, confidence: 0.9 },
  { word: 'world', start: 0.5, end: 1.0, confidence: 0.9 }
]
const ASPECTS: AspectRatio[] = ['9:16', '1:1', '4:5', '16:9']

/** Burn `ass` onto a `w×h` black frame and return the caption's ink bbox. */
function inkBox(
  ffmpeg: string,
  assPath: string,
  w: number,
  h: number
): { width: number; bottomGap: number } {
  const r = spawnSync(
    ffmpeg,
    // prettier-ignore
    [
      '-hide_banner', '-loglevel', 'info',
      '-f', 'lavfi', '-i', `color=c=black:s=${w}x${h}:d=1`,
      '-vf', `subtitles=${assPath}:fontsdir=${FONTS_DIR},format=gray,bbox=min_val=16`,
      '-frames:v', '1', '-f', 'null', '-'
    ],
    { encoding: 'utf8' }
  )
  const line = /x1:\d+ x2:\d+ y1:\d+ y2:(\d+) w:(\d+) h:\d+/.exec(String(r.stderr ?? ''))
  if (!line) throw new Error(`no bbox in ffmpeg output for ${w}x${h}`)
  return { width: Number(line[2]), bottomGap: h - Number(line[1]) }
}

describe.skipIf(!ffmpegAvailable())(
  '@serial ass-playres — real libass burn, measured per aspect',
  () => {
    it('renders a caption at the same fraction of frame width on every aspect', () => {
      const ffmpeg = resolveFfmpeg()
      const dir = mkdtempSync(join(tmpdir(), 'openclip-playres-'))

      const measured = ASPECTS.map((aspect) => {
        const dims = outputDimensions(aspect)
        const assPath = join(dir, `${aspect.replace(':', 'x')}.ass`)
        writeFileSync(
          assPath,
          buildAss({ words: WORDS, clipStart: 0, clipEnd: 2, canvas: dims }),
          'utf8'
        )
        const box = inkBox(ffmpeg, assPath, dims.width, dims.height)
        return { aspect, fraction: box.width / dims.width }
      })

      // The caption was actually drawn (a blank frame would trivially "agree").
      for (const m of measured) expect(m.fraction).toBeGreaterThan(0.1)

      // …and every aspect lands on the same fraction of WIDTH. Before the fix
      // these were 1.0 / 0.5625 / 0.70 / 0.316 of the 9:16 value.
      const reference = measured[0].fraction
      for (const m of measured) {
        expect(
          m.fraction / reference,
          `${m.aspect} caption is ${(m.fraction / reference).toFixed(3)}× the 9:16 width share`
        ).toBeCloseTo(1, 1)
      }
    }, 120_000)

    it('keeps the bottom margin proportional rather than creeping upward', () => {
      const ffmpeg = resolveFfmpeg()
      const dir = mkdtempSync(join(tmpdir(), 'openclip-playres-gap-'))

      // Scoped to the three 1080-wide canvases: they share a scale factor of 1,
      // so the margin must come out identical in real pixels. (16:9 is 1920 wide
      // and scales by 1.78, so its gap is proportionally larger by design.)
      const gaps = (['9:16', '1:1', '4:5'] as AspectRatio[]).map((aspect) => {
        const dims = outputDimensions(aspect)
        const assPath = join(dir, `${aspect.replace(':', 'x')}.ass`)
        writeFileSync(
          assPath,
          buildAss({ words: WORDS, clipStart: 0, clipEnd: 2, canvas: dims }),
          'utf8'
        )
        return inkBox(ffmpeg, assPath, dims.width, dims.height).bottomGap
      })

      // Before the fix these were 87 / 49 / 61 px — the caption crept upward as
      // the canvas got shorter, which is the "~25px higher" in the report.
      expect(new Set(gaps).size, `bottom gaps differ across aspects: ${gaps.join(', ')}`).toBe(1)
    }, 120_000)
  }
)
