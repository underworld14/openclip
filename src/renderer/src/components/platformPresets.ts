/**
 * platformPresets.ts — one-click per-platform export presets (Part K, Step 4).
 * PURE data (mirrors captionPresets): each preset composes the EXISTING export
 * inputs (aspectRatio + quality + a caption template id) — NO contract change.
 */

import type { AspectRatio } from '@shared/schema'

export interface PlatformPreset {
  id: string
  name: string
  aspectRatio: AspectRatio
  quality: '720p' | '1080p'
  /** Default caption template for this platform (captionPresets id; '' = app default). */
  captionTemplateId: string
}

export const PLATFORM_PRESETS: PlatformPreset[] = [
  {
    id: 'tiktok',
    name: 'TikTok',
    aspectRatio: '9:16',
    quality: '1080p',
    captionTemplateId: 'tiktok-bounce'
  },
  {
    id: 'shorts',
    name: 'YouTube Shorts',
    aspectRatio: '9:16',
    quality: '1080p',
    captionTemplateId: 'default'
  },
  {
    id: 'reels',
    name: 'Instagram Reels',
    aspectRatio: '9:16',
    quality: '1080p',
    captionTemplateId: 'default'
  },
  {
    id: 'reels-4x5',
    name: 'Reels (4:5)',
    aspectRatio: '4:5',
    quality: '1080p',
    captionTemplateId: 'default'
  }
]

/** Look up a platform preset by id (undefined ⇒ unknown). */
export function platformPreset(id: string | null | undefined): PlatformPreset | undefined {
  if (!id) return undefined
  return PLATFORM_PRESETS.find((p) => p.id === id)
}
