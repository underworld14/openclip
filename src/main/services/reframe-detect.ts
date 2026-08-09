/**
 * src/main/services/reframe-detect.ts — face detection + 2-speaker motion energy
 * for auto-reframe (Part J). PURE arg-builders + a PURE YuNet output decoder +
 * a PURE ffmpeg-metadata parser, plus an `detectReframe` orchestrator whose
 * ffmpeg spawn AND onnx session are INJECTABLE so the unit tests run fully
 * offline (no real ffmpeg, no real onnxruntime).
 *
 * Mirrors the seam of `silence-detect.ts`: pure arg-builders feed a default
 * `ffmpeg-core.runFfmpeg` runner; `-ss` before `-i` makes the sampled frame /
 * motion timestamps 0-based, and the orchestrator offsets them back to ABSOLUTE
 * source time so `SampleFrame.timeMs` / `MotionTimeline.times` line up with the
 * clip bounds the planner (Track A) consumes.
 *
 * Two ffmpeg passes:
 *  1. FRAME SAMPLE — decode `sampleFps` frames as raw 640x640 RGB on stdout;
 *     each frame is run through YuNet → `FaceBox[]` (SOURCE px).
 *  2. MOTION (only when the caller asks, i.e. there are 2 face clusters) — a
 *     `tblend=difference + signalstats` filtergraph per ROI prints the per-frame
 *     luma-difference energy (`lavfi.signalstats.YAVG`) to stderr metadata, which
 *     `parseMotionMetadata` turns into a {times,values} series → `MotionTimeline`.
 *
 * The YuNet model has a FIXED [1,3,640,640] NCHW float32 input named "input" and
 * 12 anchor-free outputs (cls/obj/bbox/kps at strides 8/16/32). `decodeYuNet`
 * implements the standard OpenCV decode (score = sqrt(cls*obj); cx/cy = (col/row
 * + bbox) * stride; w/h = exp(bbox) * stride) and IoU-NMS, scaling boxes from the
 * 640 model space back to SOURCE pixels.
 */

import { spawn } from 'node:child_process'
import { ffmpegPath, reframeModelPath, reframeWasmDir } from '@main/utils/paths'
import { assertSafePathArg } from '@main/utils/safe-arg'
import type { FaceBox, SampleFrame, MotionTimeline, ReframePlan } from '@shared/reframe-plan'
import {
  buildReframePlan,
  filterFaceOutliers,
  clusterTwoFaceRegions,
  clusterTileRegion
} from '@shared/reframe-plan'
import type { AspectRatio } from '@shared/schema'
// Type-only import (erased at compile — does NOT eagerly load the heavy WASM
// module; the runtime `require('onnxruntime-web')` stays lazy below).
import type * as OrtModule from 'onnxruntime-web'
import type { InferenceSession } from 'onnxruntime-web'

// ============================================================================
// Frame-sampling arg-builder (pure)
// ============================================================================

/**
 * Build the frame-sampling argv: seek to `startTime`, decode `durationSec`
 * worth of frames at `sampleFps`, stretch each to `size`x`size` RGB24 and emit
 * raw video on stdout (`pipe:1`). `-ss` BEFORE `-i` keeps the decoded run 0-based
 * (the orchestrator offsets sample times back to absolute source time).
 *
 * The `size`x`size` stretch (default 640, the model's fixed input) intentionally
 * discards aspect ratio: `decodeYuNet` scales detections back to SOURCE px using
 * the independent x/y ratios, so the squash is corrected at decode time.
 */
export function frameSampleArgs(
  sourcePath: string,
  startTime: number,
  durationSec: number,
  sampleFps: number,
  size = 640
): string[] {
  return [
    '-hide_banner',
    '-nostats',
    '-ss',
    String(startTime),
    '-i',
    // Option-injection guard (audit fix openclip-6l6).
    assertSafePathArg(sourcePath, 'sourcePath'),
    '-t',
    String(durationSec),
    '-vf',
    `fps=${sampleFps},scale=${size}:${size},format=rgb24`,
    '-f',
    'rawvideo',
    'pipe:1'
  ]
}

// ============================================================================
// YuNet output decode (pure)
// ============================================================================

/** YuNet's three feature-map strides; grid size per stride = modelSize / stride. */
const YUNET_STRIDES = [8, 16, 32] as const

/** The 12 named YuNet outputs (cls/obj/bbox at each stride; kps unused here). */
export interface YuNetOutputs {
  cls_8: Float32Array
  cls_16: Float32Array
  cls_32: Float32Array
  obj_8: Float32Array
  obj_16: Float32Array
  obj_32: Float32Array
  bbox_8: Float32Array
  bbox_16: Float32Array
  bbox_32: Float32Array
  kps_8?: Float32Array
  kps_16?: Float32Array
  kps_32?: Float32Array
}

export interface DecodeYuNetOptions {
  /** SOURCE frame dimensions the boxes are scaled back to (from model 640 space). */
  source: { width: number; height: number }
  /** Minimum sqrt(cls*obj) score to keep a detection. Default 0.6. */
  confThreshold?: number
  /** IoU above which the lower-scoring box is suppressed in NMS. Default 0.3. */
  nmsThreshold?: number
  /** The model's square input edge (YuNet is fixed at 640). Default 640. */
  modelSize?: number
}

function clamp01(v: number): number {
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}

/** Intersection-over-union of two FaceBoxes (used by `nms`). */
function iou(a: FaceBox, b: FaceBox): number {
  const ix1 = Math.max(a.x, b.x)
  const iy1 = Math.max(a.y, b.y)
  const ix2 = Math.min(a.x + a.w, b.x + b.w)
  const iy2 = Math.min(a.y + a.h, b.y + b.h)
  const iw = Math.max(0, ix2 - ix1)
  const ih = Math.max(0, iy2 - iy1)
  const inter = iw * ih
  if (inter <= 0) return 0
  const union = a.w * a.h + b.w * b.h - inter
  return union > 0 ? inter / union : 0
}

/**
 * Greedy IoU non-maximum suppression: keep highest-scoring boxes first, drop any
 * later box overlapping a kept one by more than `threshold`. Pure.
 */
export function nms(boxes: FaceBox[], threshold: number): FaceBox[] {
  const sorted = [...boxes].sort((a, b) => b.confidence - a.confidence)
  const kept: FaceBox[] = []
  for (const box of sorted) {
    let suppressed = false
    for (const k of kept) {
      if (iou(box, k) > threshold) {
        suppressed = true
        break
      }
    }
    if (!suppressed) kept.push(box)
  }
  return kept
}

/**
 * Decode the 12 raw YuNet output arrays into `FaceBox[]` in SOURCE pixels.
 *
 * For each stride `s` (grid edge `g = modelSize / s`) and cell `idx` with
 * `row = floor(idx / g)`, `col = idx % g`:
 *   score = sqrt(clamp01(cls[idx]) * clamp01(obj[idx]))         // drop if < conf
 *   cx = (col + bbox[idx*4+0]) * s;  cy = (row + bbox[idx*4+1]) * s
 *   w  = exp(bbox[idx*4+2]) * s;     h  = exp(bbox[idx*4+3]) * s
 *   x  = cx - w/2;                   y  = cy - h/2              // (MODEL space)
 * then scale (x,w) by source.width/modelSize and (y,h) by source.height/modelSize
 * to land in SOURCE px. Detections across all 3 strides are pooled and IoU-NMS'd.
 *
 * Matches the OpenCV `FaceDetectorYN` postprocess (confirmed against
 * opencv objdetect `face_detect.cpp` generateProposals).
 */
export function decodeYuNet(outputs: YuNetOutputs, opts: DecodeYuNetOptions): FaceBox[] {
  const conf = opts.confThreshold ?? 0.6
  const nmsThresh = opts.nmsThreshold ?? 0.3
  const modelSize = opts.modelSize ?? 640
  const sx = opts.source.width / modelSize
  const sy = opts.source.height / modelSize

  const cls: Record<number, Float32Array> = {
    8: outputs.cls_8,
    16: outputs.cls_16,
    32: outputs.cls_32
  }
  const obj: Record<number, Float32Array> = {
    8: outputs.obj_8,
    16: outputs.obj_16,
    32: outputs.obj_32
  }
  const bbox: Record<number, Float32Array> = {
    8: outputs.bbox_8,
    16: outputs.bbox_16,
    32: outputs.bbox_32
  }

  const proposals: FaceBox[] = []
  for (const s of YUNET_STRIDES) {
    const g = modelSize / s
    const cells = g * g
    const clsArr = cls[s]
    const objArr = obj[s]
    const bboxArr = bbox[s]
    for (let idx = 0; idx < cells; idx++) {
      const score = Math.sqrt(clamp01(clsArr[idx]) * clamp01(objArr[idx]))
      if (score < conf) continue
      const row = Math.floor(idx / g)
      const col = idx % g
      const b = idx * 4
      const cx = (col + bboxArr[b]) * s
      const cy = (row + bboxArr[b + 1]) * s
      const w = Math.exp(bboxArr[b + 2]) * s
      const h = Math.exp(bboxArr[b + 3]) * s
      // model space → source px (independent x/y ratios undo the 640 stretch).
      proposals.push({
        x: (cx - w / 2) * sx,
        y: (cy - h / 2) * sy,
        w: w * sx,
        h: h * sy,
        confidence: score
      })
    }
  }
  return nms(proposals, nmsThresh)
}

// ============================================================================
// Motion-pass arg-builder + metadata parser (pure)
// ============================================================================

/** A rectangular region of interest in SOURCE pixels (for the per-side motion crop). */
export interface MotionRoi {
  x: number
  y: number
  w: number
  h: number
}

/**
 * One per-instance motion series: parallel {times,values}. `times` are 0-based to
 * the `-ss` seek; `values` are the per-frame `lavfi.signalstats.YAVG` energy.
 * `parseMotionMetadata` returns one of these PER `metadata=print` filter instance.
 */
export interface MotionSeries {
  times: number[]
  values: number[]
}

/**
 * Build the motion-energy argv (2-speaker active-speaker detection). For each ROI
 * we crop, drop to gray, `tblend=all_mode=difference` (frame-to-frame delta), run
 * `signalstats`, and `metadata=print` the per-frame average luma of that delta
 * (`lavfi.signalstats.YAVG`) — higher delta ≈ more motion (a talking speaker).
 * Both ROI chains are `-map`'d to their own `-f null -` sink. With one decode
 * feeding both chains ffmpeg INTERLEAVES the two prints per frame (left then
 * right), each line tagged with its own `[Parsed_metadata_<N> @ …]` instance;
 * `parseMotionMetadata` separates them by that instance (first-seen N = left).
 *
 *   ffmpeg -i src -filter_complex
 *     "[0:v]crop=lw:lh:lx:ly,format=gray,tblend=all_mode=difference,
 *           signalstats,metadata=print:key=lavfi.signalstats.YAVG[lm];
 *      [0:v]crop=rw:rh:rx:ry,format=gray,tblend=all_mode=difference,
 *           signalstats,metadata=print:key=lavfi.signalstats.YAVG[rm]"
 *     -map [lm] -f null - -map [rm] -f null -
 *
 * Note: a single source decode feeds both chains; the planner correlates the two
 * energy series to decide which side is the active speaker over time.
 */
export function motionArgs(
  sourcePath: string,
  start: number,
  end: number,
  leftROI: MotionRoi,
  rightROI: MotionRoi
): string[] {
  const dur = end - start
  const chain = (roi: MotionRoi, label: string): string =>
    `[0:v]crop=${roi.w}:${roi.h}:${roi.x}:${roi.y},format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG[${label}]`
  const filter = `${chain(leftROI, 'lm')};${chain(rightROI, 'rm')}`
  return [
    '-hide_banner',
    '-nostats',
    '-ss',
    String(start),
    '-i',
    // Option-injection guard (audit fix openclip-6l6).
    assertSafePathArg(sourcePath, 'sourcePath'),
    '-t',
    String(dur),
    '-filter_complex',
    filter,
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
  ]
}

/**
 * Parse the `metadata=print` stderr into ONE PER-INSTANCE series per metadata
 * filter, GROUPED by the `[Parsed_metadata_<N> @ 0x…]` instance number.
 *
 * Real ffmpeg feeds a single decode into two `metadata=print` sinks (`[lm]`,
 * `[rm]`). It does NOT emit all-left-then-all-right: with one decode the two
 * chains run frame-by-frame, so the print INTERLEAVES per frame (left N, right N,
 * next frame, …). Each line carries its own `[Parsed_metadata_<N> @ …]` prefix,
 * so we key on instance N to keep the two series separate. Per frame ffmpeg
 * prints a `frame:<n> pts_time:<t>` line then a `lavfi.signalstats.YAVG=<v>`
 * line for the SAME instance, so each YAVG is paired with ITS OWN group's most
 * recent pts_time (a per-instance `lastTime`, not a single global one).
 *
 * Returns an ORDERED list of per-instance series, preserving first-seen instance
 * order: group[0] is whichever instance printed first (the `[lm]`/left sink,
 * mapped first in `motionArgs`), group[1] the second, etc. A single-ROI print
 * yields exactly one group. Pure — matches `motionArgs` output.
 */
export function parseMotionMetadata(stderr: string): MotionSeries[] {
  // Ordered groups + per-instance bookkeeping (first-seen order is load-bearing:
  // see splitMotionSeries — first instance = left, second = right).
  const order: number[] = []
  const byInstance = new Map<number, { series: MotionSeries; lastTime: number | null }>()

  const ensure = (n: number): { series: MotionSeries; lastTime: number | null } => {
    let g = byInstance.get(n)
    if (!g) {
      g = { series: { times: [], values: [] }, lastTime: null }
      byInstance.set(n, g)
      order.push(n)
    }
    return g
  }

  for (const line of stderr.split('\n')) {
    const mInst = /\[Parsed_metadata_(\d+) @/.exec(line)
    // Without an instance prefix we can't attribute the line to a group; skip it.
    if (!mInst) continue
    const g = ensure(parseInt(mInst[1], 10))

    const mt = /pts_time:\s*(-?[\d.]+)/.exec(line)
    if (mt) {
      g.lastTime = parseFloat(mt[1])
      continue
    }
    const mv = /lavfi\.signalstats\.YAVG\s*[:=]\s*(-?[\d.]+)/.exec(line)
    if (mv && g.lastTime !== null) {
      g.series.times.push(g.lastTime)
      g.series.values.push(parseFloat(mv[1]))
    }
  }

  return order.map((n) => byInstance.get(n)!.series)
}

// ============================================================================
// Orchestrator
// ============================================================================

/**
 * Detector seam: maps one raw RGB frame (w*h*3 bytes) → faces in SOURCE px. May
 * be synchronous (the unit spec injects a sync stub) or async (the real YuNet
 * default awaits an onnxruntime session); the orchestrator `await`s the result
 * either way.
 */
export type FrameDetector = (
  rgb: Uint8Array | Buffer,
  width: number,
  height: number
) => FaceBox[] | Promise<FaceBox[]>

/** Minimal ffmpeg-runner seam (captures stdout for the raw-frame pipe + stderr). */
export type ReframeRunner = (opts: {
  args: string[]
  binPath?: string
  signal?: AbortSignal
}) => Promise<{ stdout?: Buffer; stderr: string }>

export interface DetectReframeOptions {
  sourcePath: string
  /** Absolute clip start/end (seconds). */
  startTime: number
  endTime: number
  /** Frames per second to sample for face detection. Default 2. */
  sampleFps?: number
  /** SOURCE frame dimensions (needed to scale YuNet boxes + size the sample buffer). */
  source: { width: number; height: number }
  /** The square model edge to sample at (YuNet = 640). Default 640. */
  modelSize?: number
  /**
   * When set, also run the motion pass over these two ROIs and return a
   * `MotionTimeline` (only meaningful with 2 face clusters — the caller decides).
   */
  motionRois?: { left: MotionRoi; right: MotionRoi }
  signal?: AbortSignal
  binPath?: string
  /** Injectable face detector (defaults to real YuNet via onnxruntime-web). */
  detector?: FrameDetector
  /** Injectable ffmpeg runner (defaults to ffmpeg-core.runFfmpeg w/ stdout capture). */
  run?: ReframeRunner
  /**
   * Sub-progress as frames are detected (FEAT-8559h1). The export runner used to
   * emit `progress(0,'analyzing')` once and then nothing until encoding began —
   * an unbounded frozen 0% bar through what is often the slowest phase. The
   * frame budget is knowable (`ceil(duration * sampleFps)`) and this loop
   * already walks frames one at a time, so the bar can just move.
   */
  onFrame?: (framesDone: number, frameBudget: number) => void
}

export interface DetectReframeResult {
  samples: SampleFrame[]
  /** Present only when `motionRois` was supplied. */
  motion?: MotionTimeline
}

/**
 * Orchestrate the two ffmpeg passes into `SampleFrame[]` (+ optional
 * `MotionTimeline`). Frame `idx` is decoded at the squared `modelSize`, handed to
 * the detector, and stamped at ABSOLUTE source time
 * `(startTime + idx/sampleFps) * 1000` ms. The motion pass (when requested) is
 * grouped per `metadata=print` instance (first-seen = left) then folded into a
 * `MotionTimeline`. Pure given injected `run`/`detector`; the real defaults touch
 * ffmpeg + onnxruntime.
 *
 * NOTE (audit note openclip-a29): the `motionRois` Pass 2 here is exercised ONLY by
 * the unit spec — the production `planReframe` never passes `motionRois` (it calls
 * `detectReframe` for FACES only, then runs the standalone `detectMotion` for the
 * split-screen motion timeline). So this is a SECOND copy of the motionArgs → parse →
 * `splitMotionSeries` flow; if you fix the ffmpeg interleaving/length handling, apply
 * it to `detectMotion` (the live path) too, or collapse the two onto one entry point.
 */
export async function detectReframe(opts: DetectReframeOptions): Promise<DetectReframeResult> {
  const sampleFps = opts.sampleFps ?? 2
  const modelSize = opts.modelSize ?? 640
  const dur = opts.endTime - opts.startTime
  if (!(dur > 0)) return { samples: [] }

  const run =
    opts.run ??
    ((a) => defaultRunFfmpegCaptureStdout({ args: a.args, binPath: a.binPath, signal: a.signal }))
  const detector = opts.detector ?? defaultYuNetDetector(opts.source, modelSize)
  // Dispose ONLY a detector we created ourselves (audit fix openclip-y3h): the default
  // YuNet detector lazily opens an onnxruntime-web WASM InferenceSession; without a
  // deterministic release it lived until the closure was GC'd, so each reframed export
  // leaked a fresh WASM session. An INJECTED detector is owned by the caller.
  const ownDetector = !opts.detector
  try {
    // Pass 1 — sample raw frames and detect faces (stream-consumed, audit fix
    // openclip-l41). An INJECTED run (tests) returns a buffered stdout → feed it as a
    // single chunk through the SAME frame-slicer; production streams frames off ffmpeg
    // stdout so memory stays ~1 frame instead of holding the whole decoded clip.
    const sampleArgv = frameSampleArgs(opts.sourcePath, opts.startTime, dur, sampleFps, modelSize)
    const frameBytes = modelSize * modelSize * 3
    // What ffmpeg's `fps=` filter will emit for this span — the denominator the
    // caller needs to turn a frame count into a percentage.
    const frameBudget = Math.max(1, Math.ceil(dur * sampleFps))
    const detectOpts = {
      frameBytes,
      modelSize,
      detector,
      startTime: opts.startTime,
      sampleFps,
      signal: opts.signal,
      onFrame: opts.onFrame ? (done: number) => opts.onFrame!(done, frameBudget) : undefined
    }
    let samples: SampleFrame[]
    if (opts.run) {
      const { stdout } = await opts.run({
        args: sampleArgv,
        binPath: opts.binPath,
        signal: opts.signal
      })
      samples = await detectFromFrameChunks(stdout ? [stdout] : [], detectOpts)
    } else {
      samples = await detectFromFrameChunks(
        streamFfmpegStdout({ args: sampleArgv, binPath: opts.binPath, signal: opts.signal }),
        detectOpts
      )
    }

    if (!opts.motionRois) return { samples }

    // Pass 2 — per-side motion energy.
    const motionArgv = motionArgs(
      opts.sourcePath,
      opts.startTime,
      opts.endTime,
      opts.motionRois.left,
      opts.motionRois.right
    )
    const { stderr } = await run({ args: motionArgv, binPath: opts.binPath, signal: opts.signal })
    const groups = parseMotionMetadata(stderr)
    const motion = splitMotionSeries(groups, opts.startTime)
    return { samples, motion }
  } finally {
    if (ownDetector) await (detector as { dispose?: () => Promise<void> }).dispose?.()
  }
}

/**
 * Fold the per-instance motion groups (from `parseMotionMetadata`) into one
 * `MotionTimeline`.
 *
 * LOAD-BEARING INVARIANT: `motionArgs` maps `[lm]` (the LEFT ROI) FIRST, then
 * `[rm]` (right). With one decode feeding both sinks, ffmpeg's print INTERLEAVES
 * per frame but the LEFT sink prints first on each frame, so the FIRST-SEEN
 * `[Parsed_metadata_N @ …]` instance is always LEFT and the second is RIGHT.
 * `parseMotionMetadata` preserves that first-seen order, so `groups[0]` = left,
 * `groups[1]` = right. (Do NOT reorder by instance N — N is assigned by filter
 * position, not guaranteed ascending across ffmpeg versions; first-seen order is.)
 *
 * The shared timeline is the left group's times offset to ABSOLUTE source seconds
 * by `startTime`. A single-ROI print (one group) mirrors that series onto both
 * sides. When the two groups are uneven we clamp to the shorter (and to the
 * timeline length) so the parallel arrays stay aligned.
 */
export function splitMotionSeries(groups: MotionSeries[], startTime: number): MotionTimeline {
  if (groups.length === 0) return { times: [], left: [], right: [] }
  const leftG = groups[0]
  const rightG = groups[1] ?? groups[0] // single ROI ⇒ mirror onto both sides
  // Make the silent clamp visible (audit fix openclip-36u): the two sinks share one
  // decode and should be symmetric, so a per-side count mismatch (degenerate ROI, odd
  // VFR boundary, one sink emitting a different frame count) means we're clamping to the
  // shorter and the tail of the longer side is dropped — a misalignment risk worth a log
  // rather than a quietly wrong active-speaker timeline. Only meaningful with two groups.
  if (groups.length >= 2 && leftG.values.length !== rightG.values.length) {
    console.warn(
      `[reframe] motion series length mismatch (left=${leftG.values.length}, right=${rightG.values.length}); clamping to the shorter — speaker timeline tail may be truncated`
    )
  }
  const n = Math.min(leftG.values.length, rightG.values.length, leftG.times.length)
  const times: number[] = []
  const left: number[] = []
  const right: number[] = []
  for (let i = 0; i < n; i++) {
    times.push(leftG.times[i] + startTime)
    left.push(leftG.values[i])
    right.push(rightG.values[i])
  }
  return { times, left, right }
}

// ============================================================================
// Default (real) runner + YuNet session glue — never exercised by the unit spec
// (a Phase-3 serial test drives the real onnxruntime + ffmpeg).
// ============================================================================

/**
 * Default ffmpeg runner that captures stdout (the raw-frame pipe) AND stderr.
 * `ffmpeg-core.runFfmpeg` ignores stdout, so the frame-sampling pass needs its
 * own spawn; we lazy-`require` `child_process` to keep this module importable in
 * pure tests (the spec injects `run`, so this path never executes there).
 */
async function defaultRunFfmpegCaptureStdout(opts: {
  args: string[]
  binPath?: string
  signal?: AbortSignal
}): Promise<{ stdout?: Buffer; stderr: string }> {
  // The frame-sampling pass writes raw video to stdout, which the trunk
  // `runFfmpeg` discards; spawn directly so we can collect it. Motion-only callers
  // (no stdout) still work — stdout is simply empty.
  const bin = opts.binPath ?? ffmpegPath()
  return new Promise((resolve, reject) => {
    const child = spawn(bin, opts.args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let stderr = ''
    const onAbort = (): void => {
      child.kill('SIGKILL')
    }
    if (opts.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }
    child.stdout?.on('data', (b: Buffer) => out.push(b))
    child.stderr?.on('data', (b: Buffer) => {
      stderr += b.toString()
    })
    child.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      if (opts.signal?.aborted) {
        reject(new Error('ffmpeg aborted'))
        return
      }
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr })
      else reject(new Error(`ffmpeg exited with code ${code}\n${stderr.slice(-2000)}`))
    })
  })
}

/**
 * Slice a stream of raw-video byte chunks into fixed `frameBytes` frames, run the YuNet
 * `detector` on each, and return one `SampleFrame` per frame (audit fix openclip-l41).
 * Holds only a rolling carry buffer (≤ one partial frame) + the current chunk, so memory
 * is ~1 frame regardless of clip length — instead of buffering the WHOLE decoded stream
 * (~221 MB for a 90s clip) before the first inference. The carry remainder is COPIED out
 * (`Buffer.from`) so consumed chunks are freed, not kept alive by a subarray view. Pure
 * (no spawn) so it is unit-tested with canned chunks, including frames that straddle a
 * chunk boundary (the streaming case).
 */
export async function detectFromFrameChunks(
  chunks: AsyncIterable<Buffer> | Iterable<Buffer>,
  opts: {
    frameBytes: number
    modelSize: number
    detector: FrameDetector
    startTime: number
    sampleFps: number
    signal?: AbortSignal
    /** Called after each detected frame, so a caller can report sub-progress. */
    onFrame?: (framesDone: number) => void
  }
): Promise<SampleFrame[]> {
  const samples: SampleFrame[] = []
  let frameIndex = 0
  let carry: Buffer = Buffer.alloc(0)
  for await (const chunk of chunks as AsyncIterable<Buffer>) {
    if (opts.signal?.aborted) throw new Error('reframe detection aborted')
    carry = carry.length === 0 ? chunk : Buffer.concat([carry, chunk])
    let offset = 0
    while (carry.length - offset >= opts.frameBytes) {
      const frame = carry.subarray(offset, offset + opts.frameBytes)
      const faces = await opts.detector(frame, opts.modelSize, opts.modelSize)
      samples.push({ timeMs: (opts.startTime + frameIndex / opts.sampleFps) * 1000, faces })
      frameIndex += 1
      offset += opts.frameBytes
      opts.onFrame?.(frameIndex)
    }
    // Keep only the partial-frame remainder, COPIED so the big chunk can be GC'd.
    carry = offset > 0 ? Buffer.from(carry.subarray(offset)) : carry
  }
  return samples
}

/**
 * Spawn ffmpeg and yield its stdout (the raw-frame pipe) as chunks ARRIVE, instead of
 * accumulating the whole stream (audit fix openclip-l41). Paired with
 * `detectFromFrameChunks` so decode overlaps inference and memory stays ~1 frame. stderr
 * is captured for the error tail; rejects on a non-zero exit / spawn error / abort. The
 * unit spec injects `run` (the buffered path), so this streaming spawn is exercised only
 * by the @serial reframe smoke.
 */
async function* streamFfmpegStdout(opts: {
  args: string[]
  binPath?: string
  signal?: AbortSignal
}): AsyncGenerator<Buffer> {
  const bin = opts.binPath ?? ffmpegPath()
  const child = spawn(bin, opts.args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr?.on('data', (b: Buffer) => {
    stderr += b.toString()
  })
  const onAbort = (): void => {
    child.kill('SIGKILL')
  }
  if (opts.signal) {
    if (opts.signal.aborted) onAbort()
    else opts.signal.addEventListener('abort', onAbort, { once: true })
  }
  const exit = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => resolve(code))
  })
  // Mark `exit` observed so a spawn-failure rejection can't surface as an UNHANDLED
  // rejection (review follow-up to openclip-l41): if `child.stdout` errors, the for-await
  // below throws and propagates out before `await exit` is reached, leaving the original
  // promise's rejection unawaited. `await exit` (happy path only) is unaffected.
  void exit.catch(() => {})
  try {
    if (child.stdout) {
      for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
        yield chunk
      }
    }
    const code = await exit
    if (opts.signal?.aborted) throw new Error('ffmpeg aborted')
    if (code !== 0) throw new Error(`ffmpeg exited with code ${code}\n${stderr.slice(-2000)}`)
  } finally {
    opts.signal?.removeEventListener('abort', onAbort)
    // Tear the child down on ANY early exit — not just abort (review follow-up to
    // openclip-l41): if the consumer (detectFromFrameChunks → YuNet) throws mid-stream, the
    // generator's return() runs this finally; without a kill the ffmpeg child is orphaned
    // (the reframe spawns aren't PID-tracked). kill() on an already-exited child is a no-op.
    if (!child.killed) child.kill('SIGKILL')
  }
}

/**
 * Build the real (async) YuNet detector backed by a single lazily-created
 * `onnxruntime-web` InferenceSession (WASM, single-thread, `wasmPaths` =
 * `reframeWasmDir()`). The session is created on the first frame and reused for
 * the rest of the pass. Each call preprocesses one 640x640x3 RGB frame into NCHW
 * [1,3,640,640] float32 (plain `/255` normalize), runs the model, and
 * `decodeYuNet`s the 12 outputs back to SOURCE px. The unit spec injects a
 * synchronous `detector`, so this path never runs there; a Phase-3 serial test
 * exercises the real session.
 */
function defaultYuNetDetector(
  source: { width: number; height: number },
  modelSize: number
): FrameDetector {
  let sessionP: Promise<InferenceSession> | null = null
  let ortMod: typeof OrtModule | null = null

  const ensureSession = (): Promise<InferenceSession> => {
    if (!ortMod) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      ortMod = require('onnxruntime-web') as typeof OrtModule
      ortMod.env.wasm.wasmPaths = reframeWasmDir() + '/'
      ortMod.env.wasm.numThreads = 1
    }
    if (!sessionP) sessionP = ortMod.InferenceSession.create(reframeModelPath())
    return sessionP
  }

  const detect = async (rgb: Uint8Array | Buffer): Promise<FaceBox[]> => {
    const session = await ensureSession()
    const ort = ortMod as typeof OrtModule

    // HWC RGB uint8 → CHW float32 [1,3,H,W], /255 normalized.
    const plane = modelSize * modelSize
    const chw = new Float32Array(3 * plane)
    for (let p = 0; p < plane; p++) {
      chw[p] = rgb[p * 3] / 255 // R
      chw[plane + p] = rgb[p * 3 + 1] / 255 // G
      chw[2 * plane + p] = rgb[p * 3 + 2] / 255 // B
    }
    const input = new ort.Tensor('float32', chw, [1, 3, modelSize, modelSize])
    const out = await session.run({ input })
    const f = (name: string): Float32Array => out[name].data as Float32Array
    return decodeYuNet(
      {
        cls_8: f('cls_8'),
        cls_16: f('cls_16'),
        cls_32: f('cls_32'),
        obj_8: f('obj_8'),
        obj_16: f('obj_16'),
        obj_32: f('obj_32'),
        bbox_8: f('bbox_8'),
        bbox_16: f('bbox_16'),
        bbox_32: f('bbox_32')
      },
      { source, modelSize }
    )
  }
  // Deterministic teardown of the lazily-created WASM session (audit fix openclip-y3h):
  // detectReframe calls this in a `finally` so the session memory is freed at the end
  // of a detection pass rather than waiting for GC of this closure.
  ;(detect as FrameDetector & { dispose?: () => Promise<void> }).dispose = async () => {
    const s = await sessionP?.catch(() => null)
    sessionP = null
    await s?.release?.()
  }
  return detect
}

/**
 * Load the bundled YuNet model through the REAL runtime path
 * (`require('onnxruntime-web')` + `wasmPaths = reframeWasmDir()`) and run ONE dummy
 * `[1,3,modelSize,modelSize]` inference, returning the output tensor names. THROWS
 * on any failure. Used by the Gate-D `diag:reframe-probe` IPC to prove the PACKAGED
 * main process can load + run the model from `<Resources>/onnx` (the asar-resolved
 * JS entry + the unpacked wasm) — the real reframe runtime, not just an asset stat.
 */
export async function probeReframeModel(modelSize = 640): Promise<{ outputNames: string[] }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ort = require('onnxruntime-web') as typeof OrtModule
  ort.env.wasm.wasmPaths = reframeWasmDir() + '/'
  ort.env.wasm.numThreads = 1
  const session = await ort.InferenceSession.create(reframeModelPath())
  const data = new Float32Array(3 * modelSize * modelSize)
  const tensor = new ort.Tensor('float32', data, [1, 3, modelSize, modelSize])
  const out = await session.run({ [session.inputNames[0]]: tensor })
  return { outputNames: Object.keys(out) }
}

// ============================================================================
// Orchestrator: detect → cluster → (optional motion) → ReframePlan (Part J)
// ============================================================================

export interface DetectMotionOptions {
  sourcePath: string
  startTime: number
  endTime: number
  left: MotionRoi
  right: MotionRoi
  signal?: AbortSignal
  binPath?: string
  run?: ReframeRunner
}

/** Run ONLY the per-side motion pass → a `MotionTimeline` (absolute source times). */
export async function detectMotion(opts: DetectMotionOptions): Promise<MotionTimeline> {
  const run =
    opts.run ??
    ((a) => defaultRunFfmpegCaptureStdout({ args: a.args, binPath: a.binPath, signal: a.signal }))
  const argv = motionArgs(opts.sourcePath, opts.startTime, opts.endTime, opts.left, opts.right)
  const { stderr } = await run({ args: argv, binPath: opts.binPath, signal: opts.signal })
  return splitMotionSeries(parseMotionMetadata(stderr), opts.startTime)
}

/** A `MotionRoi` from a planner `CropRegion` (clusterTileRegion output). */
function roiOf(r: { cropX: number; cropY: number; cropW: number; cropH: number }): MotionRoi {
  return { x: r.cropX, y: r.cropY, w: r.cropW, h: r.cropH }
}

/**
 * Clip two split-render tiles into MUTUALLY-EXCLUSIVE motion ROIs (audit fix
 * openclip-sx0). The split tiles are 2.8x face-width and overlap when the two speakers
 * are only ~15% of the width apart, so each side's motion energy would contain the
 * OTHER speaker and the active-speaker comparison gets contaminated. Partition at the
 * midpoint between the two cluster centers: trim the left tile's right edge and the
 * right tile's left edge to that boundary, so `left.x + left.w <= right.x`. The tiles'
 * vertical extent is unchanged; only the horizontal overlap is removed. (The wide tiles
 * are still used for the split-screen RENDER — this only tightens the motion ROIs.)
 */
export function trimMotionRois(
  tileA: MotionRoi,
  tileB: MotionRoi,
  centerA: number,
  centerB: number
): { left: MotionRoi; right: MotionRoi } {
  // Order by center so 'left' is genuinely the smaller-x speaker.
  let lt = tileA
  let rt = tileB
  if (centerA > centerB) {
    lt = tileB
    rt = tileA
  }
  const boundary = Math.round((Math.min(centerA, centerB) + Math.max(centerA, centerB)) / 2)
  const lRight = Math.min(lt.x + lt.w, boundary)
  const rLeft = Math.max(rt.x, boundary)
  return {
    left: { x: lt.x, y: lt.y, w: Math.max(1, lRight - lt.x), h: lt.h },
    right: { x: rLeft, y: rt.y, w: Math.max(1, rt.x + rt.w - rLeft), h: rt.h }
  }
}

export interface PlanReframeOptions {
  sourcePath: string
  startTime: number
  endTime: number
  source: { width: number; height: number }
  aspect: AspectRatio
  mode: 'auto' | 'split'
  sampleFps?: number
  signal?: AbortSignal
  binPath?: string
  /** Injectable passes (default the real ffmpeg+YuNet) — the unit test fakes these. */
  detect?: typeof detectReframe
  motion?: typeof detectMotion
  /** Face-sampling sub-progress, so 'analyzing' is not a frozen 0% (FEAT-8559h1). */
  onFrame?: (framesDone: number, frameBudget: number) => void
}

/**
 * Full reframe analysis for a clip span → a `ReframePlan` (or `null` ⇒ center-crop).
 * Samples faces (pass 1); if there are two speaker clusters AND `mode==='auto'`,
 * runs the per-side motion pass (pass 2) so the planner can build an active-speaker
 * pan; otherwise the planner decides static/pan/split from faces alone. A motion
 * failure degrades to static-on-dominant (never throws here). Pure given injected
 * `detect`/`motion`; the real defaults touch ffmpeg + onnxruntime.
 */
export async function planReframe(opts: PlanReframeOptions): Promise<ReframePlan | null> {
  const detect = opts.detect ?? detectReframe
  const motionFn = opts.motion ?? detectMotion
  const { samples } = await detect({
    sourcePath: opts.sourcePath,
    startTime: opts.startTime,
    endTime: opts.endTime,
    source: opts.source,
    sampleFps: opts.sampleFps,
    signal: opts.signal,
    binPath: opts.binPath,
    onFrame: opts.onFrame
  })
  const filtered = filterFaceOutliers(samples, opts.source)
  if (filtered.length === 0) return null

  let motion: MotionTimeline | undefined
  const clusters = clusterTwoFaceRegions(filtered, opts.source)
  if (opts.mode === 'auto' && clusters) {
    try {
      // Tighten the wide split tiles into non-overlapping motion ROIs (openclip-sx0) so
      // each side's motion energy contains only its own speaker.
      const rois = trimMotionRois(
        roiOf(clusterTileRegion(clusters[0], opts.source)),
        roiOf(clusterTileRegion(clusters[1], opts.source)),
        clusters[0].centerX,
        clusters[1].centerX
      )
      motion = await motionFn({
        sourcePath: opts.sourcePath,
        startTime: opts.startTime,
        endTime: opts.endTime,
        left: rois.left,
        right: rois.right,
        signal: opts.signal,
        binPath: opts.binPath
      })
    } catch {
      motion = undefined // motion pass failed → planner falls back to static-on-dominant
    }
  }

  // CLIP-RELATIVE rebase (Part J review fix): ffmpeg feeds `crop`'s `t` the
  // `-ss`-rebased 0-based PTS, NOT the absolute source time. detectReframe stamps
  // sample/motion times absolute (startTime-offset), so we subtract startTime here
  // → the pan `xExpr` is authored in clip-relative time and lines up with the cut.
  const rebasedSamples = samples.map((s) => ({ ...s, timeMs: s.timeMs - opts.startTime * 1000 }))
  const rebasedMotion: MotionTimeline | undefined = motion
    ? { ...motion, times: motion.times.map((t) => t - opts.startTime) }
    : undefined

  return buildReframePlan({
    samples: rebasedSamples,
    motion: rebasedMotion,
    source: opts.source,
    aspect: opts.aspect,
    mode: opts.mode
  })
}
