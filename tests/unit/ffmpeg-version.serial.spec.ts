/**
 * tests/unit/ffmpeg-version.serial.spec.ts — @serial build assertion (openclip-592).
 *
 * The cut/encode half (ffmpeg) and the probe half (ffprobe) historically came from two
 * separately-versioned npm packages (ffmpeg-static@b6.1.1 actually shipping 6.0, vs
 * ffmpeg-ffprobe-static@6.1.1). They interoperate within 6.x, but a MAJOR version drift
 * between the two halves would be a real incompatibility. This smoke runs the resolved
 * binaries and asserts they report the same MAJOR version, so a future bump that pulls
 * them onto different majors fails loudly. Self-skips when the binaries are absent (like
 * the other @serial real-binary smokes), so a bare checkout / CI stays green.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { resolveFfmpeg, ffmpegAvailable } from '../harness/fixtures'

const HAVE_FFMPEG = ffmpegAvailable()

function ffprobeBin(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require('ffmpeg-ffprobe-static') as { ffprobePath?: string }
    if (m.ffprobePath && existsSync(m.ffprobePath)) return m.ffprobePath
  } catch {
    /* fall through */
  }
  return 'ffprobe'
}

/** Parse `…version n6.1.1…` / `…version 6.0…` → [major, minor]. */
function versionOf(bin: string): [number, number] {
  const out = execFileSync(bin, ['-version'], { encoding: 'utf8' })
  const m = /version\s+n?(\d+)\.(\d+)/i.exec(out)
  if (!m) throw new Error(`could not parse a version from: ${out.split('\n')[0]}`)
  return [Number(m[1]), Number(m[2])]
}

describe.skipIf(!HAVE_FFMPEG)('@serial ffmpeg/ffprobe version parity (openclip-592)', () => {
  it('ffmpeg and ffprobe report the same MAJOR version', () => {
    const [ffMajor, ffMinor] = versionOf(resolveFfmpeg())
    const [fpMajor, fpMinor] = versionOf(ffprobeBin())
    // Surface the exact versions on failure for fast triage.
    expect(
      ffMajor,
      `ffmpeg ${ffMajor}.${ffMinor} vs ffprobe ${fpMajor}.${fpMinor} — major drift`
    ).toBe(fpMajor)
  })
})
