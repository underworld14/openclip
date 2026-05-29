/**
 * tests/unit/preview-crop.spec.ts — PURE crop geometry for the WYSIWYG preview
 * (Part K, Step 3). The preview frames the SAME center-crop column the static
 * export uses (cropWidthFor), so this pins the geometry across aspects.
 */

import { describe, it, expect } from 'vitest'
import { centerCropRect, cssAspectRatio } from '@renderer/components/preview-crop'

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
