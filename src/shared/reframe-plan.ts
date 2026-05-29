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
 * `[0, sourceW - cropW]`. Pan `xExpr` is an ffmpeg expression in CLIP-RELATIVE
 * time (`t` 0-based from the clip start) — `planReframe` rebases the sample/motion
 * times by `-clipStart`, matching the `-ss`-rebased PTS ffmpeg feeds `crop`.
 *
 * ffmpeg-expression escaping: a `crop` node's `x='…'` value lives INSIDE the
 * filtergraph mini-language, where a bare `,` would split filter arguments. So the
 * commas WITHIN our `if(…)` / `min(…)` / `max(…)` calls are backslash-escaped
 * (`\,`) — the emitted `xExpr` is ready to drop straight into `x='<xExpr>'`.
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
  // `xExpr` is in CLIP-RELATIVE time (`t` 0-based from the clip start, matching the
  // `-ss`-rebased PTS ffmpeg feeds `crop` in BOTH the single-cut and the multi-range
  // jump-cut paths). `cropX` is the pan's representative "home" position (a valid
  // static crop) — metadata for a coarse preview/thumbnail.
  | { mode: 'pan'; cropW: number; cropH: number; xExpr: string; cropX: number }
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

// ============================================================================
// Tuning constants (adapted from supoclip's reframe heuristics)
// ============================================================================

/** Faces smaller than this (max of w/h, px) are detector noise → dropped. */
const MIN_FACE_DIM = 30
/** Face area must be ≥ this fraction of the frame to count (drops specks). */
const MIN_FACE_AREA_FRAC = 0.005
/** Face area above this fraction of the frame is a false/foreground blob. */
const MAX_FACE_AREA_FRAC = 0.3
/** σ multiplier for the center-x outlier gate (mean ± N·σ). */
const OUTLIER_SIGMA = 2
/** Two clusters must sit at least this fraction of frame width apart to split. */
const MIN_CLUSTER_GAP_FRAC = 0.15
/**
 * At least this fraction of (face-bearing) frames must show ≥2 faces at once for
 * a two-speaker split. A single moving face never co-occurs with itself, so this
 * guards against mistaking one panning speaker for two side-by-side speakers.
 */
const MIN_COOCCUR_FRAC = 0.2
/** Split tile sizing: width ≈ N·faceW, height ≈ N·faceH around the cluster. */
const SPLIT_TILE_W_MUL = 2.8
const SPLIT_TILE_H_MUL = 2.4
/** EMA smoothing factor for the single-speaker center path. */
const EMA_ALPHA = 0.2
/** Pan deadzone: a path swing ≤ this fraction of width stays a STATIC crop. */
const DEADZONE_FRAC = 0.015
/** Cap the linear-pan path to this many keyframes (downsampled by deadzone). */
const MAX_PAN_KEYFRAMES = 20
/** Moving-average window (samples) for the 2-speaker motion signals. */
const MOTION_SMOOTH_WIN = 15
/** Active side must beat the other by this ratio to claim a segment. */
const ACTIVE_MARGIN = 1.15
/** Active-speaker segments shorter than this (s) are merged into a neighbor. */
const MIN_SEGMENT_SEC = 1.0

// ============================================================================
// Small numeric helpers (pure)
// ============================================================================

/** Clamp `v` into `[lo, hi]`. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** Round to the nearest EVEN integer (ffmpeg/codec-friendly crop dimensions). */
export function roundEven(n: number): number {
  return Math.round(n / 2) * 2
}

/** Round to whole pixels (integer ffmpeg crop offsets). */
const ri = (n: number): number => Math.round(n)

/** Round a time to 3 decimals (ms-precision, clean ffmpeg expression literals). */
const r3 = (n: number): number => Math.round(n * 1000) / 1000

/** Arithmetic mean of a numeric list (0 for an empty list). */
function mean(xs: number[]): number {
  if (xs.length === 0) return 0
  let s = 0
  for (const x of xs) s += x
  return s / xs.length
}

/** Population standard deviation of a numeric list (0 for <2 entries). */
function stddev(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  let s = 0
  for (const x of xs) s += (x - m) * (x - m)
  return Math.sqrt(s / xs.length)
}

/** Median of a numeric list (0 for an empty list); does not mutate the input. */
function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** Center-x of a face in source px (`x + w/2`). */
function faceCenterX(f: FaceBox): number {
  return f.x + f.w / 2
}

// ============================================================================
// Crop geometry
// ============================================================================

/**
 * The crop window dimensions for `source` at the target `aspect`. We only move
 * horizontally (a 9:16 column the full source height), so `cropH = source.height`
 * and `cropX` is chosen later; `cropW` is the aspect-correct width rounded to an
 * EVEN integer and never wider than the source. For 9:16 the ratio is 9/16, etc.
 */
export function cropWidthFor(
  source: { width: number; height: number },
  aspect: AspectRatio
): { cropW: number; cropH: number } {
  const [arW, arH] = aspect.split(':').map(Number)
  const ideal = source.height * (arW / arH)
  // Both operands EVEN so the min stays even AND never exceeds the source width
  // (roundEven alone could round an odd source width UP past it). Floor to even.
  const evenWidth = source.width - (source.width % 2)
  const cropW = clamp(Math.min(roundEven(ideal), evenWidth), 2, source.width)
  return { cropW, cropH: source.height }
}

/** Clamp a crop's left edge into the legal `[0, sourceW - cropW]` range. */
function clampCropX(cropX: number, sourceW: number, cropW: number): number {
  return clamp(cropX, 0, sourceW - cropW)
}

// ============================================================================
// Sample filtering / outlier rejection
// ============================================================================

/**
 * Drop detector noise + outliers from `samples`:
 *  1. SIZE gate — reject faces with `max(w,h) < 30px`, or area `< 0.5%` / `> 30%`
 *     of the frame (specks and foreground blobs).
 *  2. σ gate — reject faces whose center-x falls outside `mean ± 2σ` across ALL
 *     surviving faces (a stray detection far from the speaker). If that would
 *     empty the set, keep the size-filtered faces instead (never over-prune).
 *
 * Returns NEW `SampleFrame`s (input untouched); frames left with no faces are
 * dropped entirely so downstream `mean`/timeline math sees only real detections.
 */
export function filterFaceOutliers(
  samples: SampleFrame[],
  source: { width: number; height: number }
): SampleFrame[] {
  const frameArea = source.width * source.height
  const minArea = frameArea * MIN_FACE_AREA_FRAC
  const maxArea = frameArea * MAX_FACE_AREA_FRAC

  // Pass 1 — size gate.
  const sized: SampleFrame[] = []
  for (const s of samples) {
    const faces = s.faces.filter((f) => {
      if (Math.max(f.w, f.h) < MIN_FACE_DIM) return false
      const area = f.w * f.h
      return area >= minArea && area <= maxArea
    })
    if (faces.length > 0) sized.push({ timeMs: s.timeMs, faces })
  }
  if (sized.length === 0) return []

  // Pass 2 — center-x σ gate across all surviving faces.
  const centers: number[] = []
  for (const s of sized) for (const f of s.faces) centers.push(faceCenterX(f))
  const m = mean(centers)
  const sd = stddev(centers)
  if (sd === 0) return sized // all aligned (or single face) → nothing to prune.

  const lo = m - OUTLIER_SIGMA * sd
  const hi = m + OUTLIER_SIGMA * sd
  const pruned: SampleFrame[] = []
  for (const s of sized) {
    const faces = s.faces.filter((f) => {
      const cx = faceCenterX(f)
      return cx >= lo && cx <= hi
    })
    if (faces.length > 0) pruned.push({ timeMs: s.timeMs, faces })
  }
  return pruned.length > 0 ? pruned : sized
}

/**
 * The area·confidence-weighted center-x of a frame's faces:
 * `Σ(cx·area·conf) / Σ(area·conf)`. Larger/more-confident faces dominate the
 * crop target. Falls back to the plain mean center if every weight is zero.
 */
export function weightedCenterX(faces: FaceBox[]): number {
  let num = 0
  let den = 0
  for (const f of faces) {
    const w = f.w * f.h * f.confidence
    num += faceCenterX(f) * w
    den += w
  }
  if (den > 0) return num / den
  // Degenerate (all weights 0) → plain mean of centers.
  return mean(faces.map(faceCenterX))
}

// ============================================================================
// Two-speaker clustering
// ============================================================================

/** A cluster of faces grouped to one side, with its summary geometry. */
interface FaceCluster {
  /** Median center-x of the cluster's faces (source px). */
  centerX: number
  /** Representative (median) face width / height for tile sizing. */
  faceW: number
  faceH: number
  /** Σ(area·conf) — the cluster's salience for dominance comparisons. */
  weight: number
  faces: FaceBox[]
}

/**
 * Group all faces into LEFT/RIGHT clusters by splitting at the global median
 * center-x. Returns `null` unless BOTH groups are non-empty AND their centers are
 * at least `15%` of frame width apart (otherwise it is really one speaker). Also
 * requires enough frames to show TWO faces at once (`MIN_COOCCUR_FRAC`) — a single
 * panning speaker never co-occurs with itself. The tuple is ordered `[left,right]`.
 */
export function clusterTwoFaceRegions(
  samples: SampleFrame[],
  source: { width: number; height: number }
): [FaceCluster, FaceCluster] | null {
  const all: FaceBox[] = []
  let cooccur = 0
  for (const s of samples) {
    for (const f of s.faces) all.push(f)
    if (s.faces.length >= 2) cooccur++
  }
  if (all.length < 2) return null
  // Require simultaneous two-face frames; otherwise this is one speaker moving.
  if (cooccur < Math.max(1, Math.ceil(samples.length * MIN_COOCCUR_FRAC))) return null

  const split = median(all.map(faceCenterX))
  const left = all.filter((f) => faceCenterX(f) < split)
  const right = all.filter((f) => faceCenterX(f) >= split)
  if (left.length === 0 || right.length === 0) return null

  const cl = makeCluster(left)
  const cr = makeCluster(right)
  if (Math.abs(cr.centerX - cl.centerX) < source.width * MIN_CLUSTER_GAP_FRAC) {
    return null
  }
  return cl.centerX <= cr.centerX ? [cl, cr] : [cr, cl]
}

/** Summarize a group of faces into a `FaceCluster`. */
function makeCluster(faces: FaceBox[]): FaceCluster {
  let weight = 0
  for (const f of faces) weight += f.w * f.h * f.confidence
  return {
    centerX: median(faces.map(faceCenterX)),
    faceW: median(faces.map((f) => f.w)),
    faceH: median(faces.map((f) => f.h)),
    weight,
    faces
  }
}

/**
 * The split-screen tile crop for one cluster: a `~2.8·faceW × 2.4·faceH` window
 * (clamped to the frame) centered on the cluster's median center. Integer px.
 */
export function clusterTileRegion(
  cluster: FaceCluster,
  source: { width: number; height: number }
): CropRegion {
  const cropW = clamp(ri(cluster.faceW * SPLIT_TILE_W_MUL), 2, source.width)
  const cropH = clamp(ri(cluster.faceH * SPLIT_TILE_H_MUL), 2, source.height)
  const cropX = ri(clampCropX(cluster.centerX - cropW / 2, source.width, cropW))
  // Tiles are face-height windows; center vertically on the cluster's faces.
  const cy = median(cluster.faces.map((f) => f.y + f.h / 2))
  const cropY = ri(clamp(cy - cropH / 2, 0, source.height - cropH))
  return { cropX, cropY, cropW, cropH }
}

// ============================================================================
// Active-speaker (2-speaker pan) timeline
// ============================================================================

/** A contiguous active-speaker segment: `[startSec, endSec)` on side L|R. */
interface ActiveSegment {
  start: number
  end: number
  side: 'L' | 'R'
}

/** Normalize a signal by its mean (mean → 1.0); a zero-mean signal stays as-is. */
function normalizeByMean(xs: number[]): number[] {
  const m = mean(xs)
  if (m === 0) return xs.slice()
  return xs.map((x) => x / m)
}

/** Centered moving average over `win` samples (edge-clamped window). */
function movingAverage(xs: number[], win: number): number[] {
  if (win <= 1 || xs.length === 0) return xs.slice()
  const half = Math.floor(win / 2)
  const out: number[] = []
  for (let i = 0; i < xs.length; i++) {
    const lo = Math.max(0, i - half)
    const hi = Math.min(xs.length - 1, i + half)
    let s = 0
    for (let j = lo; j <= hi; j++) s += xs[j]
    out.push(s / (hi - lo + 1))
  }
  return out
}

/**
 * Derive active-speaker segments from a `MotionTimeline`. Each side is normalized
 * by its own mean then `15`-sample moving-average smoothed; a side becomes active
 * for a time when it exceeds the other by `≥1.15×`. Equal/ambiguous frames inherit
 * the previous active side (default L). Adjacent same-side frames coalesce into
 * segments, then segments `< 1.0s` are merged into a neighbor. Returns `null` when
 * the timeline is too short/degenerate to drive a pan.
 */
export function buildActiveSpeakerSegments(motion: MotionTimeline): ActiveSegment[] | null {
  const n = Math.min(motion.times.length, motion.left.length, motion.right.length)
  if (n < 2) return null

  const times = motion.times.slice(0, n)
  const left = movingAverage(normalizeByMean(motion.left.slice(0, n)), MOTION_SMOOTH_WIN)
  const right = movingAverage(normalizeByMean(motion.right.slice(0, n)), MOTION_SMOOTH_WIN)

  // Per-sample active side (margin gate; ambiguous inherits previous).
  const sides: ('L' | 'R')[] = []
  let prev: 'L' | 'R' = 'L'
  for (let i = 0; i < n; i++) {
    let side = prev
    if (left[i] >= right[i] * ACTIVE_MARGIN) side = 'L'
    else if (right[i] >= left[i] * ACTIVE_MARGIN) side = 'R'
    sides.push(side)
    prev = side
  }

  // Coalesce runs into [start,end) segments (end = next sample's time; the last
  // segment runs to the final timestamp).
  let segs: ActiveSegment[] = []
  let segStart = times[0]
  let segSide = sides[0]
  for (let i = 1; i < n; i++) {
    if (sides[i] !== segSide) {
      segs.push({ start: r3(segStart), end: r3(times[i]), side: segSide })
      segStart = times[i]
      segSide = sides[i]
    }
  }
  segs.push({ start: r3(segStart), end: r3(times[n - 1]), side: segSide })

  segs = mergeShortSegments(segs)
  return segs.length > 0 ? segs : null
}

/**
 * Merge segments shorter than `1.0s` into a neighbor (folding into the longer
 * adjacent segment, then coalescing same-side neighbors). Iterates to a fixed
 * point so cascades collapse. A single surviving segment is returned as-is.
 */
function mergeShortSegments(input: ActiveSegment[]): ActiveSegment[] {
  let segs = input.map((s) => ({ ...s }))
  let changed = true
  while (changed && segs.length > 1) {
    changed = false
    for (let i = 0; i < segs.length; i++) {
      if (segs[i].end - segs[i].start >= MIN_SEGMENT_SEC) continue
      // Adopt the side of the longer neighbor, then re-coalesce.
      const prev = segs[i - 1]
      const next = segs[i + 1]
      if (prev && next) {
        segs[i].side = prev.end - prev.start >= next.end - next.start ? prev.side : next.side
      } else if (prev) {
        segs[i].side = prev.side
      } else if (next) {
        segs[i].side = next.side
      }
      segs = coalesce(segs)
      changed = true
      break
    }
  }
  return coalesce(segs)
}

/** Merge adjacent same-side segments into one span. */
function coalesce(segs: ActiveSegment[]): ActiveSegment[] {
  if (segs.length === 0) return segs
  const out: ActiveSegment[] = [{ ...segs[0] }]
  for (let i = 1; i < segs.length; i++) {
    const last = out[out.length - 1]
    if (segs[i].side === last.side) last.end = segs[i].end
    else out.push({ ...segs[i] })
  }
  return out
}

// ============================================================================
// ffmpeg expression builders
// ============================================================================

/**
 * Wrap an inner `x(t)` expression in a clamp to `[0, sourceW - cropW]`, with the
 * commas backslash-escaped for the filtergraph: `max(0\,min(<inner>\,<maxX>))`.
 */
export function clampExpr(inner: string, sourceW: number, cropW: number): string {
  const maxX = sourceW - cropW
  return 'max(0\\,min(' + inner + '\\,' + maxX + '))'
}

/**
 * Build a piecewise-LINEAR pan expression from `keyframes` (ascending `t`, integer
 * `x`). Each adjacent pair `(t0→t1)` lerps `x0→x1`; outside the range the nearest
 * endpoint holds. The whole thing is clamp-wrapped. Commas are `\,`-escaped.
 */
export function buildLinearPanExpr(
  keyframes: { t: number; x: number }[],
  sourceW: number,
  cropW: number
): string {
  if (keyframes.length === 1) {
    return clampExpr(String(keyframes[0].x), sourceW, cropW)
  }
  // Build from the LAST pair inward so each `if(between…)` nests its else-branch.
  let expr = String(keyframes[keyframes.length - 1].x) // hold past the last KF.
  for (let i = keyframes.length - 2; i >= 0; i--) {
    const t0 = keyframes[i].t
    const t1 = keyframes[i + 1].t
    const x0 = keyframes[i].x
    const x1 = keyframes[i + 1].x
    const span = t1 - t0 || 1
    // x0 + (x1-x0)*(t-t0)/(t1-t0), commas escaped for ffmpeg.
    const lerp = x0 + '+(' + (x1 - x0) + ')*(t-' + t0 + ')/(' + span + ')'
    expr = 'if(between(t\\,' + t0 + '\\,' + t1 + ')\\,' + lerp + '\\,' + expr + ')'
  }
  return clampExpr(expr, sourceW, cropW)
}

/**
 * Build a STEP pan expression from `steps` (ascending `end`, integer `x`). The
 * crop holds `x` until `t` reaches each `end`: `if(lt(t,end0),x0,if(lt(t,end1),…))`.
 * The final value holds past the last boundary. Clamp-wrapped; commas `\,`-escaped.
 */
export function buildStepPanExpr(
  steps: { end: number; x: number }[],
  sourceW: number,
  cropW: number
): string {
  if (steps.length === 1) return clampExpr(String(steps[0].x), sourceW, cropW)
  let expr = String(steps[steps.length - 1].x) // value past the last boundary.
  for (let i = steps.length - 2; i >= 0; i--) {
    expr = 'if(lt(t\\,' + steps[i].end + ')\\,' + steps[i].x + '\\,' + expr + ')'
  }
  return clampExpr(expr, sourceW, cropW)
}

// ============================================================================
// Smoothing / keyframe reduction (single-speaker pan path)
// ============================================================================

/** Exponential moving average over `xs` with factor `alpha` (seeded at xs[0]). */
export function emaSmooth(xs: number[], alpha: number): number[] {
  if (xs.length === 0) return []
  const out: number[] = [xs[0]]
  for (let i = 1; i < xs.length; i++) out.push(alpha * xs[i] + (1 - alpha) * out[i - 1])
  return out
}

/**
 * Downsample a smoothed `(t,x)` path to at most `MAX_PAN_KEYFRAMES` keyframes by
 * dropping points whose `x` moved less than `deadzonePx` since the last KEPT
 * keyframe. The first and last samples are always kept (anchors). If still over
 * the cap, uniformly subsample the interior toward the cap.
 */
export function reduceKeyframes(
  path: { t: number; x: number }[],
  deadzonePx: number
): { t: number; x: number }[] {
  if (path.length <= 2) return path.map((p) => ({ t: r3(p.t), x: ri(p.x) }))

  const kept: { t: number; x: number }[] = [path[0]]
  for (let i = 1; i < path.length - 1; i++) {
    if (Math.abs(path[i].x - kept[kept.length - 1].x) >= deadzonePx) kept.push(path[i])
  }
  kept.push(path[path.length - 1])

  let reduced = kept
  if (reduced.length > MAX_PAN_KEYFRAMES) {
    // Uniformly subsample the interior, always keeping the two anchors.
    const interior = reduced.slice(1, -1)
    const budget = MAX_PAN_KEYFRAMES - 2
    const step = interior.length / budget
    const picked: { t: number; x: number }[] = []
    for (let k = 0; k < budget; k++) picked.push(interior[Math.floor(k * step)])
    reduced = [reduced[0], ...picked, reduced[reduced.length - 1]]
  }
  // Round, then drop any keyframe whose rounded time collapses onto the previous
  // one (ms-rounding can coincide) so buildLinearPanExpr never sees a zero-width
  // `between(t,a,a)` segment.
  const rounded = reduced.map((p) => ({ t: r3(p.t), x: ri(p.x) }))
  const out: { t: number; x: number }[] = []
  for (const kf of rounded) {
    if (out.length > 0 && kf.t === out[out.length - 1].t) out[out.length - 1] = kf
    else out.push(kf)
  }
  return out
}

// ============================================================================
// buildReframePlan — the public entry point
// ============================================================================

/**
 * Build the reframe plan from detection samples. Returns `null` when there are no
 * usable faces (caller falls back to the static center-crop). Pure + deterministic.
 *
 * Decision tree:
 *  1. Filter samples; no faces ⇒ `null`.
 *  2. Two speakers? (`clusterTwoFaceRegions`)
 *     - `split` mode ⇒ `{mode:'split', regions:[Lregion, Rregion]}`.
 *     - `auto` mode + motion ⇒ active-speaker STEP pan between the two cluster
 *       crop-x's; no motion ⇒ fall back to single-speaker on the dominant cluster.
 *  3. Single speaker: per-sample weighted center-x → EMA → static (within deadzone)
 *     or piecewise-LINEAR pan.
 */
export function buildReframePlan(args: BuildReframePlanArgs): ReframePlan | null {
  const { source, aspect, mode } = args
  const samples = filterFaceOutliers(args.samples, source)
  if (samples.length === 0) return null

  const { cropW, cropH } = cropWidthFor(source, aspect)
  const deadzonePx = source.width * DEADZONE_FRAC
  const clusters = clusterTwoFaceRegions(samples, source)

  // --- (2) Two-speaker handling --------------------------------------------
  if (clusters) {
    const [left, right] = clusters
    if (mode === 'split') {
      return {
        mode: 'split',
        regions: [clusterTileRegion(left, source), clusterTileRegion(right, source)]
      }
    }
    // mode === 'auto': active-speaker pan if we have motion to drive it.
    if (args.motion) {
      const segs = buildActiveSpeakerSegments(args.motion)
      if (segs && segs.length > 1) {
        const xFor = (side: 'L' | 'R'): number => {
          const c = side === 'L' ? left : right
          return ri(clampCropX(c.centerX - cropW / 2, source.width, cropW))
        }
        const steps = segs.map((s) => ({ end: s.end, x: xFor(s.side) }))
        // Static fallback (jump-cut path): crop on the dominant cluster.
        const dom = left.weight >= right.weight ? left : right
        const fallbackX = ri(clampCropX(dom.centerX - cropW / 2, source.width, cropW))
        return {
          mode: 'pan',
          cropW,
          cropH,
          xExpr: buildStepPanExpr(steps, source.width, cropW),
          cropX: fallbackX
        }
      }
      // Single active side throughout → static on that cluster (fall through to
      // a static crop on the dominant cluster below).
    }
    // No motion (or a single segment) → static on the dominant cluster.
    const dominant = left.weight >= right.weight ? left : right
    const cropX = ri(clampCropX(dominant.centerX - cropW / 2, source.width, cropW))
    return { mode: 'static', cropW, cropH, cropX }
  }

  // --- (3) Single-speaker handling -----------------------------------------
  const path = samples.map((s) => ({ t: s.timeMs / 1000, x: weightedCenterX(s.faces) }))
  const smoothed = emaSmooth(
    path.map((p) => p.x),
    EMA_ALPHA
  )
  // Single-pass min/max (NOT Math.min(...spread): spreading a long sample array
  // overflows the call stack at ~200k elements — bound the path regardless of fps).
  let minC = smoothed[0]
  let maxC = smoothed[0]
  for (const c of smoothed) {
    if (c < minC) minC = c
    if (c > maxC) maxC = c
  }

  // Within the deadzone → a single STATIC crop centered on the mean center.
  if (maxC - minC <= deadzonePx) {
    const cropX = ri(clampCropX(mean(smoothed) - cropW / 2, source.width, cropW))
    return { mode: 'static', cropW, cropH, cropX }
  }

  // Otherwise PAN: smoothed center path → clamped crop-x keyframes → linear lerp.
  const cropXPath = path.map((p, i) => ({
    t: p.t,
    x: clampCropX(smoothed[i] - cropW / 2, source.width, cropW)
  }))
  const keyframes = reduceKeyframes(cropXPath, deadzonePx)
  // Static fallback (jump-cut path): center on the mean smoothed position.
  const fallbackX = ri(clampCropX(mean(smoothed) - cropW / 2, source.width, cropW))
  return {
    mode: 'pan',
    cropW,
    cropH,
    xExpr: buildLinearPanExpr(keyframes, source.width, cropW),
    cropX: fallbackX
  }
}
