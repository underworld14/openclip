/**
 * captionPresets.ts — named caption style presets (Part I, adapted from
 * supoclip's caption_templates.py). PURE data + a lookup helper, so it is
 * unit-testable without a DOM and the component file stays a thin render.
 *
 * Each preset is a full `CaptionStyle` (the optional Part-I fields drive the
 * look): `highlightColor` is the karaoke current-word fill, `strokeColor`/
 * `strokeWidth` the outline, `shadow` the drop shadow, and a fully-TRANSPARENT
 * `backgroundColor` (`#…00`) makes ass-captions render outlined text with NO box
 * (BorderStyle 1); a semi/opaque background renders a box (BorderStyle 3).
 *
 * `fontFamily` is the libass FAMILY NAME (not a file name) — it must match a font
 * shipped in `build/fonts/` (see build/fonts/SOURCES.md). Sizes are in the
 * 1080×1920 export-canvas pixel space (ASS PlayResY = 1920).
 */

import type { CaptionStyle } from '@shared/schema'

export interface CaptionPreset {
  id: string
  name: string
  description: string
  style: CaptionStyle
}

/** Fully-transparent background ⇒ outlined text, no box (BorderStyle 1). */
const NO_BOX = '#00000000'

export const CAPTION_PRESETS: CaptionPreset[] = [
  {
    id: 'default',
    name: 'Default',
    description: 'Clean white caps with a gold highlight',
    style: {
      fontFamily: 'Bebas Neue',
      fontSize: 72,
      fontColor: '#FFFFFF',
      backgroundColor: NO_BOX,
      position: 'bottom',
      animation: 'none',
      highlightCurrentWord: true,
      emojiEnabled: false,
      highlightColor: '#FFD700',
      strokeColor: '#000000',
      strokeWidth: 3,
      shadow: false
    }
  },
  {
    id: 'hormozi',
    name: 'Hormozi',
    description: 'Bold condensed text with a bright green highlight',
    style: {
      fontFamily: 'Anton',
      fontSize: 76,
      fontColor: '#FFFFFF',
      backgroundColor: NO_BOX,
      position: 'bottom',
      animation: 'none',
      highlightCurrentWord: true,
      emojiEnabled: false,
      highlightColor: '#00FF00',
      strokeColor: '#000000',
      strokeWidth: 4,
      shadow: true
    }
  },
  {
    id: 'mrbeast',
    name: 'MrBeast',
    description: 'Big yellow text, red highlight, heavy outline',
    style: {
      fontFamily: 'Archivo Black',
      fontSize: 84,
      fontColor: '#FFFF00',
      backgroundColor: NO_BOX,
      position: 'bottom',
      animation: 'pop',
      highlightCurrentWord: true,
      emojiEnabled: false,
      highlightColor: '#FF0000',
      strokeColor: '#000000',
      strokeWidth: 5,
      shadow: true
    }
  },
  {
    id: 'tiktok',
    name: 'TikTok',
    description: 'Tall condensed caps with a pink highlight',
    style: {
      fontFamily: 'Bebas Neue',
      fontSize: 74,
      fontColor: '#FFFFFF',
      backgroundColor: NO_BOX,
      position: 'bottom',
      animation: 'none',
      highlightCurrentWord: true,
      emojiEnabled: false,
      highlightColor: '#FE2C55',
      strokeColor: '#000000',
      strokeWidth: 3,
      shadow: true
    }
  },
  {
    id: 'neon',
    name: 'Neon',
    description: 'Cyan text with a magenta glow-style highlight',
    style: {
      fontFamily: 'Anton',
      fontSize: 72,
      fontColor: '#00FFFF',
      backgroundColor: NO_BOX,
      position: 'bottom',
      animation: 'none',
      highlightCurrentWord: true,
      emojiEnabled: false,
      highlightColor: '#FF00FF',
      strokeColor: '#000066',
      strokeWidth: 3,
      shadow: true
    }
  },
  {
    id: 'podcast',
    name: 'Podcast',
    description: 'Rounded sans on a dark bar with a warm gold highlight',
    style: {
      fontFamily: 'Poppins ExtraBold',
      fontSize: 58,
      fontColor: '#FFFFFF',
      backgroundColor: '#1A1A1ACC',
      position: 'bottom',
      animation: 'fade',
      highlightCurrentWord: true,
      emojiEnabled: false,
      highlightColor: '#FFB800',
      strokeColor: '#333333',
      strokeWidth: 1,
      shadow: false
    }
  },
  {
    id: 'minimal',
    name: 'Minimal',
    description: 'Subtle captions on a faint translucent bar',
    style: {
      fontFamily: 'Poppins ExtraBold',
      fontSize: 56,
      fontColor: '#FFFFFF',
      backgroundColor: '#00000080',
      position: 'bottom',
      animation: 'fade',
      highlightCurrentWord: false,
      emojiEnabled: false,
      highlightColor: '#CCCCCC',
      strokeColor: '#000000',
      strokeWidth: 0,
      shadow: false
    }
  }
]

/** The libass family names every preset references (must exist in build/fonts/). */
export const PRESET_FONT_FAMILIES: string[] = Array.from(
  new Set(CAPTION_PRESETS.map((p) => p.style.fontFamily))
)

/** Look up a preset's style by id (undefined ⇒ no preset / app default). */
export function captionPresetStyle(id: string | null | undefined): CaptionStyle | undefined {
  if (!id) return undefined
  return CAPTION_PRESETS.find((p) => p.id === id)?.style
}
