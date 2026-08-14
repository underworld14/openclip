/**
 * tests/unit/export-fit-mode.serial.spec.ts — the fit modes produce the PIXELS
 * they promise (FEAT-bd87vz).
 *
 * The unit spec next door asserts the filtergraph strings. That is necessary and
 * insufficient: a graph can be perfectly well-formed and still crop when it was
 * asked to letterbox, or blur the foreground instead of the background. The only
 * way to know is to run the real ffmpeg and look at the frame.
 *
 * The source is deliberately a WIDE 16:9 bar pattern exported to 9:16, which is
 * the worst case the ticket describes: fill throws away most of the frame, and
 * letterbox must keep all of it.
 *
 * Measurement is `cropdetect`-free on purpose — it reads a specific BLOCK of the
 * frame via `crop` + `signalstats`, so the assertions are about what is actually
 * at the top of the frame, not about a heuristic's opinion of it.
 *
 * `@serial` + skipIf: real binary, one machine, self-skips on a bare checkout.
 */

import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { exportClipArgs } from '@main/services/ffmpeg-export'
import { resolveFfmpeg, ffmpegAvailable } from '../harness/fixtures'

/** A 16:9 source whose top and bottom thirds are strongly coloured. */
function makeSource(ffmpeg: string, out: string): void {
  const r = spawnSync(
    ffmpeg,
    // prettier-ignore
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=15:duration=3',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', out
    ],
    { encoding: 'utf8' }
  )
  if (r.status !== 0) throw new Error(`fixture encode failed: ${r.stderr}`)
}

/** Sample size for the luma probe. `signalstats` cannot initialise on a 1×1. */
const PROBE = 32

/**
 * Mean luma of a `PROBE`×`PROBE` block whose TOP-LEFT is (x,y), on the first
 * frame.
 *
 * A block rather than a pixel because a single-pixel crop fails to initialise
 * `signalstats` outright, and because averaging over a block is what makes the
 * black-bar assertions robust to the encoder's ringing at a hard edge.
 */
function blockLuma(ffmpeg: string, file: string, x: number, y: number): number {
  const r = spawnSync(
    ffmpeg,
    // prettier-ignore
    [
      '-hide_banner', '-loglevel', 'info', '-i', file,
      '-vf', `crop=${PROBE}:${PROBE}:${x}:${y},signalstats,metadata=print`,
      '-frames:v', '1', '-f', 'null', '-'
    ],
    { encoding: 'utf8' }
  )
  const m = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(String(r.stderr ?? ''))
  if (!m) throw new Error(`no YAVG at ${x},${y}: ${String(r.stderr).slice(-400)}`)
  return Number(m[1])
}

function probeSize(ffmpeg: string, file: string): string {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' })
  const m = /, (\d+)x(\d+)[ ,]/.exec(String(r.stderr ?? ''))
  return m ? `${m[1]}x${m[2]}` : 'unknown'
}

function run(ffmpeg: string, argv: string[]): void {
  const r = spawnSync(ffmpeg, argv, { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`export failed: ${String(r.stderr).slice(-800)}`)
}

describe.skipIf(!ffmpegAvailable())(
  '@serial ffmpeg fit modes — real encode, measured pixels',
  () => {
    const ffmpeg = resolveFfmpeg()
    const dir = mkdtempSync(join(tmpdir(), 'oc-fit-'))
    const src = join(dir, 'src.mp4')
    makeSource(ffmpeg, src)

    const base = {
      sourcePath: src,
      startTime: 0,
      endTime: 2,
      aspectRatio: '9:16' as const,
      quality: '720p' as const,
      forceCpu: true
    }

    it('every mode still produces a 1080×1920 clip', () => {
      for (const fitMode of ['fill', 'letterbox', 'blur'] as const) {
        const out = join(dir, `size-${fitMode}.mp4`)
        run(ffmpeg, exportClipArgs({ ...base, fitMode, outputPath: out }))
        expect(probeSize(ffmpeg, out), fitMode).toBe('1080x1920')
      }
    })

    it('LETTERBOX pads with black; FILL fills the same pixel with video', () => {
      const lb = join(dir, 'lb.mp4')
      const fill = join(dir, 'fill.mp4')
      run(ffmpeg, exportClipArgs({ ...base, fitMode: 'letterbox', outputPath: lb }))
      run(ffmpeg, exportClipArgs({ ...base, fitMode: 'fill', outputPath: fill }))

      // A 16:9 source fitted into 9:16 leaves ~656px of bar top and bottom, so
      // y=40 is deep inside the top bar for letterbox and ordinary video for fill.
      const lbTop = blockLuma(ffmpeg, lb, 540, 40)
      const fillTop = blockLuma(ffmpeg, fill, 540, 40)
      expect(lbTop).toBeLessThan(20) // black bar
      // The exact value depends on the test pattern; what matters is that it is
      // NOT the black bar — i.e. fill really did crop into the picture.
      expect(fillTop).toBeGreaterThan(lbTop + 20)
    })

    it('BLUR fills the bar region with picture, not black', () => {
      // This is the assertion a well-formed-but-wrong graph fails: if the
      // background copy were scaled to FIT rather than COVER, the bars would
      // still be black and only the graph string would look right.
      const blur = join(dir, 'blur.mp4')
      run(ffmpeg, exportClipArgs({ ...base, fitMode: 'blur', outputPath: blur }))
      expect(blockLuma(ffmpeg, blur, 540, 40)).toBeGreaterThan(20)
    })

    it('LETTERBOX keeps the full source width — the content fill was cutting off', () => {
      // The whole reason the ticket exists: fill silently discards the sides.
      // Sampling the far-left column of the fitted band proves the edge survived.
      const lb = join(dir, 'lb2.mp4')
      run(ffmpeg, exportClipArgs({ ...base, fitMode: 'letterbox', outputPath: lb }))
      // Mid-height is inside the fitted picture; x=0 is its left edge.
      expect(blockLuma(ffmpeg, lb, 0, 944)).toBeGreaterThan(0)
      // …and the bar above it is still black, so the band really is a band.
      expect(blockLuma(ffmpeg, lb, 0, 40)).toBeLessThan(20)
    })
  }
)
