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
import { cropWidthFor, clamp, type CropRegion } from '@shared/reframe-plan'

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

/** Size + position (top-left, CSS px) to render a `<video>` element at. */
export interface CoverFitTransform {
  width: number
  height: number
  translateX: number
  translateY: number
}

/**
 * Cover-fit an arbitrary CROP REGION (absolute source px — a split-screen
 * tile's face-cluster box, which is sized off the FACES, not the tile's own
 * aspect ratio) into a `tile` of CSS px, and return the size+position to
 * render the WHOLE video element at so the region exactly (and only) fills
 * the tile — the live-preview equivalent of the export's split-screen
 * filtergraph (`crop=<region>,scale=…force_original_aspect_ratio=increase,
 * crop=<tile>`, `exportClipArgsSplit`), so the two can agree (EPIC-k83ghw /
 * BUG-t19z5j).
 *
 * Pixel-exact (not percentage-based): the region's aspect ratio is NOT
 * generally the tile's aspect ratio (see `clusterTileRegion`), so — unlike
 * the single center-crop, which only ever needs a horizontal offset — a
 * region can overflow the tile on EITHER axis and needs real cover-fit math,
 * which composes cleanly in absolute px but not in nested CSS percentages.
 */
export function coverFitTransform(
  source: { width: number; height: number },
  region: CropRegion,
  tile: { width: number; height: number }
): CoverFitTransform {
  if (!(region.cropW > 0) || !(region.cropH > 0) || !(tile.width > 0) || !(tile.height > 0)) {
    return { width: 0, height: 0, translateX: 0, translateY: 0 }
  }
  const scale = Math.max(tile.width / region.cropW, tile.height / region.cropH)
  const regionCenterX = region.cropX + region.cropW / 2
  const regionCenterY = region.cropY + region.cropH / 2
  return {
    width: source.width * scale,
    height: source.height * scale,
    // Places the REGION's center at the TILE's center; whichever axis the
    // scaled region overflows the tile on is symmetrically clipped by the
    // tile's own `overflow: hidden`, exactly like `force_original_aspect_
    // ratio=increase,crop=` does in the filtergraph.
    translateX: tile.width / 2 - regionCenterX * scale,
    translateY: tile.height / 2 - regionCenterY * scale
  }
}
