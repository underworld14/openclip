/**
 * caption-css.ts — PURE CaptionStyle → React CSSProperties for the WYSIWYG
 * preview's DOM caption overlay (Part K, Step 3). Mirrors `buildStyleLine`
 * semantics (highlight color, outline, box, position, keyword emphasis) so the
 * preview READS like the libass burn. NOTE: the burn is pixel-exact (libass);
 * the DOM overlay is a faithful APPROXIMATION (CSS text-shadow ≈ ASS outline).
 */

import type { CSSProperties } from 'react'
import type { AspectRatio, CaptionStyle } from '@shared/schema'

/** A fully-transparent (ASS alpha 00) background hex ⇒ outlined text, no box. */
export function isTransparentBg(hex: string): boolean {
  return /^#?[0-9a-f]{6}00$/i.test(hex.trim())
}

/** Approximate the libass outline as a layered text-shadow. */
function outlineShadow(color: string, width: number): string {
  if (width <= 0) return 'none'
  const w = Math.max(1, Math.round(width / 2)) // ASS width is 1080-canvas px; soften for preview
  const parts: string[] = []
  for (const dx of [-w, 0, w]) {
    for (const dy of [-w, 0, w]) {
      if (dx || dy) parts.push(`${dx}px ${dy}px 0 ${color}`)
    }
  }
  return parts.join(', ')
}

/** ASS PlayResX (the 1080-wide export canvas the fontSize is authored against). */
const ASS_CANVAS_WIDTH = 1080

/**
 * The ASS `MarginV` the burn's Style line hardcodes (`ass-captions.ts`
 * `buildStyleLine`'s `'80', // MarginV`) — kept in sync manually, the same way
 * `ASS_CANVAS_WIDTH` above already duplicates `ass-captions.ts`'s constant
 * rather than importing a main-process-only module into the renderer.
 */
const ASS_MARGIN_V = 80

/**
 * PlayResY for a target aspect — mirrors `ass-captions.ts`'s `playResFor`
 * exactly (PlayResX pinned to the design width, PlayResY scaled to preserve
 * the canvas's aspect ratio), but from the aspect RATIO string alone: the
 * formula only ever depends on height/width, never the actual output
 * resolution, so no real pixel dimensions are needed here.
 */
function playResYFor(aspect: AspectRatio): number {
  const [w, h] = aspect.split(':').map(Number)
  return Math.round((ASS_CANVAS_WIDTH * h) / w)
}

/**
 * The caption LINE container style (position within the frame + font + outline).
 * fontSize uses container-query width units (`cqw`) so it scales with the preview
 * frame automatically — the frame must set `container-type: inline-size`. A
 * fontSize of N (in 1080-canvas px) renders at `N/1080 * frameWidth`.
 *
 * `aspect` determines the vertical offset (EPIC-k83ghw / BUG-t19z5j): the burn's
 * MarginV is a FIXED pixel value in a PlayResY that itself scales with the
 * output aspect ratio, so the same MarginV is a different PERCENTAGE of frame
 * height on a 9:16 export (~4%) than on a 1:1 or 16:9 one — the preview
 * hardcoded a single 8% for every aspect, which matched none of them exactly.
 * Defaults to '9:16' (the app's primary target) for callers with no live
 * project aspect, e.g. the caption-template comparison gallery.
 */
export function captionContainerStyle(
  style: CaptionStyle,
  aspect: AspectRatio = '9:16'
): CSSProperties {
  const cqw = ((style.fontSize / ASS_CANVAS_WIDTH) * 100).toFixed(3)
  const css: CSSProperties = {
    position: 'absolute',
    left: 0,
    right: 0,
    textAlign: 'center',
    padding: '0 6%',
    fontFamily: `'${style.fontFamily}', system-ui, sans-serif`,
    fontWeight: 800,
    fontSize: `${cqw}cqw`,
    lineHeight: 1.15,
    textShadow: outlineShadow(style.strokeColor ?? '#000000', style.strokeWidth ?? 3),
    pointerEvents: 'none',
    whiteSpace: 'pre-wrap'
  }
  const marginPct = `${((ASS_MARGIN_V / playResYFor(aspect)) * 100).toFixed(3)}%`
  if (style.position === 'top') css.top = marginPct
  else if (style.position === 'middle') {
    css.top = '50%'
    css.transform = 'translateY(-50%)'
  } else css.bottom = marginPct
  return css
}

/**
 * Per-word style: the active (spoken) word turns the highlight color; a keyword
 * uses the keyword color/scale/bold; others use the base font color. A non-
 * transparent backgroundColor draws a per-word box (Hormozi-style).
 */
export function captionWordStyle(
  style: CaptionStyle,
  opts: { active: boolean; keyword?: boolean }
): CSSProperties {
  const css: CSSProperties = { color: style.fontColor }
  if (opts.active) css.color = style.highlightColor ?? '#FFD700'
  if (opts.keyword) {
    if (style.keywordColor) css.color = style.keywordColor
    if (style.keywordBold) css.fontWeight = 900
    // Skip the static keyword scale when a per-word animation is active (audit fix
    // openclip-yuk): the burn does the same (ass-captions) because both drive the font
    // scale, and a constant keywordScale would fight the animation's target. Keeps the
    // preview consistent with what gets burned.
    const perWordActive = !!style.perWordAnimation && style.perWordAnimation !== 'none'
    if (typeof style.keywordScale === 'number' && style.keywordScale !== 100 && !perWordActive) {
      css.display = 'inline-block'
      css.transform = `scale(${style.keywordScale / 100})`
    }
  }
  if (style.backgroundColor && !isTransparentBg(style.backgroundColor)) {
    css.backgroundColor = style.backgroundColor
    css.padding = '0 0.15em'
    css.borderRadius = '0.1em'
  }
  return css
}

/**
 * The CSS class for the per-word reveal animation (openclip-4v1), applied to the
 * CURRENT word only (the one the playhead just reached) so the preview shows the
 * same bounce/pop the libass burn applies via `\t`. The keyframes live in
 * `assets/index.css` (`.oc-cap-bounce` grows 100%→115%, `.oc-cap-pop` 70%→100%,
 * mirroring ass-captions). Returns undefined when no animation applies — the
 * caller re-keys the word so React replays the animation as each word becomes
 * current.
 */
export function captionWordAnimationClass(
  style: CaptionStyle,
  current: boolean
): string | undefined {
  if (!current) return undefined
  if (style.perWordAnimation === 'bounce') return 'oc-cap-bounce'
  if (style.perWordAnimation === 'pop') return 'oc-cap-pop'
  return undefined
}
