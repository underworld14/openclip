/**
 * src/shared/reframe-plan.ts — PURE auto-reframe planning (Part J).
 *
 * Turns face-detection samples (+ optional 2-speaker motion) into a `ReframePlan`
 * that `ffmpeg-export.buildVf` renders as a `crop=…` node: a STATIC face-centered
 * crop, a time-varying PAN (`x='<expr(t)>'`), or a two-up SPLIT-screen. No
 * Electron/ffmpeg/onnx here — just geometry + smoothing math, so it is exhaustively
 * unit-testable. Constants adapted from supoclip's reframe heuristics.
 *
 * Coordinate convention: all face/region values are ABSOLUTE SOURCE pixels.
 * `crop` height is always the full source height (we only move horizontally for a
 * 9:16 column); `cropX` is the left edge of the crop window, clamped to
 * `[0, sourceW - cropW]`. Pan `xExpr` is an ffmpeg expression in source time `t`.
 *
 * NOTE (Phase 0): the TYPES + `buildReframePlan` signature are frozen here so the
 * detector, ffmpeg-export, and job params can all compile against them while the
 * full implementation (Track A) lands. The body below is a placeholder until then.
 */

import type { AspectRatio } from './schema'

/** One detected face in ABSOLUTE source pixels (top-left + size + score). */
export interface FaceBox {
  x: number
  y: number
  w: number
  h: number
  confidence: number
}

/** Faces detected in one sampled frame, at an ABSOLUTE source timestamp (ms). */
export interface SampleFrame {
  timeMs: number
  faces: FaceBox[]
}

/**
 * Per-side motion energy over time (2-speaker active-speaker detection). `times`
 * are ABSOLUTE source seconds; `left`/`right` are the per-ROI motion signals
 * (parallel arrays). Built from the ffmpeg `tblend+signalstats` motion pass.
 */
export interface MotionTimeline {
  times: number[]
  left: number[]
  right: number[]
}

/** A single crop window (ABSOLUTE source pixels) — used for split-screen tiles. */
export interface CropRegion {
  cropX: number
  cropY: number
  cropW: number
  cropH: number
}

/**
 * The reframe decision rendered by `buildVf`:
 *  - `static` — fixed face-centered column (`crop=cropW:cropH:x=cropX:y=0`).
 *  - `pan`    — time-varying column (`crop=cropW:cropH:x='<xExpr(t)>':y=0`).
 *  - `split`  — two stacked crops (left/right) → `vstack` (needs filter_complex).
 * `buildReframePlan` returns `null` to mean "no usable faces → center-crop".
 */
export type ReframePlan =
  | { mode: 'static'; cropW: number; cropH: number; cropX: number }
  | { mode: 'pan'; cropW: number; cropH: number; xExpr: string }
  | { mode: 'split'; regions: [CropRegion, CropRegion] }

/** What the user asked for (mirrors `JobParams['export'].reframe`). */
export type ReframeMode = 'off' | 'auto' | 'split'

export interface BuildReframePlanArgs {
  samples: SampleFrame[]
  /** Optional per-side motion (only needed for 2-speaker pan). */
  motion?: MotionTimeline | null
  source: { width: number; height: number }
  aspect: AspectRatio
  /** 'auto' → static/pan (1–2 speakers); 'split' → force 2-up split when 2 faces. */
  mode: Exclude<ReframeMode, 'off'>
}

/**
 * Build the reframe plan from detection samples. Returns `null` when there are no
 * usable faces (caller falls back to the static center-crop). Pure + deterministic.
 *
 * IMPLEMENTED IN TRACK A — this Phase-0 placeholder returns `null` (center-crop)
 * so dependents compile; the real geometry/smoothing lands with its spec.
 */
export function buildReframePlan(args: BuildReframePlanArgs): ReframePlan | null {
  void args // Phase-0 placeholder; Track A implements the geometry/smoothing.
  return null
}
