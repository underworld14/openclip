/**
 * tests/unit/ass-playres.spec.ts — the .ass script resolution must follow the
 * export canvas (BUG-y6y5mf).
 *
 * `ASS_PLAY_RES` was hardcoded to 1080×1920 and no aspect ratio ever reached the
 * builder, so every export got the same script regardless of canvas. libass
 * scales a script by `realHeight / PlayResY`, so a 4:5 export (1080×1350) shrank
 * every caption by 1350/1920 = 0.70 — measured at 44.5% of frame width instead of
 * 63.2%, sitting ~25px higher off the bottom than the live preview showed. The
 * user got captions ~30% smaller than the size they picked, silently.
 *
 * The fix pins PlayResX to the 1080 design width and derives PlayResY from the
 * canvas, so libass's scale factor is `realWidth / 1080` — the same basis the
 * preview uses (`caption-css.ts` emits `cqw`, container-query *width* units).
 * These specs assert that basis directly, then check the property that actually
 * matters: preview and export agree on every aspect.
 */

import { describe, expect, it } from 'vitest'
import { buildAss, playResFor, ASS_CANVAS_WIDTH, ASS_PLAY_RES } from '@main/services/ass-captions'
import { outputDimensions } from '@main/services/ffmpeg-export'
import type { AspectRatio } from '@shared/schema'
import type { WordTimestamp } from '@shared/schema'

const WORDS: WordTimestamp[] = [
  { word: 'Hello', start: 0.0, end: 0.4, confidence: 0.9 },
  { word: 'world', start: 0.4, end: 0.9, confidence: 0.9 }
]

const assFor = (aspect: AspectRatio): string =>
  buildAss({
    words: WORDS,
    clipStart: 0,
    clipEnd: 2,
    canvas: outputDimensions(aspect)
  })

const playResOf = (ass: string): { x: number; y: number } => ({
  x: Number(/^PlayResX: (\d+)$/m.exec(ass)![1]),
  y: Number(/^PlayResY: (\d+)$/m.exec(ass)![1])
})

const ASPECTS: AspectRatio[] = ['9:16', '1:1', '4:5', '16:9']

describe('playResFor: width pinned, height follows the canvas', () => {
  it('derives PlayResY from the canvas aspect ratio', () => {
    expect(playResFor({ width: 1080, height: 1920 })).toEqual({ x: 1080, y: 1920 })
    expect(playResFor({ width: 1080, height: 1350 })).toEqual({ x: 1080, y: 1350 })
    expect(playResFor({ width: 1080, height: 1080 })).toEqual({ x: 1080, y: 1080 })
    // 16:9 — the width is 1920 in reality, but the SCRIPT stays 1080 wide so
    // libass scales it up by 1.78 rather than rendering a tiny caption.
    expect(playResFor({ width: 1920, height: 1080 })).toEqual({ x: 1080, y: 608 })
  })

  it('always pins PlayResX to the design width', () => {
    for (const aspect of ASPECTS) {
      expect(playResOf(assFor(aspect)).x).toBe(ASS_CANVAS_WIDTH)
    }
  })
})

describe('buildAss: the script resolution matches the export canvas', () => {
  it('emits a distinct PlayResY per aspect ratio', () => {
    const byAspect = Object.fromEntries(ASPECTS.map((a) => [a, playResOf(assFor(a)).y])) as Record<
      AspectRatio,
      number
    >
    expect(byAspect).toEqual({ '9:16': 1920, '1:1': 1080, '4:5': 1350, '16:9': 608 })
    // Before the fix every one of these was 1920 — the whole defect in one line.
    expect(new Set(Object.values(byAspect)).size).toBe(4)
  })

  it('keeps the 9:16 default byte-identical when no canvas is given', () => {
    // Back-compat: every existing caller and the golden .ass fixtures.
    const withoutCanvas = buildAss({ words: WORDS, clipStart: 0, clipEnd: 2 })
    expect(playResOf(withoutCanvas)).toEqual({ x: ASS_PLAY_RES.x, y: ASS_PLAY_RES.y })
    expect(withoutCanvas).toBe(assFor('9:16'))
  })
})

describe('preview and export agree on caption size', () => {
  /**
   * libass scales the whole script UNIFORMLY by `realHeight / PlayResY` — the
   * height axis, confirmed by measurement (ass-playres.serial.spec.ts): with the
   * old fixed 1920 PlayResY, a 1080×1350 canvas rendered at 1350/1920 = 0.703,
   * exactly the shrinkage in the report. Because PlayResY is now derived from a
   * PlayResX pinned at 1080, that height ratio equals `realWidth / 1080` — so the
   * caption keeps a constant share of frame WIDTH, which is the basis the preview
   * uses (`caption-css.ts` emits `cqw`, container-query width units).
   */
  const FONT_SIZE = 64
  const libassScale = (aspect: AspectRatio): number =>
    outputDimensions(aspect).height / playResOf(assFor(aspect)).y

  it('renders a caption at the same fraction of frame width on every aspect', () => {
    const fractions = ASPECTS.map((aspect) => {
      const { width } = outputDimensions(aspect)
      return (FONT_SIZE * libassScale(aspect)) / width
    })
    const expected = FONT_SIZE / ASS_CANVAS_WIDTH // what the preview shows
    // Within 0.1%: PlayResY is an integer, so 16:9 rounds 607.5 → 608 and lands a
    // hair off exact. Sub-pixel at any real font size; the old code was off by 44%.
    for (const f of fractions) expect(Math.abs(f / expected - 1)).toBeLessThan(0.001)
  })

  it('the OLD hardcoded PlayRes disagreed with the preview — the regression guard', () => {
    // Reproduces the ticket's measured ratios so a revert is unmistakable.
    // Old behaviour: PlayResX/Y pinned at 1080×1920 for every canvas, so libass
    // scaled by realHeight/1920 (uniform scale preserves aspect, so the binding
    // constraint on these canvases is the height ratio).
    const oldScale = (aspect: AspectRatio): number => {
      const { height } = outputDimensions(aspect)
      return height / 1920
    }
    expect(oldScale('9:16')).toBeCloseTo(1.0, 3)
    expect(oldScale('4:5')).toBeCloseTo(0.703, 3) // ~30% too small — the report
    expect(oldScale('1:1')).toBeCloseTo(0.5625, 3)
    expect(oldScale('16:9')).toBeCloseTo(0.5625, 3)

    // After the fix the scale is 1 across the 1080-wide canvases, and scales UP
    // (not down) for the wider 16:9 frame. Measured: 317px → 563px.
    expect(libassScale('9:16')).toBeCloseTo(1.0, 2)
    expect(libassScale('4:5')).toBeCloseTo(1.0, 2)
    expect(libassScale('1:1')).toBeCloseTo(1.0, 2)
    expect(libassScale('16:9')).toBeCloseTo(1.776, 2)
  })
})
