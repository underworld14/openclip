/**
 * tests/unit/reframe-plan.spec.ts — the PURE auto-reframe planning math (Part J,
 * Track A). Tested WITHOUT ffmpeg/onnx/Electron (mirrors keep-ranges / timeline-
 * math pure tests): canned `SampleFrame[]` + `MotionTimeline` → `ReframePlan`.
 *
 * Load-bearing assertions:
 *  - cropWidthFor: aspect-correct width, EVEN-rounded, clamped to source width.
 *  - filterFaceOutliers: size gate (min dim / area band) + center-x σ gate, and
 *    the never-over-prune fallbacks.
 *  - weightedCenterX: area·confidence weighting.
 *  - buildReframePlan: null on no faces; STATIC vs PAN deadzone decision; pan
 *    xExpr carries the lerp + clamp structure and tracks the moving face; 2-speaker
 *    SPLIT region geometry; active-speaker STEP timeline (normalize/smooth/margin/
 *    merge) → step xExpr alternating between the two cluster crop-x's.
 */

import { describe, expect, it } from 'vitest'
import {
  buildReframePlan,
  cropWidthFor,
  filterFaceOutliers,
  weightedCenterX,
  clusterTwoFaceRegions,
  clusterTileRegion,
  buildActiveSpeakerSegments,
  buildLinearPanExpr,
  buildStepPanExpr,
  clampExpr,
  emaSmooth,
  reduceKeyframes,
  roundEven,
  clamp,
  type FaceBox,
  type SampleFrame,
  type MotionTimeline
} from '@shared/reframe-plan'
import type { AspectRatio } from '@shared/schema'

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

const SRC = { width: 1920, height: 1080 }
const NINE_SIXTEEN: AspectRatio = '9:16'

/** A face centered at `cx` (full size square `d`, confidence `conf`). */
function faceAt(cx: number, d = 200, conf = 0.95): FaceBox {
  return { x: cx - d / 2, y: 440, w: d, h: d, confidence: conf }
}

/** One sample at `timeMs` with faces centered at the given `cxs`. */
function sampleAt(timeMs: number, cxs: number[], d = 200, conf = 0.95): SampleFrame {
  return { timeMs, faces: cxs.map((cx) => faceAt(cx, d, conf)) }
}

// ===========================================================================
// cropWidthFor
// ===========================================================================

describe('cropWidthFor', () => {
  it('computes the 9:16 column width as height*9/16, EVEN-rounded', () => {
    // 1080 * 9/16 = 607.5 → even-round → 608, full source height.
    const { cropW, cropH } = cropWidthFor(SRC, NINE_SIXTEEN)
    expect(cropW).toBe(608)
    expect(cropW % 2).toBe(0)
    expect(cropH).toBe(1080)
  })

  it('clamps cropW to the source width when the ideal column is wider', () => {
    // A square-ish source: 9:16 ideal = 1000*9/16 = 562.5 → 562 < 800, fine.
    // A TALL source where the ideal exceeds width gets clamped to width.
    const tall = { width: 400, height: 1080 } // ideal 607.5 > 400 → clamp 400.
    const { cropW, cropH } = cropWidthFor(tall, NINE_SIXTEEN)
    expect(cropW).toBe(400)
    expect(cropH).toBe(1080)
  })

  it('handles 1:1 / 4:5 / 16:9 ratios', () => {
    expect(cropWidthFor(SRC, '1:1').cropW).toBe(1080) // height*1
    // 1080*4/5 = 864 (even).
    expect(cropWidthFor(SRC, '4:5').cropW).toBe(864)
    // 1080*16/9 = 1920 → clamped to width 1920.
    expect(cropWidthFor(SRC, '16:9').cropW).toBe(1920)
  })
})

describe('roundEven / clamp', () => {
  it('rounds to the nearest even integer', () => {
    expect(roundEven(607.5)).toBe(608)
    expect(roundEven(605)).toBe(606)
    expect(roundEven(603)).toBe(604)
    expect(roundEven(602.4)).toBe(602)
  })
  it('clamps into range', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-3, 0, 10)).toBe(0)
    expect(clamp(99, 0, 10)).toBe(10)
  })
})

// ===========================================================================
// filterFaceOutliers
// ===========================================================================

describe('filterFaceOutliers', () => {
  it('drops faces smaller than the min dimension (30px)', () => {
    const samples = [sampleAt(0, [960], 20)] // 20px < 30 → dropped.
    expect(filterFaceOutliers(samples, SRC)).toEqual([])
  })

  it('drops faces below the min area fraction (0.5% of frame)', () => {
    // frame area = 1920*1080 = 2,073,600 ; 0.5% = 10,368 px². A 32x32 face = 1024
    // px² passes the 30px dim gate? max(32,32)=32 ≥ 30, but area 1024 < 10368.
    const tiny: FaceBox = { x: 944, y: 520, w: 32, h: 32, confidence: 0.9 }
    expect(filterFaceOutliers([{ timeMs: 0, faces: [tiny] }], SRC)).toEqual([])
  })

  it('drops faces above the max area fraction (30% of frame)', () => {
    // 30% area = 622,080 px². An 800x800 face = 640,000 px² > cap → dropped.
    const huge: FaceBox = { x: 560, y: 140, w: 800, h: 800, confidence: 0.9 }
    expect(filterFaceOutliers([{ timeMs: 0, faces: [huge] }], SRC)).toEqual([])
  })

  it('keeps a small-but-real face on a low-res source (dim floor is resolution-scaled, openclip-mnw)', () => {
    // On a 320x180 source the old fixed 30px floor rejected a 28px face that is ~16%
    // of width — a real, prominent subject. Normalized to source height the floor is
    // tiny here, so the area band (0.5%–30%) does the real work and the face survives.
    const small = { width: 320, height: 180 }
    // 28x28 = 784 px² ; minArea = 320*180*0.005 = 288 → passes the area gate.
    const face: FaceBox = { x: 146, y: 60, w: 28, h: 28, confidence: 0.9 }
    expect(filterFaceOutliers([{ timeMs: 0, faces: [face] }], small)).toHaveLength(1)
  })

  it('keeps a normal face and preserves timestamps', () => {
    const samples = [sampleAt(100, [960])]
    const out = filterFaceOutliers(samples, SRC)
    expect(out).toHaveLength(1)
    expect(out[0].timeMs).toBe(100)
    expect(out[0].faces).toHaveLength(1)
  })

  it('rejects a center-x outlier beyond mean ± 2σ', () => {
    // Cluster of faces near x=960 plus one stray far at x=1900. The stray pulls
    // mean/σ but should fall outside mean+2σ and be pruned.
    const samples = [
      sampleAt(0, [950]),
      sampleAt(40, [960]),
      sampleAt(80, [955]),
      sampleAt(120, [965]),
      sampleAt(160, [958]),
      sampleAt(200, [1900]) // outlier.
    ]
    const out = filterFaceOutliers(samples, SRC)
    const centers = out.flatMap((s) => s.faces.map((f) => f.x + f.w / 2))
    expect(centers).not.toContain(1900)
    expect(centers.length).toBe(5)
  })

  it('never empties the set: keeps size-filtered faces if the σ gate would', () => {
    // Two faces equally far from the mean → both could be "outliers"; we keep them.
    const samples = [sampleAt(0, [200]), sampleAt(40, [1720])]
    const out = filterFaceOutliers(samples, SRC)
    expect(out.length).toBeGreaterThan(0)
  })
})

// ===========================================================================
// weightedCenterX
// ===========================================================================

describe('weightedCenterX', () => {
  it('returns the single face center', () => {
    expect(weightedCenterX([faceAt(960)])).toBeCloseTo(960, 5)
  })

  it('weights by area·confidence (the bigger/surer face dominates)', () => {
    const small = faceAt(400, 100, 0.9) // area 10,000
    const big = faceAt(1200, 300, 0.9) // area 90,000 → ~9x weight
    const c = weightedCenterX([small, big])
    // Plain mean would be 800; weighted should sit much closer to the big face.
    expect(c).toBeGreaterThan(1000)
  })

  it('falls back to the plain mean when all weights are zero (conf=0)', () => {
    const a = faceAt(400, 100, 0)
    const b = faceAt(1200, 100, 0)
    expect(weightedCenterX([a, b])).toBeCloseTo(800, 5)
  })
})

// ===========================================================================
// emaSmooth / reduceKeyframes
// ===========================================================================

describe('emaSmooth', () => {
  it('seeds at the first value and trails toward later values', () => {
    const out = emaSmooth([0, 100, 100, 100], 0.2)
    expect(out[0]).toBe(0)
    expect(out[1]).toBeCloseTo(20, 5)
    expect(out[3]).toBeGreaterThan(out[1])
    expect(out[3]).toBeLessThan(100)
  })
})

describe('reduceKeyframes', () => {
  it('keeps both anchors and drops sub-deadzone interior moves', () => {
    const path = [
      { t: 0, x: 100 },
      { t: 1, x: 101 }, // +1 < deadzone(30) → dropped
      { t: 2, x: 102 }, // still within deadzone of kept anchor → dropped
      { t: 3, x: 300 } // big move → anchor (last) kept
    ]
    const kf = reduceKeyframes(path, 30)
    expect(kf[0]).toEqual({ t: 0, x: 100 })
    expect(kf[kf.length - 1]).toEqual({ t: 3, x: 300 })
    expect(kf.length).toBeLessThan(path.length)
  })

  it('caps at 20 keyframes for a long varied path', () => {
    const path = Array.from({ length: 200 }, (_, i) => ({ t: i, x: i * 5 }))
    const kf = reduceKeyframes(path, 1)
    expect(kf.length).toBeLessThanOrEqual(20)
  })

  it('rounds times to 3 decimals and x to ints', () => {
    const kf = reduceKeyframes(
      [
        { t: 0.123456, x: 100.6 },
        { t: 1.987654, x: 300.4 }
      ],
      1
    )
    expect(kf[0]).toEqual({ t: 0.123, x: 101 })
    expect(kf[1]).toEqual({ t: 1.988, x: 300 })
  })
})

// ===========================================================================
// ffmpeg expression builders
// ===========================================================================

describe('clampExpr', () => {
  it('wraps an inner expr in an escaped max(0,min(.,maxX))', () => {
    const e = clampExpr('123', 1920, 608)
    expect(e).toBe('max(0\\,min(123\\,1312))') // maxX = 1920-608 = 1312
  })
})

describe('buildLinearPanExpr', () => {
  it('builds a piecewise lerp wrapped in a clamp, with escaped commas', () => {
    const e = buildLinearPanExpr(
      [
        { t: 0, x: 100 },
        { t: 2, x: 500 }
      ],
      1920,
      608
    )
    expect(e).toContain('between(t\\,0\\,2')
    expect(e).toContain('100+(400)*(t-0)/(2)')
    expect(e.startsWith('max(0\\,min(')).toBe(true)
    expect(e.endsWith('\\,1312))')).toBe(true)
    // No BARE (unescaped) commas may appear (would split the ffmpeg filter args).
    expect(e.replace(/\\,/g, '')).not.toContain(',')
  })

  it('nests multiple segments (3 keyframes → two between() branches)', () => {
    const e = buildLinearPanExpr(
      [
        { t: 0, x: 100 },
        { t: 1, x: 200 },
        { t: 2, x: 50 }
      ],
      1920,
      608
    )
    expect((e.match(/between\(t/g) || []).length).toBe(2)
  })

  it('a single keyframe collapses to a clamped constant', () => {
    expect(buildLinearPanExpr([{ t: 0, x: 333 }], 1920, 608)).toBe('max(0\\,min(333\\,1312))')
  })
})

describe('buildStepPanExpr', () => {
  it('builds nested lt(t,end) steps, escaped + clamped', () => {
    const e = buildStepPanExpr(
      [
        { end: 1.5, x: 100 },
        { end: 3.0, x: 800 },
        { end: 9.9, x: 100 }
      ],
      1920,
      608
    )
    expect(e).toContain('lt(t\\,1.5)')
    expect(e).toContain('lt(t\\,3)')
    expect((e.match(/lt\(t/g) || []).length).toBe(2) // N steps → N-1 lt() guards
    expect(e.startsWith('max(0\\,min(')).toBe(true)
    expect(e.replace(/\\,/g, '')).not.toContain(',')
  })
})

// ===========================================================================
// clusterTwoFaceRegions / clusterTileRegion
// ===========================================================================

describe('clusterTwoFaceRegions', () => {
  it('returns null for a single speaker', () => {
    const samples = filterFaceOutliers([sampleAt(0, [960]), sampleAt(40, [965])], SRC)
    expect(clusterTwoFaceRegions(samples, SRC)).toBeNull()
  })

  it('returns null when two faces are closer than 15% of width apart', () => {
    // 15% of 1920 = 288px. Centers 900 & 1100 are only 200px apart → one speaker.
    const samples = filterFaceOutliers([sampleAt(0, [900, 1100])], SRC)
    expect(clusterTwoFaceRegions(samples, SRC)).toBeNull()
  })

  it('splits two well-separated speakers into [left,right] by centerX', () => {
    const samples = filterFaceOutliers([sampleAt(0, [500, 1500]), sampleAt(40, [510, 1490])], SRC)
    const clusters = clusterTwoFaceRegions(samples, SRC)
    expect(clusters).not.toBeNull()
    const [l, r] = clusters!
    expect(l.centerX).toBeLessThan(r.centerX)
    expect(l.centerX).toBeCloseTo(505, 0)
    expect(r.centerX).toBeCloseTo(1495, 0)
  })
})

describe('clusterTileRegion', () => {
  it('sizes a ~2.8w x 2.4h tile centered on the cluster, clamped to frame', () => {
    const samples = filterFaceOutliers([sampleAt(0, [500, 1500])], SRC)
    const [left] = clusterTwoFaceRegions(samples, SRC)!
    const region = clusterTileRegion(left, SRC)
    expect(region.cropW).toBe(Math.round(200 * 2.8)) // 560
    expect(region.cropH).toBe(Math.round(200 * 2.4)) // 480
    // Centered on cx=500 → cropX ≈ 500 - 560/2 = 220.
    expect(region.cropX).toBeCloseTo(220, 0)
    expect(region.cropX).toBeGreaterThanOrEqual(0)
    expect(region.cropX + region.cropW).toBeLessThanOrEqual(SRC.width)
  })
})

// ===========================================================================
// buildActiveSpeakerSegments
// ===========================================================================

describe('buildActiveSpeakerSegments', () => {
  it('returns null for a too-short timeline', () => {
    expect(buildActiveSpeakerSegments({ times: [0], left: [1], right: [1] })).toBeNull()
  })

  it('detects a left-then-right hand-off and merges away sub-1s flickers', () => {
    // 0..5s left loud, 5..10s right loud, with a single-sample right blip early.
    const n = 51
    const times = Array.from({ length: n }, (_, i) => i * 0.2) // 0..10s @ 5fps
    const left: number[] = []
    const right: number[] = []
    for (let i = 0; i < n; i++) {
      const t = times[i]
      if (t < 5) {
        left.push(10)
        right.push(1)
      } else {
        left.push(1)
        right.push(10)
      }
    }
    // Inject a tiny <1s right blip during the left half (should be merged out).
    left[3] = 1
    right[3] = 10
    const segs = buildActiveSpeakerSegments({ times, left, right })
    expect(segs).not.toBeNull()
    expect(segs!.length).toBe(2)
    expect(segs![0].side).toBe('L')
    expect(segs![1].side).toBe('R')
    // The hand-off lands near 5s (smoothing shifts it slightly).
    expect(segs![0].end).toBeGreaterThan(4)
    expect(segs![0].end).toBeLessThan(6)
  })
})

// ===========================================================================
// buildReframePlan — integration
// ===========================================================================

describe('buildReframePlan: degenerate', () => {
  it('returns null when there are no usable faces', () => {
    expect(
      buildReframePlan({ samples: [], source: SRC, aspect: NINE_SIXTEEN, mode: 'auto' })
    ).toBeNull()
    // All faces too small → filtered to empty → null.
    const tiny = [sampleAt(0, [960], 10)]
    expect(
      buildReframePlan({ samples: tiny, source: SRC, aspect: NINE_SIXTEEN, mode: 'auto' })
    ).toBeNull()
  })
})

describe('buildReframePlan: single-speaker STATIC vs PAN (deadzone)', () => {
  it('STATIC when the face barely moves (within ~1.5% deadzone)', () => {
    // deadzone = 1.5% of 1920 = 28.8px. Center wiggles ±10px → static.
    const samples = [
      sampleAt(0, [960]),
      sampleAt(200, [965]),
      sampleAt(400, [958]),
      sampleAt(600, [962])
    ]
    const plan = buildReframePlan({ samples, source: SRC, aspect: NINE_SIXTEEN, mode: 'auto' })
    expect(plan?.mode).toBe('static')
    if (plan?.mode === 'static') {
      expect(plan.cropW).toBe(608)
      expect(plan.cropH).toBe(1080)
      // Centered on ~960 → cropX ≈ 960 - 304 = 656.
      expect(plan.cropX).toBeCloseTo(656, -1)
      expect(plan.cropX).toBeGreaterThanOrEqual(0)
      expect(plan.cropX + plan.cropW).toBeLessThanOrEqual(SRC.width)
    }
  })

  it('PAN when a real sweep exceeds the deadzone even though EMA-smoothing would hide it (openclip-eli)', () => {
    // Raw centers sweep 900→950 = 50px, well above the 28.8px deadzone — a genuine pan.
    // The old code decided from the EMA-smoothed path (alpha 0.2, seeded at the first
    // sample), which lags so heavily the smoothed range (~17px) fell UNDER the deadzone
    // and wrongly rendered it static. The static/pan decision must come from raw travel.
    const samples = [
      sampleAt(0, [900]),
      sampleAt(200, [916]),
      sampleAt(400, [933]),
      sampleAt(600, [950])
    ]
    const plan = buildReframePlan({ samples, source: SRC, aspect: NINE_SIXTEEN, mode: 'auto' })
    expect(plan?.mode).toBe('pan')
  })

  it('STATIC despite one outlier frame the σ-gate let through (eli review follow-up)', () => {
    // 4 frames dead-center at 960 + 1 spike at 1010. The σ-gate band is inflated by the
    // spike itself (mean 970, 2σ ≈ ±40 → [930,1010]) so 1010 survives, and raw min/max
    // would read travel = 50px > 28.8 deadzone → a false pan. A robust range (drop the
    // single most-extreme sample) collapses the lone spike → correctly static.
    const samples = [
      sampleAt(0, [960]),
      sampleAt(200, [960]),
      sampleAt(400, [960]),
      sampleAt(600, [960]),
      sampleAt(800, [1010])
    ]
    const plan = buildReframePlan({ samples, source: SRC, aspect: NINE_SIXTEEN, mode: 'auto' })
    expect(plan?.mode).toBe('static')
  })

  it('PAN when the face sweeps across the frame; xExpr lerps + clamps', () => {
    const samples = [
      sampleAt(0, [300]),
      sampleAt(500, [600]),
      sampleAt(1000, [900]),
      sampleAt(1500, [1200]),
      sampleAt(2000, [1500])
    ]
    const plan = buildReframePlan({ samples, source: SRC, aspect: NINE_SIXTEEN, mode: 'auto' })
    expect(plan?.mode).toBe('pan')
    if (plan?.mode === 'pan') {
      expect(plan.cropW).toBe(608)
      expect(plan.xExpr).toContain('between(t')
      expect(plan.xExpr.startsWith('max(0\\,min(')).toBe(true)
      // Clamp ceiling = width - cropW = 1312.
      expect(plan.xExpr).toContain('1312')
      // Fully escaped — no bare commas.
      expect(plan.xExpr.replace(/\\,/g, '')).not.toContain(',')
    }
  })

  it('pan crop-x tracks the face: early x near left, late x near right', () => {
    // Sample a slow left→right sweep; evaluate the linear path at the anchors.
    const samples = Array.from({ length: 11 }, (_, i) => sampleAt(i * 200, [300 + i * 120])) // 300 → 1500
    const plan = buildReframePlan({ samples, source: SRC, aspect: NINE_SIXTEEN, mode: 'auto' })
    expect(plan?.mode).toBe('pan')
    if (plan?.mode === 'pan') {
      // The first lerp base `x0` is the start crop-x; the trailing hold value
      // (last bare integer before the closing clamp `\,<maxX>))`) is the end
      // crop-x. A left→right sweep must have start < end (monotonic-ish).
      const startMatch = plan.xExpr.match(/min\(if\(between\([^)]*\)\\,(\d+)\+/)
      const endMatch = plan.xExpr.match(/\\,(\d+)\)+\\,1312\)\)$/)
      const startX = Number(startMatch?.[1])
      const endX = Number(endMatch?.[1])
      expect(Number.isNaN(startX)).toBe(false)
      expect(Number.isNaN(endX)).toBe(false)
      expect(startX).toBeLessThan(endX)
    }
  })
})

describe('buildReframePlan: two-speaker SPLIT', () => {
  it('returns two cluster tile regions in split mode', () => {
    const samples = [sampleAt(0, [500, 1500]), sampleAt(200, [510, 1490])]
    const plan = buildReframePlan({ samples, source: SRC, aspect: NINE_SIXTEEN, mode: 'split' })
    expect(plan?.mode).toBe('split')
    if (plan?.mode === 'split') {
      const [l, r] = plan.regions
      expect(l.cropX).toBeLessThan(r.cropX) // left tile is left of right tile
      for (const reg of plan.regions) {
        expect(reg.cropX).toBeGreaterThanOrEqual(0)
        expect(reg.cropX + reg.cropW).toBeLessThanOrEqual(SRC.width)
        expect(reg.cropY).toBeGreaterThanOrEqual(0)
        expect(reg.cropY + reg.cropH).toBeLessThanOrEqual(SRC.height)
      }
    }
  })

  it('split with only one speaker degrades to single-speaker static', () => {
    const samples = [sampleAt(0, [960]), sampleAt(200, [962])]
    const plan = buildReframePlan({ samples, source: SRC, aspect: NINE_SIXTEEN, mode: 'split' })
    expect(plan?.mode).toBe('static')
  })
})

describe('buildReframePlan: two-speaker AUTO (active-speaker pan)', () => {
  const twoSpeakerSamples: SampleFrame[] = [
    sampleAt(0, [400, 1500]),
    sampleAt(1000, [405, 1495]),
    sampleAt(2000, [398, 1502])
  ]

  it('builds a STEP pan between the two cluster crop-x values when motion is given', () => {
    const n = 51
    const times = Array.from({ length: n }, (_, i) => i * 0.2) // 0..10s
    const left: number[] = []
    const right: number[] = []
    for (let i = 0; i < n; i++) {
      if (times[i] < 5) {
        left.push(10)
        right.push(1)
      } else {
        left.push(1)
        right.push(10)
      }
    }
    const motion: MotionTimeline = { times, left, right }
    const plan = buildReframePlan({
      samples: twoSpeakerSamples,
      motion,
      source: SRC,
      aspect: NINE_SIXTEEN,
      mode: 'auto'
    })
    expect(plan?.mode).toBe('pan')
    if (plan?.mode === 'pan') {
      expect(plan.xExpr).toContain('lt(t')
      expect(plan.xExpr.startsWith('max(0\\,min(')).toBe(true)
      expect(plan.xExpr.replace(/\\,/g, '')).not.toContain(',')
      // The two step values are the left (~96) and right (~1196) cluster crop-x.
      // left cluster cx≈401 → cropX≈401-304=97 ; right cx≈1499 → 1499-304=1195.
      const ints = (plan.xExpr.match(/\d+(\.\d+)?/g) || []).map(Number)
      expect(ints.some((x) => x > 80 && x < 200)).toBe(true) // a left-ish crop-x
      expect(ints.some((x) => x > 1000 && x < 1300)).toBe(true) // a right-ish crop-x
    }
  })

  it('falls back to single-speaker static on the dominant cluster when no motion', () => {
    const plan = buildReframePlan({
      samples: twoSpeakerSamples,
      motion: null,
      source: SRC,
      aspect: NINE_SIXTEEN,
      mode: 'auto'
    })
    expect(plan?.mode).toBe('static')
    if (plan?.mode === 'static') {
      expect(plan.cropX).toBeGreaterThanOrEqual(0)
      expect(plan.cropX + plan.cropW).toBeLessThanOrEqual(SRC.width)
    }
  })
})
