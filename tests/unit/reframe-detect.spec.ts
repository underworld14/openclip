/**
 * tests/unit/reframe-detect.spec.ts — the auto-reframe detector seam (Part J,
 * Track B): pure ffmpeg arg-builders, the PURE YuNet output decoder + NMS, the
 * PURE motion-metadata parser, and the `detectReframe` orchestrator with an
 * injected ffmpeg runner + face detector. No real ffmpeg / onnxruntime: the spawn
 * is injected (canned stdout/stderr) and the detector is a stub.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  frameSampleArgs,
  motionArgs,
  decodeYuNet,
  nms,
  parseMotionMetadata,
  splitMotionSeries,
  trimMotionRois,
  detectReframe,
  planReframe,
  type YuNetOutputs,
  type ReframeRunner
} from '@main/services/reframe-detect'
import type { FaceBox, SampleFrame, MotionTimeline } from '@shared/reframe-plan'

// ---------------------------------------------------------------------------
// frameSampleArgs
// ---------------------------------------------------------------------------

describe('frameSampleArgs', () => {
  it('frameSampleArgs/motionArgs reject a sourcePath beginning with a dash (openclip-6l6)', () => {
    expect(() => frameSampleArgs('-i', 0, 1, 2, 640)).toThrow(/sourcePath/)
    expect(() =>
      motionArgs('-i', 0, 1, { x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 10, h: 10 })
    ).toThrow(/sourcePath/)
  })

  it('seeks, limits duration, samples at fps and stretches to size x size RGB on stdout', () => {
    expect(frameSampleArgs('/src/in.mp4', 12, 8, 2, 640)).toEqual([
      '-hide_banner',
      '-nostats',
      '-ss',
      '12',
      '-i',
      '/src/in.mp4',
      '-t',
      '8',
      '-vf',
      'fps=2,scale=640:640,format=rgb24',
      '-f',
      'rawvideo',
      'pipe:1'
    ])
  })

  it('defaults size to 640 (the YuNet fixed input edge)', () => {
    expect(frameSampleArgs('/s.mp4', 0, 5, 3)).toContain('fps=3,scale=640:640,format=rgb24')
  })
})

// ---------------------------------------------------------------------------
// motionArgs
// ---------------------------------------------------------------------------

describe('motionArgs', () => {
  it('builds a per-ROI crop+gray+tblend-difference+signalstats print to two null sinks', () => {
    const args = motionArgs(
      '/src/in.mp4',
      10,
      30,
      { x: 0, y: 0, w: 100, h: 200 },
      { x: 540, y: 0, w: 100, h: 200 }
    )
    expect(args).toEqual([
      '-hide_banner',
      '-nostats',
      '-ss',
      '10',
      '-i',
      '/src/in.mp4',
      '-t',
      '20',
      '-filter_complex',
      '[0:v]crop=100:200:0:0,format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG[lm];' +
        '[0:v]crop=100:200:540:0,format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG[rm]',
      '-map',
      '[lm]',
      '-f',
      'null',
      '-',
      '-map',
      '[rm]',
      '-f',
      'null',
      '-'
    ])
  })
})

// ---------------------------------------------------------------------------
// decodeYuNet
// ---------------------------------------------------------------------------

/** Build a zeroed set of the 12 YuNet outputs for a given modelSize. */
function emptyYuNetOutputs(modelSize = 640): YuNetOutputs {
  const mk = (stride: number, ch: number): Float32Array => {
    const g = modelSize / stride
    return new Float32Array(g * g * ch)
  }
  return {
    cls_8: mk(8, 1),
    cls_16: mk(16, 1),
    cls_32: mk(32, 1),
    obj_8: mk(8, 1),
    obj_16: mk(16, 1),
    obj_32: mk(32, 1),
    bbox_8: mk(8, 4),
    bbox_16: mk(16, 4),
    bbox_32: mk(32, 4),
    kps_8: mk(8, 10),
    kps_16: mk(16, 10),
    kps_32: mk(32, 10)
  }
}

describe('decodeYuNet', () => {
  it('decodes one high-score stride-8 cell to a FaceBox at the expected SOURCE coords', () => {
    const out = emptyYuNetOutputs(640)
    // Grid for stride 8 is 80x80. Put a face at row=10, col=20 → idx = 10*80+20 = 820.
    const g = 640 / 8 // 80
    const idx = 10 * g + 20 // 820
    out.cls_8[idx] = 1.0
    out.obj_8[idx] = 1.0 // score = sqrt(1*1) = 1.0
    // bbox offsets: cx/cy offset 0.5 each; w/h exp(0)=1 → 8px in model space.
    out.bbox_8[idx * 4 + 0] = 0.5
    out.bbox_8[idx * 4 + 1] = 0.5
    out.bbox_8[idx * 4 + 2] = 0 // exp(0)*8 = 8
    out.bbox_8[idx * 4 + 3] = 0 // exp(0)*8 = 8

    // Source 1280x720 → sx = 2, sy = 1.125.
    const faces = decodeYuNet(out, { source: { width: 1280, height: 720 } })
    expect(faces).toHaveLength(1)
    const f = faces[0]
    // model: cx=(20+0.5)*8=164, cy=(10+0.5)*8=84, w=h=8 → x=160, y=80
    // source: x=160*2=320, y=80*1.125=90, w=8*2=16, h=8*1.125=9
    expect(f.x).toBeCloseTo(320, 6)
    expect(f.y).toBeCloseTo(90, 6)
    expect(f.w).toBeCloseTo(16, 6)
    expect(f.h).toBeCloseTo(9, 6)
    expect(f.confidence).toBeCloseTo(1.0, 6)
  })

  it('drops sub-threshold cells (default conf 0.6)', () => {
    const out = emptyYuNetOutputs(640)
    const idx = 100
    // score = sqrt(0.5 * 0.5) = 0.5 < 0.6 → dropped.
    out.cls_8[idx] = 0.5
    out.obj_8[idx] = 0.5
    out.bbox_8[idx * 4 + 2] = 0
    out.bbox_8[idx * 4 + 3] = 0
    expect(decodeYuNet(out, { source: { width: 640, height: 640 } })).toHaveLength(0)
  })

  it('NMS dedupes two overlapping high-score boxes, keeping the higher score', () => {
    const out = emptyYuNetOutputs(640)
    const g = 640 / 8
    // Two adjacent cells (cols 20 and 21, same row) with wide overlapping boxes.
    const idxA = 30 * g + 20
    const idxB = 30 * g + 21
    out.cls_8[idxA] = 1.0
    out.obj_8[idxA] = 1.0 // score 1.0
    out.cls_8[idxB] = 0.81
    out.obj_8[idxB] = 0.81 // score 0.81
    // Big boxes (exp(3)*8 ≈ 160px) so the two heavily overlap → IoU > 0.3.
    for (const i of [idxA, idxB]) {
      out.bbox_8[i * 4 + 0] = 0.5
      out.bbox_8[i * 4 + 1] = 0.5
      out.bbox_8[i * 4 + 2] = 3
      out.bbox_8[i * 4 + 3] = 3
    }
    const faces = decodeYuNet(out, { source: { width: 640, height: 640 } })
    expect(faces).toHaveLength(1)
    expect(faces[0].confidence).toBeCloseTo(1.0, 6) // the higher-scoring box survives
  })
})

// ---------------------------------------------------------------------------
// nms (direct)
// ---------------------------------------------------------------------------

describe('nms', () => {
  it('keeps non-overlapping boxes and suppresses overlapping lower-score ones', () => {
    const a: FaceBox = { x: 0, y: 0, w: 100, h: 100, confidence: 0.9 }
    const b: FaceBox = { x: 10, y: 10, w: 100, h: 100, confidence: 0.8 } // overlaps a
    const c: FaceBox = { x: 500, y: 500, w: 100, h: 100, confidence: 0.7 } // far away
    const kept = nms([a, b, c], 0.3)
    expect(kept.map((k) => k.confidence)).toEqual([0.9, 0.7])
  })
})

// ---------------------------------------------------------------------------
// parseMotionMetadata
// ---------------------------------------------------------------------------

describe('parseMotionMetadata', () => {
  it('groups YAVG values by the [Parsed_metadata_N @ …] instance, first-seen order preserved', () => {
    // Real ffmpeg with one decode feeding TWO metadata sinks INTERLEAVES per frame:
    // left(4) then right(5) for frame 0, then frame 1, … Each instance N is its own
    // group; each YAVG pairs with ITS OWN group's latest pts_time.
    const stderr = [
      '[Parsed_metadata_4 @ 0x1] frame:0    pts:0       pts_time:0',
      '[Parsed_metadata_4 @ 0x1] lavfi.signalstats.YAVG=3.5',
      '[Parsed_metadata_5 @ 0x2] frame:0    pts:0       pts_time:0',
      '[Parsed_metadata_5 @ 0x2] lavfi.signalstats.YAVG=30.0',
      '[Parsed_metadata_4 @ 0x1] frame:1    pts:512     pts_time:0.5',
      '[Parsed_metadata_4 @ 0x1] lavfi.signalstats.YAVG=12.0',
      '[Parsed_metadata_5 @ 0x2] frame:1    pts:512     pts_time:0.5',
      '[Parsed_metadata_5 @ 0x2] lavfi.signalstats.YAVG=40.0'
    ].join('\n')
    // First-seen instance 4 = group[0], instance 5 = group[1].
    expect(parseMotionMetadata(stderr)).toEqual([
      { times: [0, 0.5], values: [3.5, 12.0] },
      { times: [0, 0.5], values: [30.0, 40.0] }
    ])
  })

  it('returns a single group for one ROI (single-instance print)', () => {
    const stderr = [
      '[Parsed_metadata_2 @ 0xa] frame:0 pts_time:0',
      '[Parsed_metadata_2 @ 0xa] lavfi.signalstats.YAVG=2.0',
      '[Parsed_metadata_2 @ 0xa] frame:1 pts_time:0.5',
      '[Parsed_metadata_2 @ 0xa] lavfi.signalstats.YAVG=4.0'
    ].join('\n')
    expect(parseMotionMetadata(stderr)).toEqual([{ times: [0, 0.5], values: [2.0, 4.0] }])
  })

  it('returns no groups when there are no metadata lines', () => {
    expect(parseMotionMetadata('frame= 1\nframe= 2\n')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// splitMotionSeries
// ---------------------------------------------------------------------------

describe('trimMotionRois — mutually-exclusive motion ROIs (openclip-sx0)', () => {
  it('clips two overlapping split tiles at the midpoint between cluster centers', () => {
    // Left tile 100..400 (center 250), right tile 350..650 (center 500) overlap 350..400.
    const leftTile = { x: 100, y: 0, w: 300, h: 1080 }
    const rightTile = { x: 350, y: 0, w: 300, h: 1080 }
    const { left, right } = trimMotionRois(leftTile, rightTile, 250, 500)
    // Midpoint = (250+500)/2 = 375; tiles meet there and no longer overlap.
    expect(left.x + left.w).toBeLessThanOrEqual(right.x)
    expect(left.x + left.w).toBe(375)
    expect(right.x).toBe(375)
    // Vertical extent is preserved.
    expect(left.h).toBe(1080)
    expect(right.h).toBe(1080)
  })

  it('orders by center so a right-first argument pair still yields left.x < right.x', () => {
    const a = { x: 350, y: 0, w: 300, h: 100 } // center 500 (the RIGHT speaker)
    const b = { x: 100, y: 0, w: 300, h: 100 } // center 250 (the LEFT speaker)
    const { left, right } = trimMotionRois(a, b, 500, 250)
    expect(left.x).toBeLessThan(right.x)
    expect(left.x + left.w).toBeLessThanOrEqual(right.x)
  })
})

describe('splitMotionSeries', () => {
  it('maps first-seen group → left, second → right, offset to absolute time', () => {
    // Two grouped per-instance series (first-seen N = left, second = right).
    const groups = [
      { times: [0, 0.5, 1.0, 1.5], values: [1, 2, 3, 4] },
      { times: [0, 0.5, 1.0, 1.5], values: [10, 20, 30, 40] }
    ]
    expect(splitMotionSeries(groups, 100)).toEqual({
      times: [100, 100.5, 101.0, 101.5],
      left: [1, 2, 3, 4],
      right: [10, 20, 30, 40]
    })
  })

  it('single group (one ROI) → left = right (mirrored), times offset to absolute', () => {
    const groups = [{ times: [0, 0.5], values: [5, 7] }]
    expect(splitMotionSeries(groups, 10)).toEqual({
      times: [10, 10.5],
      left: [5, 7],
      right: [5, 7]
    })
  })

  it('clamps to the shorter group when the two are uneven', () => {
    const groups = [
      { times: [0, 0.5, 1.0], values: [1, 2, 3] },
      { times: [0, 0.5], values: [10, 20] }
    ]
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(splitMotionSeries(groups, 0)).toEqual({
      times: [0, 0.5],
      left: [1, 2],
      right: [10, 20]
    })
    // The silent clamp is now visible (openclip-36u): a per-side count mismatch
    // (left 3 vs right 2) risks misalignment, so it must be logged, not swallowed.
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/reframe.*motion.*mismatch/i))
    warn.mockRestore()
  })

  it('does NOT warn when the two groups are equal length (openclip-36u)', () => {
    const groups = [
      { times: [0, 0.5], values: [1, 2] },
      { times: [0, 0.5], values: [10, 20] }
    ]
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    splitMotionSeries(groups, 0)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('no groups → empty timeline', () => {
    expect(splitMotionSeries([], 0)).toEqual({ times: [], left: [], right: [] })
  })
})

// ---------------------------------------------------------------------------
// detectReframe (orchestrator, injected run + detector)
// ---------------------------------------------------------------------------

describe('detectReframe', () => {
  const SIZE = 4 // tiny model size → 4*4*3 = 48 bytes per frame
  const FRAME_BYTES = SIZE * SIZE * 3

  it('samples frames and stamps each at ABSOLUTE source timeMs = (start + idx/fps)*1000', async () => {
    // Two frames worth of raw bytes on stdout.
    const stdout = Buffer.alloc(FRAME_BYTES * 2)
    const run = vi.fn<ReframeRunner>(async () => ({ stdout, stderr: '' }))
    // Detector returns a distinct box per frame so we can assert per-frame mapping.
    let call = 0
    const detector = vi.fn((): FaceBox[] => {
      call += 1
      return [{ x: call, y: 0, w: 10, h: 10, confidence: 0.9 }]
    })

    const res = await detectReframe({
      sourcePath: '/src/in.mp4',
      startTime: 30,
      endTime: 31, // 1s span
      sampleFps: 2,
      source: { width: 1280, height: 720 },
      modelSize: SIZE,
      run,
      detector
    })

    // The arg-builder seam: a single frame-sample pass (no motion ROIs given).
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][0].args).toEqual(frameSampleArgs('/src/in.mp4', 30, 1, 2, SIZE))
    expect(detector).toHaveBeenCalledTimes(2)
    expect(res.samples).toEqual([
      { timeMs: 30000, faces: [{ x: 1, y: 0, w: 10, h: 10, confidence: 0.9 }] },
      { timeMs: 30500, faces: [{ x: 2, y: 0, w: 10, h: 10, confidence: 0.9 }] }
    ])
    expect(res.motion).toBeUndefined()
  })

  it('does NOT dispose an INJECTED detector — the caller owns it (audit fix openclip-y3h)', async () => {
    // y3h disposes the WASM session ONLY for the DEFAULT detector it creates itself;
    // a caller-injected detector must be left intact (its lifecycle is the caller's).
    const stdout = Buffer.alloc(FRAME_BYTES)
    const run = vi.fn<ReframeRunner>(async () => ({ stdout, stderr: '' }))
    const dispose = vi.fn(async () => {})
    const detector = Object.assign(
      vi.fn((): FaceBox[] => []),
      { dispose }
    )
    await detectReframe({
      sourcePath: '/src/in.mp4',
      startTime: 0,
      endTime: 1,
      sampleFps: 1,
      source: { width: 100, height: 100 },
      modelSize: SIZE,
      run,
      detector
    })
    expect(detector).toHaveBeenCalled()
    expect(dispose).not.toHaveBeenCalled()
  })

  it('runs the motion pass and returns a MotionTimeline when motionRois are supplied', async () => {
    const stdout = Buffer.alloc(FRAME_BYTES) // one frame
    // Real ffmpeg INTERLEAVES the two sinks per frame (left N then right N), each
    // line prefixed with its `[Parsed_metadata_N @ 0x…]` instance. First-seen
    // instance (4) = left sink, second (5) = right sink.
    const motionStderr = [
      '[Parsed_metadata_4 @ 0x1] frame:0 pts_time:0',
      '[Parsed_metadata_4 @ 0x1] lavfi.signalstats.YAVG=2.0',
      '[Parsed_metadata_5 @ 0x2] frame:0 pts_time:0',
      '[Parsed_metadata_5 @ 0x2] lavfi.signalstats.YAVG=20.0',
      '[Parsed_metadata_4 @ 0x1] frame:1 pts_time:0.5',
      '[Parsed_metadata_4 @ 0x1] lavfi.signalstats.YAVG=4.0',
      '[Parsed_metadata_5 @ 0x2] frame:1 pts_time:0.5',
      '[Parsed_metadata_5 @ 0x2] lavfi.signalstats.YAVG=40.0'
    ].join('\n')
    const run = vi
      .fn<ReframeRunner>()
      .mockResolvedValueOnce({ stdout, stderr: '' }) // frame-sample pass
      .mockResolvedValueOnce({ stdout: Buffer.alloc(0), stderr: motionStderr }) // motion pass
    const detector = vi.fn((): FaceBox[] => [])

    const res = await detectReframe({
      sourcePath: '/src/in.mp4',
      startTime: 10,
      endTime: 11,
      sampleFps: 1,
      source: { width: 1280, height: 720 },
      modelSize: SIZE,
      motionRois: { left: { x: 0, y: 0, w: 100, h: 200 }, right: { x: 540, y: 0, w: 100, h: 200 } },
      run,
      detector
    })

    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls[1][0].args).toEqual(
      motionArgs(
        '/src/in.mp4',
        10,
        11,
        { x: 0, y: 0, w: 100, h: 200 },
        {
          x: 540,
          y: 0,
          w: 100,
          h: 200
        }
      )
    )
    expect(res.motion).toEqual({
      times: [10, 10.5], // 0-based pts offset by startTime=10
      left: [2.0, 4.0],
      right: [20.0, 40.0]
    })
  })

  it('returns no samples without spawning for a non-positive span', async () => {
    const run = vi.fn()
    const res = await detectReframe({
      sourcePath: '/s.mp4',
      startTime: 5,
      endTime: 5,
      source: { width: 100, height: 100 },
      run
    })
    expect(res.samples).toEqual([])
    expect(run).not.toHaveBeenCalled()
  })

  it('awaits an async detector (real YuNet seam is async)', async () => {
    const stdout = Buffer.alloc(FRAME_BYTES)
    const run = vi.fn(async () => ({ stdout, stderr: '' }))
    const detector = vi.fn(
      async (): Promise<FaceBox[]> => [{ x: 7, y: 7, w: 1, h: 1, confidence: 0.95 }]
    )
    const res = await detectReframe({
      sourcePath: '/src/in.mp4',
      startTime: 0,
      endTime: 1,
      sampleFps: 1,
      source: { width: 64, height: 64 },
      modelSize: SIZE,
      run,
      detector
    })
    expect(res.samples).toEqual([
      { timeMs: 0, faces: [{ x: 7, y: 7, w: 1, h: 1, confidence: 0.95 }] }
    ])
  })
})

describe('planReframe orchestration (Part J Phase 2)', () => {
  const SRC = { width: 1920, height: 1080 }
  // A comfortably-passing face (area 200x240 = 2.3% of frame, max dim ≥ 30px).
  const face = (x: number): FaceBox => ({ x, y: 400, w: 200, h: 240, confidence: 0.9 })
  const detectStub = (samples: SampleFrame[]): typeof detectReframe =>
    vi.fn(async () => ({ samples })) as unknown as typeof detectReframe

  it('single speaker → NO motion pass, returns a static/pan plan', async () => {
    const detect = detectStub([
      { timeMs: 0, faces: [face(800)] },
      { timeMs: 500, faces: [face(810)] }
    ])
    const motion = vi.fn()
    const plan = await planReframe({
      sourcePath: '/s.mp4',
      startTime: 0,
      endTime: 2,
      source: SRC,
      aspect: '9:16',
      mode: 'auto',
      detect,
      motion: motion as never
    })
    expect(detect).toHaveBeenCalledOnce()
    expect(motion).not.toHaveBeenCalled()
    expect(plan?.mode === 'static' || plan?.mode === 'pan').toBe(true)
  })

  it('rebases the pan xExpr to CLIP-RELATIVE time for a clip starting after 0 (review-critical fix)', async () => {
    // A single speaker sweeping left→right (center moves well past the deadzone) →
    // a PAN plan. The clip starts at 30s; sample times are stamped absolute. The
    // emitted xExpr MUST be in clip-relative time (t≈0..), matching the `-ss`-rebased
    // PTS ffmpeg feeds crop — NOT absolute source seconds (the silent-mis-crop bug).
    const sweep: SampleFrame[] = [600, 760, 920, 1080].map((x, i) => ({
      timeMs: 30_000 + i * 500, // (30 + i*0.5)s, absolute
      faces: [face(x)]
    }))
    const plan = await planReframe({
      sourcePath: '/s.mp4',
      startTime: 30,
      endTime: 32,
      source: SRC,
      aspect: '9:16',
      mode: 'auto',
      detect: detectStub(sweep),
      motion: vi.fn() as never
    })
    expect(plan?.mode).toBe('pan')
    if (plan?.mode === 'pan') {
      // first keyframe boundary is at clip-relative t≈0, never the absolute 30.
      expect(plan.xExpr).toContain('between(t\\,0\\,')
      expect(plan.xExpr).not.toContain('30\\,') // no absolute-time boundary leaked through
      expect(plan.cropX).toBeGreaterThanOrEqual(0) // static fallback present for jump-cuts
    }
  })

  it('two speakers + auto → runs the motion pass', async () => {
    const two = (t: number): SampleFrame => ({ timeMs: t, faces: [face(300), face(1500)] })
    const detect = detectStub([two(0), two(500), two(1000), two(1500)])
    const motion = vi.fn(
      async (): Promise<MotionTimeline> => ({ times: [0, 1, 2], left: [1, 5, 1], right: [5, 1, 5] })
    )
    const plan = await planReframe({
      sourcePath: '/s.mp4',
      startTime: 0,
      endTime: 2,
      source: SRC,
      aspect: '9:16',
      mode: 'auto',
      detect,
      motion: motion as never
    })
    expect(motion).toHaveBeenCalledOnce()
    expect(plan).not.toBeNull()
  })

  it('split mode with two speakers → split plan, NO motion pass', async () => {
    const two = (t: number): SampleFrame => ({ timeMs: t, faces: [face(300), face(1500)] })
    const detect = detectStub([two(0), two(500), two(1000)])
    const motion = vi.fn()
    const plan = await planReframe({
      sourcePath: '/s.mp4',
      startTime: 0,
      endTime: 2,
      source: SRC,
      aspect: '9:16',
      mode: 'split',
      detect,
      motion: motion as never
    })
    expect(motion).not.toHaveBeenCalled()
    expect(plan?.mode).toBe('split')
  })

  it('no faces → null (center-crop), no motion pass', async () => {
    const detect = detectStub([{ timeMs: 0, faces: [] }])
    const motion = vi.fn()
    const plan = await planReframe({
      sourcePath: '/s.mp4',
      startTime: 0,
      endTime: 2,
      source: SRC,
      aspect: '9:16',
      mode: 'auto',
      detect,
      motion: motion as never
    })
    expect(plan).toBeNull()
    expect(motion).not.toHaveBeenCalled()
  })
})
