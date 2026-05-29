/**
 * tests/unit/brand-kit.spec.ts — PURE brand-kit mapping (Part K, Step 5):
 * BrandTemplate → caption-style override + export logo params.
 */

import { describe, it, expect } from 'vitest'
import {
  brandCaptionOverride,
  brandLogoParams,
  DEFAULT_LOGO_POSITION,
  DEFAULT_LOGO_SCALE,
  DEFAULT_LOGO_MARGIN
} from '@renderer/components/brandKit'
import { DEFAULT_CAPTION_STYLE } from '@shared/caption-layout'

describe('brandCaptionOverride', () => {
  it('returns undefined for no brand / a brand that contributes nothing', () => {
    expect(brandCaptionOverride(null)).toBeUndefined()
    expect(brandCaptionOverride({ id: 'b', name: 'B' })).toBeUndefined()
  })

  it('maps brandColors[0]→highlight, [1]→fontColor, and fontFamily', () => {
    const o = brandCaptionOverride({
      id: 'b',
      name: 'B',
      fontFamily: 'Anton',
      brandColors: ['#FF6600', '#111111']
    })!
    expect(o.highlightColor).toBe('#FF6600')
    expect(o.fontColor).toBe('#111111')
    expect(o.fontFamily).toBe('Anton')
  })

  it('an explicit brand captionStyle wins over the derived colors', () => {
    const o = brandCaptionOverride({
      id: 'b',
      name: 'B',
      brandColors: ['#FF6600'],
      captionStyle: {
        ...DEFAULT_CAPTION_STYLE,
        highlightColor: '#00FF00',
        fontFamily: 'Bebas Neue'
      }
    })!
    expect(o.highlightColor).toBe('#00FF00')
    expect(o.fontFamily).toBe('Bebas Neue')
  })
})

describe('brandLogoParams', () => {
  it('returns {} when the brand has no logo', () => {
    expect(brandLogoParams(null)).toEqual({})
    expect(brandLogoParams({ id: 'b', name: 'B' })).toEqual({})
  })

  it('applies defaults when only a logoPath is set', () => {
    expect(brandLogoParams({ id: 'b', name: 'B', logoPath: '/x/logo.png' })).toEqual({
      logoPath: '/x/logo.png',
      logoPosition: DEFAULT_LOGO_POSITION,
      logoScale: DEFAULT_LOGO_SCALE,
      logoMargin: DEFAULT_LOGO_MARGIN
    })
  })

  it('honors explicit logo placement', () => {
    expect(
      brandLogoParams({
        id: 'b',
        name: 'B',
        logoPath: '/l.png',
        logoPosition: 'top-left',
        logoScale: 0.25,
        logoMargin: 20
      })
    ).toMatchObject({ logoPosition: 'top-left', logoScale: 0.25, logoMargin: 20 })
  })
})
