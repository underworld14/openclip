/**
 * preview-crop.ts — PURE crop geometry for the WYSIWYG preview (Part K, Step 3).
 *
 * The center-crop COLUMN (source px) for a target aspect — the same column the
 * static export crop uses (`cropWidthFor`), so the preview frames exactly what a
 * center-crop export produces. The PreviewPlayer realizes this column visually
 * with CSS (`height:100%` + horizontal-center + `overflow:hidden`), which is a
 * center-crop for any source aspect; this module exposes the geometry for tests
 * + readouts. Pure (built on the shared `@shared/reframe-plan` math).
 */

import type { AspectRatio } from '@shared/schema'
import { cropWidthFor, clamp } from '@shared/reframe-plan'

export interface CenterCropRect {
  cropW: number
  cropH: number
  cropX: number
  cropY: number
}

/** The center-crop rectangle (absolute source px) for `source` at `aspect`. */
export function centerCropRect(
  source: { width: number; height: number },
  aspect: AspectRatio
): CenterCropRect {
  const { cropW, cropH } = cropWidthFor(source, aspect)
  const cropX = clamp(Math.round((source.width - cropW) / 2), 0, source.width - cropW)
  return { cropW, cropH, cropX, cropY: 0 }
}

/** CSS `aspect-ratio` value for a target AspectRatio (e.g. '9:16' → '9 / 16'). */
export function cssAspectRatio(aspect: AspectRatio): string {
  const [w, h] = aspect.split(':')
  return `${w} / ${h}`
}
