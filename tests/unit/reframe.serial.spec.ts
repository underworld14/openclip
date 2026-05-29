/**
 * tests/unit/reframe.serial.spec.ts — @serial real-pipeline proof for auto-reframe
 * (Part J): runs the REAL ffmpeg frame-sampler + the REAL YuNet model via
 * `onnxruntime-web` (WASM backend) over a synthetic fixture, fully OFFLINE. This
 * proves the frame → tensor → `decodeYuNet` plumbing integrates against the
 * bundled model + wasm (the de-risk + verify-package already prove the model
 * loads; this proves the END-TO-END wiring). `testsrc2` has no faces, so
 * detections are empty — face-detection ACCURACY is validated manually
 * (`npm run dev`). Skips gracefully when ffmpeg or the bundled assets are absent.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ensureFixtures, ffmpegAvailable, resolveFfmpeg } from '../harness/fixtures'
import { detectReframe } from '@main/services/reframe-detect'
import { REFRAME_MODEL_FILE } from '@main/utils/paths'

const ONNX_DIR = join(process.cwd(), 'build', 'onnx')
const HAVE =
  ffmpegAvailable() &&
  existsSync(join(ONNX_DIR, REFRAME_MODEL_FILE)) &&
  existsSync(join(ONNX_DIR, 'ort-wasm-simd-threaded.wasm'))

describe.skipIf(!HAVE)('@serial reframe — real ffmpeg + real YuNet (WASM) end-to-end', () => {
  let prev: string | undefined
  beforeAll(() => {
    prev = process.env.OPENCLIP_ONNX_DIR
    process.env.OPENCLIP_ONNX_DIR = ONNX_DIR // resolve model + wasm from the dev dir
  })
  afterAll(() => {
    if (prev === undefined) delete process.env.OPENCLIP_ONNX_DIR
    else process.env.OPENCLIP_ONNX_DIR = prev
  })

  it('samples frames + runs YuNet, returning a FaceBox[] per sampled frame', async () => {
    const { videoMp4 } = ensureFixtures() // 1280x720 25fps 4s testsrc2 (no faces)
    const { samples } = await detectReframe({
      sourcePath: videoMp4,
      startTime: 0,
      endTime: 2,
      source: { width: 1280, height: 720 },
      sampleFps: 2,
      binPath: resolveFfmpeg()
    })
    // ~2 fps over 2s → ≥3 sampled frames, each carrying a decoded (possibly empty) FaceBox[].
    expect(samples.length).toBeGreaterThanOrEqual(3)
    for (const s of samples) {
      expect(Array.isArray(s.faces)).toBe(true)
      for (const f of s.faces) {
        expect(f.w).toBeGreaterThan(0)
        expect(f.h).toBeGreaterThan(0)
        expect(f.confidence).toBeGreaterThanOrEqual(0)
      }
    }
  }, 30_000)
})
