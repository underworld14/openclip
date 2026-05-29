/**
 * tests/unit/platform-presets.spec.ts — per-platform export presets (Part K, Step 4).
 */

import { describe, it, expect } from 'vitest'
import { PLATFORM_PRESETS, platformPreset } from '@renderer/components/platformPresets'
import { captionPresetStyle } from '@renderer/components/captionPresets'

describe('PLATFORM_PRESETS', () => {
  it('every preset has a valid aspect/quality + resolvable caption template', () => {
    for (const p of PLATFORM_PRESETS) {
      expect(['9:16', '1:1', '4:5', '16:9']).toContain(p.aspectRatio)
      expect(['720p', '1080p']).toContain(p.quality)
      if (p.captionTemplateId) expect(captionPresetStyle(p.captionTemplateId)).toBeTruthy()
    }
  })

  it('tiktok + shorts are vertical 1080p', () => {
    expect(platformPreset('tiktok')).toMatchObject({ aspectRatio: '9:16', quality: '1080p' })
    expect(platformPreset('shorts')).toMatchObject({ aspectRatio: '9:16', quality: '1080p' })
  })

  it('returns undefined for unknown/empty id', () => {
    expect(platformPreset('nope')).toBeUndefined()
    expect(platformPreset('')).toBeUndefined()
  })
})
