/**
 * tests/unit/ffmpeg-core-spawn.spec.ts — behavioral coverage for the `runFfmpeg`
 * spawn/abort/exit wrapper (audit fix openclip-qoc). The PURE progress parser is
 * covered by ffmpeg-core's own parser tests; here we drive the actual child-process
 * shell using `node` itself as a stand-in "ffmpeg binary" (via `binPath`), so we can
 * assert: clean exit resolves, a non-zero exit rejects with the stderr tail, an
 * AbortSignal SIGKILLs the child and rejects with `ffmpeg aborted`, a missing binary
 * rejects, and progress is streamed — including a `-progress` line split ACROSS two
 * stderr chunks, which previously dropped the sample (audit fix openclip-2p4).
 */

import { describe, expect, it } from 'vitest'
import { runFfmpeg } from '@main/services/ffmpeg-core'

const NODE = process.execPath
/** Run a tiny node program as the "ffmpeg" child. */
const nodeArgs = (src: string): string[] => ['-e', src]

describe('runFfmpeg: exit handling (audit fix openclip-qoc)', () => {
  it('resolves with code 0 on a clean exit', async () => {
    const res = await runFfmpeg({ binPath: NODE, args: nodeArgs('process.exit(0)') })
    expect(res.code).toBe(0)
  })

  it('rejects on a non-zero exit, surfacing the stderr tail', async () => {
    await expect(
      runFfmpeg({
        binPath: NODE,
        args: nodeArgs('process.stderr.write("boom-detail\\n"); process.exit(2)')
      })
    ).rejects.toThrow(/code 2[\s\S]*boom-detail/)
  })

  it('rejects when the binary cannot be spawned', async () => {
    await expect(
      runFfmpeg({ binPath: '/no/such/ffmpeg-binary-xyz', args: [] })
    ).rejects.toBeTruthy()
  })
})

describe('runFfmpeg: cooperative cancel via AbortSignal (audit fix openclip-qoc)', () => {
  it('SIGKILLs the child and rejects with "ffmpeg aborted" when the signal fires', async () => {
    const ac = new AbortController()
    // A child that would otherwise run for 10s; abort shortly after spawn.
    const p = runFfmpeg({
      binPath: NODE,
      args: nodeArgs('setTimeout(() => {}, 10000)'),
      signal: ac.signal
    })
    setTimeout(() => ac.abort(), 80)
    await expect(p).rejects.toThrow(/aborted/)
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(
      runFfmpeg({ binPath: NODE, args: nodeArgs('setTimeout(() => {}, 10000)'), signal: ac.signal })
    ).rejects.toThrow(/aborted/)
  })
})

describe('runFfmpeg: progress streaming', () => {
  it('parses out_time into a pct against the total duration', async () => {
    const pcts: number[] = []
    await runFfmpeg({
      binPath: NODE,
      args: nodeArgs(
        'process.stderr.write("out_time_us=500000\\n"); setTimeout(()=>process.exit(0), 20)'
      ),
      totalDurationSec: 1,
      onProgress: (pct) => {
        if (pct !== undefined) pcts.push(pct)
      }
    })
    expect(pcts).toContain(50) // 0.5s of 1s
  })

  it('reconstructs a -progress line split across two stderr chunks (audit fix openclip-2p4)', async () => {
    const pcts: number[] = []
    // Write `out_time_us=50000`, then 60ms later `0\n` (completing the SAME line →
    // out_time_us=500000 → 50%), then `progress=end\n`. With the line buffer the
    // value reassembles to 50%; WITHOUT it the first chunk parses `out_time_us=50000`
    // → a WRONG 5% and the real 500000 sample is lost.
    await runFfmpeg({
      binPath: NODE,
      args: nodeArgs(
        "process.stderr.write('out_time_us=50000');" +
          'setTimeout(() => {' +
          "  process.stderr.write('0\\n');" +
          "  setTimeout(() => { process.stderr.write('progress=end\\n'); process.exit(0); }, 20);" +
          '}, 60);'
      ),
      totalDurationSec: 1,
      onProgress: (pct) => {
        if (pct !== undefined && pct < 100) pcts.push(pct)
      }
    })
    expect(pcts).toContain(50)
    expect(pcts).not.toContain(5)
  })
})
