/**
 * tests/unit/caption-css.spec.ts — PURE CaptionStyle → CSS for the WYSIWYG
 * preview overlay (Part K, Step 3). Mirrors buildStyleLine semantics.
 */

import { describe, it, expect } from 'vitest'
import {
  captionContainerStyle,
  captionWordStyle,
  isTransparentBg
} from '@renderer/components/caption-css'
import { resolveEffectiveCaptionStyle } from '@renderer/components/captionPresets'

const base = resolveEffectiveCaptionStyle('') // app default (DejaVu, opaque-black bg)

describe('isTransparentBg', () => {
  it('treats 8-digit alpha-00 hex as transparent (no box)', () => {
    expect(isTransparentBg('#00000000')).toBe(true)
    expect(isTransparentBg('#FFFFFF00')).toBe(true)
    expect(isTransparentBg('#000000')).toBe(false) // 6-digit opaque
    expect(isTransparentBg('#1A1A1ACC')).toBe(false)
    expect(isTransparentBg('#00000080')).toBe(false)
  })
})

describe('captionContainerStyle', () => {
  it('scales fontSize via cqw (1080-canvas px → frame width) + bottom by default', () => {
    const css = captionContainerStyle({ ...base, fontSize: 108, position: 'bottom' })
    expect(css.fontSize).toBe('10.000cqw') // 108 / 1080 * 100
    expect(css.bottom).toBe('8%')
  })

  it('honors top/middle position', () => {
    expect(captionContainerStyle({ ...base, position: 'top' }).top).toBe('6%')
    expect(captionContainerStyle({ ...base, position: 'middle' }).top).toBe('50%')
  })
})

describe('captionWordStyle', () => {
  it('the active (spoken) word uses the highlight color', () => {
    const s = { ...base, fontColor: '#FFFFFF', highlightColor: '#FFD700' }
    expect(captionWordStyle(s, { active: false }).color).toBe('#FFFFFF')
    expect(captionWordStyle(s, { active: true }).color).toBe('#FFD700')
  })

  it('a keyword uses keyword color/bold/scale', () => {
    const s = { ...base, keywordColor: '#00FF00', keywordBold: true, keywordScale: 120 }
    const css = captionWordStyle(s, { active: false, keyword: true })
    expect(css.color).toBe('#00FF00')
    expect(css.fontWeight).toBe(900)
    expect(css.transform).toBe('scale(1.2)')
  })

  it('opaque bg draws a box; transparent bg does not', () => {
    expect(
      captionWordStyle({ ...base, backgroundColor: '#000000' }, { active: false }).backgroundColor
    ).toBe('#000000')
    expect(
      captionWordStyle({ ...base, backgroundColor: '#00000000' }, { active: false }).backgroundColor
    ).toBeUndefined()
  })
})
