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
  detectReframe,
  type YuNetOutputs,
  type ReframeRunner
} from '@main/services/reframe-detect'
import type { FaceBox } from '@shared/reframe-plan'

// ---------------------------------------------------------------------------
// frameSampleArgs
// ---------------------------------------------------------------------------

describe('frameSampleArgs', () => {
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
  it('pairs each YAVG with the most-recent pts_time', () => {
    const stderr = [
      '[Parsed_metadata_4 @ 0x1] frame:0    pts:0       pts_time:0',
      '[Parsed_metadata_4 @ 0x1] lavfi.signalstats.YAVG=3.5',
      '[Parsed_metadata_4 @ 0x1] frame:1    pts:512     pts_time:0.5',
      '[Parsed_metadata_4 @ 0x1] lavfi.signalstats.YAVG=12.0',
      '[Parsed_metadata_4 @ 0x1] frame:2    pts:1024    pts_time:1.0',
      '[Parsed_metadata_4 @ 0x1] lavfi.signalstats.YAVG=1.25'
    ].join('\n')
    expect(parseMotionMetadata(stderr)).toEqual({
      times: [0, 0.5, 1.0],
      values: [3.5, 12.0, 1.25]
    })
  })

  it('returns empty series when there are no metadata lines', () => {
    expect(parseMotionMetadata('frame= 1\nframe= 2\n')).toEqual({ times: [], values: [] })
  })
})

// ---------------------------------------------------------------------------
// splitMotionSeries
// ---------------------------------------------------------------------------

describe('splitMotionSeries', () => {
  it('splits the interleaved (left-then-right) print into a MotionTimeline offset to absolute time', () => {
    // 4 frames per side: first half = left sink, second half = right sink.
    const series = {
      times: [0, 0.5, 1.0, 1.5, 0, 0.5, 1.0, 1.5],
      values: [1, 2, 3, 4, 10, 20, 30, 40]
    }
    expect(splitMotionSeries(series, 100)).toEqual({
      times: [100, 100.5, 101.0, 101.5],
      left: [1, 2, 3, 4],
      right: [10, 20, 30, 40]
    })
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

  it('runs the motion pass and returns a MotionTimeline when motionRois are supplied', async () => {
    const stdout = Buffer.alloc(FRAME_BYTES) // one frame
    const motionStderr = [
      'frame:0 pts_time:0',
      'lavfi.signalstats.YAVG=2.0',
      'frame:1 pts_time:0.5',
      'lavfi.signalstats.YAVG=4.0',
      // right sink series follows:
      'frame:0 pts_time:0',
      'lavfi.signalstats.YAVG=20.0',
      'frame:1 pts_time:0.5',
      'lavfi.signalstats.YAVG=40.0'
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
