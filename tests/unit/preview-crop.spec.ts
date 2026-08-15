/**
 * tests/unit/preview-crop.spec.ts — PURE crop geometry for the WYSIWYG preview
 * (Part K, Step 3). The preview frames the SAME center-crop column the static
 * export uses (cropWidthFor), so this pins the geometry across aspects.
 */

import { describe, it, expect } from 'vitest'
import {
  centerCropRect,
  cssAspectRatio,
  coverFitTransform
} from '@renderer/components/preview-crop'

describe('centerCropRect', () => {
  it('center-crops a 1920×1080 landscape source to a 9:16 column', () => {
    const r = centerCropRect({ width: 1920, height: 1080 }, '9:16')
    expect(r.cropH).toBe(1080)
    expect(r.cropW).toBe(608) // roundEven(1080*9/16 = 607.5) = 608
    expect(r.cropX).toBe(656) // (1920 - 608) / 2
    expect(r.cropY).toBe(0)
  })

  it('a 9:16 portrait source needs no horizontal crop', () => {
    const r = centerCropRect({ width: 1080, height: 1920 }, '9:16')
    expect(r.cropW).toBe(1080)
    expect(r.cropX).toBe(0)
  })

  it('1:1 from a landscape source', () => {
    const r = centerCropRect({ width: 1920, height: 1080 }, '1:1')
    expect(r.cropW).toBe(1080)
    expect(r.cropX).toBe(420)
  })
})

describe('cssAspectRatio', () => {
  it('formats as "W / H"', () => {
    expect(cssAspectRatio('9:16')).toBe('9 / 16')
    expect(cssAspectRatio('1:1')).toBe('1 / 1')
    expect(cssAspectRatio('4:5')).toBe('4 / 5')
    expect(cssAspectRatio('16:9')).toBe('16 / 9')
  })
})

describe('coverFitTransform (EPIC-k83ghw / BUG-t19z5j: split-screen preview)', () => {
  const source = { width: 1920, height: 1080 }

  it('centers the region in the tile — round-trip: the region maps exactly onto the tile', () => {
    // Left-half-width, full-height region into a 1080×960 tile (9:16 split's
    // top/bottom tile size). Region aspect (960/1080) != tile aspect
    // (1080/960), so this genuinely exercises cover-fit, not a coincidence.
    const region = { cropX: 0, cropY: 0, cropW: 960, cropH: 1080 }
    const tile = { width: 1080, height: 960 }
    const t = coverFitTransform(source, region, tile)

    // The region's four corners, mapped through (x*scale + translate), must
    // land exactly on the tile's bounds on the BINDING axis (width here,
    // since 1080/960 > 960/1080 means width is the cover-constraining axis)
    // and be centered (equal overflow both sides) on the other.
    const mapX = (sx: number): number => sx * (t.width / source.width) + t.translateX
    const mapY = (sy: number): number => sy * (t.height / source.height) + t.translateY
    expect(mapX(region.cropX)).toBeCloseTo(0, 5)
    expect(mapX(region.cropX + region.cropW)).toBeCloseTo(tile.width, 5)
    // Vertically the scaled region (1080*scale) is TALLER than the tile — it
    // must overflow symmetrically above and below, not be pinned to an edge.
    const overflowY = mapY(region.cropY + region.cropH) - mapY(region.cropY) - tile.height
    expect(overflowY).toBeGreaterThan(0)
    expect(mapY(region.cropY)).toBeCloseTo(-overflowY / 2, 5)
  })

  it('produces a video sized/positioned so the WHOLE frame still renders (never clips to nothing)', () => {
    const region = { cropX: 400, cropY: 200, cropW: 500, cropH: 700 }
    const tile = { width: 1080, height: 960 }
    const t = coverFitTransform(source, region, tile)
    expect(t.width).toBeGreaterThan(0)
    expect(t.height).toBeGreaterThan(0)
    // Cover-fit never SHRINKS below the tile on either axis.
    expect(t.width * (region.cropW / source.width)).toBeGreaterThanOrEqual(tile.width - 1e-6)
    expect(t.height * (region.cropH / source.height)).toBeGreaterThanOrEqual(tile.height - 1e-6)
  })

  it('returns a degenerate (zero-size) result for a zero-area region or tile, never NaN/Infinity', () => {
    const tile = { width: 1080, height: 960 }
    expect(coverFitTransform(source, { cropX: 0, cropY: 0, cropW: 0, cropH: 100 }, tile)).toEqual({
      width: 0,
      height: 0,
      translateX: 0,
      translateY: 0
    })
    expect(
      coverFitTransform(
        source,
        { cropX: 0, cropY: 0, cropW: 100, cropH: 100 },
        { width: 0, height: 0 }
      )
    ).toEqual({ width: 0, height: 0, translateX: 0, translateY: 0 })
  })

  it('a region already matching the tile aspect needs no asymmetric overflow', () => {
    // 1080×960 region into a 1080×960 tile: scale=1, no overflow on EITHER axis.
    const region = { cropX: 200, cropY: 100, cropW: 1080, cropH: 960 }
    const tile = { width: 1080, height: 960 }
    const t = coverFitTransform(source, region, tile)
    expect(t.width).toBeCloseTo(source.width, 5)
    expect(t.height).toBeCloseTo(source.height, 5)
    expect(t.translateX).toBeCloseTo(-region.cropX, 5)
    expect(t.translateY).toBeCloseTo(-region.cropY, 5)
  })
})
