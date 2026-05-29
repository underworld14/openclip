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
    sourcePath,
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

/** One parsed motion sample: a frame time (s, 0-based to the seek) + its energy. */
export interface MotionSeries {
  times: number[]
  values: number[]
}

/**
 * Build the motion-energy argv (2-speaker active-speaker detection). For each ROI
 * we crop, drop to gray, `tblend=all_mode=difference` (frame-to-frame delta), run
 * `signalstats`, and `metadata=print` the per-frame average luma of that delta
 * (`lavfi.signalstats.YAVG`) — higher delta ≈ more motion (a talking speaker).
 * Both ROI chains are `-map`'d to their own `-f null -` sink so ffmpeg emits both
 * series interleaved on stderr metadata; `parseMotionMetadata` separates them by
 * order via the print lines.
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
    sourcePath,
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
 * Parse the `metadata=print` stderr into a {times,values} series. ffmpeg prints,
 * per frame, a `frame:<n> pts_time:<t>` line followed by
 * `lavfi.signalstats.YAVG=<v>`; we pair each YAVG with the most-recent pts_time.
 * Pure — matches `motionArgs` output. (When two sinks interleave, the caller
 * derives left/right by splitting the combined series; for a single ROI this is
 * the raw series.)
 */
export function parseMotionMetadata(stderr: string): MotionSeries {
  const times: number[] = []
  const values: number[] = []
  let lastTime: number | null = null
  for (const line of stderr.split('\n')) {
    const mt = /pts_time:\s*(-?[\d.]+)/.exec(line)
    if (mt) {
      lastTime = parseFloat(mt[1])
      continue
    }
    const mv = /lavfi\.signalstats\.YAVG\s*[:=]\s*(-?[\d.]+)/.exec(line)
    if (mv && lastTime !== null) {
      times.push(lastTime)
      values.push(parseFloat(mv[1]))
    }
  }
  return { times, values }
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
 * split into left/right series by interleave order. Pure given injected
 * `run`/`detector`; the real defaults touch ffmpeg + onnxruntime.
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

  // Pass 1 — sample raw frames and detect faces.
  const sampleArgv = frameSampleArgs(opts.sourcePath, opts.startTime, dur, sampleFps, modelSize)
  const { stdout } = await run({ args: sampleArgv, binPath: opts.binPath, signal: opts.signal })
  const frameBytes = modelSize * modelSize * 3
  const buf = stdout ?? Buffer.alloc(0)
  const frameCount = Math.floor(buf.length / frameBytes)
  const samples: SampleFrame[] = []
  for (let i = 0; i < frameCount; i++) {
    if (opts.signal?.aborted) throw new Error('reframe detection aborted')
    const frame = buf.subarray(i * frameBytes, (i + 1) * frameBytes)
    const faces = await detector(frame, modelSize, modelSize)
    samples.push({
      timeMs: (opts.startTime + i / sampleFps) * 1000,
      faces
    })
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
  const series = parseMotionMetadata(stderr)
  const motion = splitMotionSeries(series, opts.startTime)
  return { samples, motion }
}

/**
 * Split the combined motion print (two interleaved sinks) into a `MotionTimeline`.
 * ffmpeg processes `-map [lm] -f null -` then `-map [rm] -f null -` in order, so
 * the print emits the FULL left series followed by the FULL right series. We split
 * the flat {times,values} in half, take the left half's times as the timeline
 * (offset to absolute source seconds by `startTime`), and pair the two value
 * halves as `left`/`right`. When the halves are uneven we clamp to the shorter.
 */
export function splitMotionSeries(series: MotionSeries, startTime: number): MotionTimeline {
  const total = series.values.length
  const half = Math.floor(total / 2)
  const n = Math.min(half, total - half)
  const times: number[] = []
  const left: number[] = []
  const right: number[] = []
  for (let i = 0; i < n; i++) {
    times.push(series.times[i] + startTime)
    left.push(series.values[i])
    right.push(series.values[half + i])
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

  return async (rgb: Uint8Array | Buffer): Promise<FaceBox[]> => {
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
    binPath: opts.binPath
  })
  const filtered = filterFaceOutliers(samples, opts.source)
  if (filtered.length === 0) return null

  let motion: MotionTimeline | undefined
  const clusters = clusterTwoFaceRegions(filtered, opts.source)
  if (opts.mode === 'auto' && clusters) {
    try {
      motion = await motionFn({
        sourcePath: opts.sourcePath,
        startTime: opts.startTime,
        endTime: opts.endTime,
        left: roiOf(clusterTileRegion(clusters[0], opts.source)),
        right: roiOf(clusterTileRegion(clusters[1], opts.source)),
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
