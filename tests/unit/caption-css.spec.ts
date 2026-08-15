/**
 * tests/unit/caption-css.spec.ts — PURE CaptionStyle → CSS for the WYSIWYG
 * preview overlay (Part K, Step 3). Mirrors buildStyleLine semantics.
 */

import { describe, it, expect } from 'vitest'
import {
  captionContainerStyle,
  captionWordStyle,
  captionWordAnimationClass,
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
    // The burn's ASS Style hardcodes MarginV=80 in a PlayResY of 1920 for a
    // 9:16 export (ass-captions.ts buildStyleLine + playResFor) — 80/1920 =
    // 4.167%, NOT an arbitrary preview-only constant (EPIC-k83ghw / BUG-t19z5j).
    expect(css.bottom).toBe('4.167%')
  })

  it('honors top/middle position', () => {
    expect(captionContainerStyle({ ...base, position: 'top' }).top).toBe('4.167%')
    expect(captionContainerStyle({ ...base, position: 'middle' }).top).toBe('50%')
  })

  it('the vertical margin percentage varies by aspect (EPIC-k83ghw / BUG-t19z5j)', () => {
    // MarginV is a FIXED pixel value in a PlayResY that itself scales with the
    // output aspect ratio — a single hardcoded percentage could not be correct
    // for more than one aspect at a time. 1:1 → PlayResY 1080 → 80/1080=7.407%.
    expect(captionContainerStyle({ ...base, position: 'bottom' }, '1:1').bottom).toBe('7.407%')
    // 16:9 → PlayResY round(1080*9/16)=608 → 80/608=13.158%.
    expect(captionContainerStyle({ ...base, position: 'bottom' }, '16:9').bottom).toBe('13.158%')
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

  it('suppresses the static keyword scale when a per-word animation is active (openclip-yuk)', () => {
    // The burn (ass-captions) drops the keyword \fscx/\fscy when perWordAnimation
    // drives the scale; the preview must match so WYSIWYG holds.
    const animated = { ...base, keywordScale: 120, perWordAnimation: 'bounce' as const }
    const css = captionWordStyle(animated, { active: false, keyword: true })
    expect(css.transform).toBeUndefined()
    // 'none' is NOT an active animation — the static scale still applies.
    const none = { ...base, keywordScale: 120, perWordAnimation: 'none' as const }
    expect(captionWordStyle(none, { active: false, keyword: true }).transform).toBe('scale(1.2)')
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

describe('captionWordAnimationClass — per-word reveal animation in the preview (openclip-4v1)', () => {
  it('returns the bounce/pop class only for the CURRENT word', () => {
    const bounce = { ...base, perWordAnimation: 'bounce' as const }
    expect(captionWordAnimationClass(bounce, true)).toBe('oc-cap-bounce')
    expect(captionWordAnimationClass(bounce, false)).toBeUndefined()
    const pop = { ...base, perWordAnimation: 'pop' as const }
    expect(captionWordAnimationClass(pop, true)).toBe('oc-cap-pop')
  })

  it("returns undefined for 'none' or an unset animation even on the current word", () => {
    expect(
      captionWordAnimationClass({ ...base, perWordAnimation: 'none' as const }, true)
    ).toBeUndefined()
    expect(captionWordAnimationClass(base, true)).toBeUndefined()
  })
})
