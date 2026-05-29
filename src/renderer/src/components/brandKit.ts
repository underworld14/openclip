/**
 * brandKit.ts — PURE brand-kit mapping (Part K, Step 5). Turns a `BrandTemplate`
 * into (a) the caption-style override `resolveEffectiveCaptionStyle` consumes
 * (brand font/colors win over the selected preset) and (b) the export logo
 * params. No React / no store, so it is unit-testable.
 *
 * Brand colors → captions: `brandColors[0]` drives the karaoke HIGHLIGHT color and
 * `brandColors[1]` (if present) the base font color; an explicit `captionStyle`
 * on the brand overrides those. Logo defaults: bottom-right, 18% width, 48px
 * margin (1080-canvas px).
 */

import type { BrandTemplate } from '@shared/schema'
import type { CaptionStyleBrand } from './captionPresets'

/**
 * The caption-style overrides a brand contributes (font + colors), for
 * `resolveEffectiveCaptionStyle({ brand })`. Returns undefined when the brand
 * contributes nothing (so the selected preset is used unchanged).
 */
export function brandCaptionOverride(
  brand: BrandTemplate | null | undefined
): CaptionStyleBrand | undefined {
  if (!brand) return undefined
  const o: CaptionStyleBrand = {}
  if (brand.fontFamily) o.fontFamily = brand.fontFamily
  const colors = brand.brandColors ?? []
  if (colors[0]) o.highlightColor = colors[0] // primary brand color → karaoke highlight
  if (colors[1]) o.fontColor = colors[1]
  // An explicit brand caption style wins over the derived color mapping.
  if (brand.captionStyle?.fontFamily) o.fontFamily = brand.captionStyle.fontFamily
  if (brand.captionStyle?.fontColor) o.fontColor = brand.captionStyle.fontColor
  if (brand.captionStyle?.highlightColor) o.highlightColor = brand.captionStyle.highlightColor
  return Object.keys(o).length > 0 ? o : undefined
}

export interface BrandLogoParams {
  logoPath?: string
  logoPosition?: NonNullable<BrandTemplate['logoPosition']>
  logoScale?: number
  logoMargin?: number
}

export const DEFAULT_LOGO_POSITION = 'bottom-right' as const
export const DEFAULT_LOGO_SCALE = 0.18
export const DEFAULT_LOGO_MARGIN = 48

/**
 * The export logo params from a brand (defaults applied). Returns `{}` when the
 * brand has no logo (⇒ no overlay; export unchanged).
 */
export function brandLogoParams(brand: BrandTemplate | null | undefined): BrandLogoParams {
  if (!brand?.logoPath) return {}
  return {
    logoPath: brand.logoPath,
    logoPosition: brand.logoPosition ?? DEFAULT_LOGO_POSITION,
    logoScale: brand.logoScale ?? DEFAULT_LOGO_SCALE,
    logoMargin: brand.logoMargin ?? DEFAULT_LOGO_MARGIN
  }
}
