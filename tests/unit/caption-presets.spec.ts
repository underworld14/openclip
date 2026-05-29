/**
 * tests/unit/caption-presets.spec.ts — the caption style presets (Part I).
 * Each preset must be a schema-VALID `CaptionStyle`, every font family a preset
 * references must be bundled in `build/fonts/`, and the id lookup must behave.
 */

import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CaptionStyle } from '@shared/schema'
import { DEFAULT_CAPTION_STYLE } from '@shared/caption-layout'
import {
  CAPTION_PRESETS,
  PRESET_FONT_FAMILIES,
  captionPresetStyle,
  resolveEffectiveCaptionStyle
} from '@renderer/components/captionPresets'

/** libass family name → the file shipped in build/fonts (see SOURCES.md). */
const FAMILY_FILE: Record<string, string> = {
  'DejaVu Sans': 'DejaVuSans.ttf',
  Anton: 'Anton-Regular.ttf',
  'Archivo Black': 'ArchivoBlack-Regular.ttf',
  'Bebas Neue': 'BebasNeue-Regular.ttf',
  'Poppins ExtraBold': 'Poppins-ExtraBold.ttf'
}

const fontsDir = join(process.cwd(), 'build', 'fonts')

describe('CAPTION_PRESETS', () => {
  it('every preset has a unique id and a schema-valid CaptionStyle', () => {
    const ids = CAPTION_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length) // unique
    for (const p of CAPTION_PRESETS) {
      expect(() => CaptionStyle.parse(p.style)).not.toThrow()
      expect(p.name.length).toBeGreaterThan(0)
    }
  })

  it('includes the supoclip-style presets', () => {
    const ids = CAPTION_PRESETS.map((p) => p.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        'default',
        'hormozi',
        'mrbeast',
        'tiktok',
        'neon',
        'podcast',
        'minimal'
      ])
    )
  })

  it('every referenced font family is bundled in build/fonts/', () => {
    for (const family of PRESET_FONT_FAMILIES) {
      const file = FAMILY_FILE[family]
      expect(file, `no bundled font mapped for family "${family}"`).toBeTruthy()
      expect(existsSync(join(fontsDir, file)), `${file} missing from build/fonts`).toBe(true)
    }
  })
})

describe('captionPresetStyle', () => {
  it('returns undefined for empty/unknown ids and the style for a known id', () => {
    expect(captionPresetStyle('')).toBeUndefined()
    expect(captionPresetStyle(null)).toBeUndefined()
    expect(captionPresetStyle('nope')).toBeUndefined()
    expect(captionPresetStyle('hormozi')?.highlightColor).toBe('#00FF00')
  })
})

describe('Part K — keyword/per-word templates', () => {
  it('ships the new templates', () => {
    const ids = CAPTION_PRESETS.map((p) => p.id)
    expect(ids).toEqual(
      expect.arrayContaining(['beast-pop', 'hormozi-bold', 'tiktok-bounce', 'captionate'])
    )
  })

  it('the new templates use the Part-K fields (keyword/per-word) but NO auto-emoji', () => {
    for (const id of ['beast-pop', 'hormozi-bold', 'tiktok-bounce', 'captionate']) {
      const s = captionPresetStyle(id)!
      expect(s.keywordColor).toBeTruthy()
      // emoji-in-burn needs a bundled emoji font (follow-up) ⇒ presets keep it off.
      expect(s.autoEmoji ?? 'off').toBe('off')
    }
  })
})

describe('resolveEffectiveCaptionStyle', () => {
  it('returns the app default style for no template (byte-compat with passing none)', () => {
    expect(resolveEffectiveCaptionStyle('')).toEqual(DEFAULT_CAPTION_STYLE)
    expect(resolveEffectiveCaptionStyle(null)).toEqual(DEFAULT_CAPTION_STYLE)
  })

  it('returns the selected preset style', () => {
    expect(resolveEffectiveCaptionStyle('hormozi-bold').keywordColor).toBe('#00FF00')
  })

  it('applies autoEmoji + brand overrides (brand font/color win; preset keyword kept)', () => {
    const s = resolveEffectiveCaptionStyle('hormozi-bold', {
      autoEmoji: 'local',
      brand: { fontFamily: 'Bebas Neue', fontColor: '#FF0000', highlightColor: '#123456' }
    })
    expect(s.autoEmoji).toBe('local')
    expect(s.fontFamily).toBe('Bebas Neue')
    expect(s.fontColor).toBe('#FF0000')
    expect(s.highlightColor).toBe('#123456')
    expect(s.keywordColor).toBe('#00FF00') // preset emphasis preserved
  })
})
