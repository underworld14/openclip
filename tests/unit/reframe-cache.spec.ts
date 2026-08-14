/**
 * tests/unit/reframe-cache.spec.ts — the reframe plan is computed once
 * (FEAT-rmh08k).
 *
 * `docs/auto-reframe-design.md:50` asked for this cache and nothing implemented
 * it, so every export of the same clip at the same bounds re-ran the ENTIRE face
 * pipeline: a 2 fps ffmpeg decode, YuNet on every sampled frame, and a second
 * `tblend` motion pass. Re-exporting after nudging a caption colour paid all of
 * it again, and face analysis is the slowest phase of an export.
 *
 * Three properties, in order of how badly getting them wrong would hurt:
 *
 *  1. The KEY covers every input that changes the plan. A cache keyed on less
 *     than its inputs is worse than no cache — it returns a confidently wrong
 *     crop instead of a slow right one. (The openclip-d2s lesson, applied.)
 *  2. A HIT skips planning entirely. That is the whole feature; a cache that
 *     reads and then recomputes anyway would pass any test that only checked
 *     the returned plan.
 *  3. Nothing here can fail an export. Corrupt file, unwritable directory,
 *     missing source — all degrade to "compute it again", never to a failure.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  MAX_ENTRIES,
  REFRAME_CACHE_FILE,
  readReframePlan,
  reframeCacheKey,
  writeReframePlan,
  type ReframeCacheKeyArgs
} from '@main/services/reframe-cache'
import { createExportRunner } from '@main/services/jobs/export-runner'
import type { ReframePlan } from '@shared/reframe-plan'
import type { JobParams } from '@shared/jobs'

const KEY: ReframeCacheKeyArgs = {
  clipId: 'c1',
  startTime: 10,
  endTime: 40,
  sourceMtimeMs: 1_700_000_000_000,
  sampleFps: 2,
  aspect: '9:16',
  mode: 'auto'
}

const PLAN: ReframePlan = { mode: 'static', cropW: 608, cropH: 1080, cropX: 120 }

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oc-reframe-cache-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('reframeCacheKey: every input that changes the plan is in it', () => {
  it('is stable for identical inputs', () => {
    expect(reframeCacheKey(KEY)).toBe(reframeCacheKey(KEY))
  })

  it('changes when the TRIM changes — the invalidation the design doc asks for', () => {
    expect(reframeCacheKey({ ...KEY, startTime: 10.5 })).not.toBe(reframeCacheKey(KEY))
    expect(reframeCacheKey({ ...KEY, endTime: 39 })).not.toBe(reframeCacheKey(KEY))
  })

  it('changes when the SOURCE FILE changes', () => {
    // Re-downloading or re-encoding the same path must not serve the old plan.
    expect(reframeCacheKey({ ...KEY, sourceMtimeMs: KEY.sourceMtimeMs + 1000 })).not.toBe(
      reframeCacheKey(KEY)
    )
  })

  it('changes with the ASPECT and the MODE', () => {
    // A 1:1 plan crops a different column; `split` is a structurally different
    // plan from identical samples. Omitting either serves the wrong crop.
    expect(reframeCacheKey({ ...KEY, aspect: '1:1' })).not.toBe(reframeCacheKey(KEY))
    expect(reframeCacheKey({ ...KEY, mode: 'split' })).not.toBe(reframeCacheKey(KEY))
  })

  it('changes with the sample rate', () => {
    expect(reframeCacheKey({ ...KEY, sampleFps: 3 })).not.toBe(reframeCacheKey(KEY))
  })

  it('is not defeated by float noise from a trim drag', () => {
    // A drag can produce 10.000000000000002; that must hit the cache for 10.
    expect(reframeCacheKey({ ...KEY, startTime: 10.0000001 })).toBe(reframeCacheKey(KEY))
  })

  it('cannot be collided by a separator character in the clip id', () => {
    expect(reframeCacheKey({ ...KEY, clipId: 'c1","x' })).not.toBe(
      reframeCacheKey({ ...KEY, clipId: 'c1' })
    )
  })
})

describe('read/write round trip', () => {
  it('returns undefined for a key that was never computed', () => {
    expect(readReframePlan(dir, 'nope')).toBeUndefined()
  })

  it('round-trips a plan', () => {
    const key = reframeCacheKey(KEY)
    writeReframePlan(dir, key, PLAN)
    expect(readReframePlan(dir, key)).toEqual({ plan: PLAN })
  })

  it('caches a NULL plan, distinguishably from a miss', () => {
    // "No usable face → centre-crop" costs exactly as much to compute as a plan
    // does. Storing it bare would make it indistinguishable from "never
    // computed" and the expensive negative result would be recomputed forever.
    const key = reframeCacheKey(KEY)
    writeReframePlan(dir, key, null)
    expect(readReframePlan(dir, key)).toEqual({ plan: null })
    expect(readReframePlan(dir, 'other')).toBeUndefined()
  })

  it('keeps entries for different keys side by side', () => {
    writeReframePlan(dir, reframeCacheKey(KEY), PLAN)
    writeReframePlan(dir, reframeCacheKey({ ...KEY, clipId: 'c2' }), null)
    expect(readReframePlan(dir, reframeCacheKey(KEY))).toEqual({ plan: PLAN })
    expect(readReframePlan(dir, reframeCacheKey({ ...KEY, clipId: 'c2' }))).toEqual({ plan: null })
  })

  it('creates the directory if it does not exist yet', () => {
    const nested = join(dir, 'not', 'there')
    writeReframePlan(nested, 'k', PLAN)
    expect(readReframePlan(nested, 'k')).toEqual({ plan: PLAN })
  })

  it('evicts oldest-first past the cap', () => {
    for (let i = 0; i < MAX_ENTRIES + 5; i += 1) writeReframePlan(dir, `k${i}`, PLAN)
    // The first five are gone; the newest survive.
    expect(readReframePlan(dir, 'k0')).toBeUndefined()
    expect(readReframePlan(dir, 'k4')).toBeUndefined()
    expect(readReframePlan(dir, 'k5')).toEqual({ plan: PLAN })
    expect(readReframePlan(dir, `k${MAX_ENTRIES + 4}`)).toEqual({ plan: PLAN })
  })
})

describe('an optimisation must never break what it optimises', () => {
  it('treats a corrupt cache file as a miss', () => {
    writeFileSync(join(dir, REFRAME_CACHE_FILE), '{ not json')
    expect(() => readReframePlan(dir, 'k')).not.toThrow()
    expect(readReframePlan(dir, 'k')).toBeUndefined()
  })

  it('treats a wrong-version or wrong-shaped file as a miss', () => {
    writeFileSync(join(dir, REFRAME_CACHE_FILE), JSON.stringify({ version: 99, entries: {} }))
    expect(readReframePlan(dir, 'k')).toBeUndefined()
    writeFileSync(join(dir, REFRAME_CACHE_FILE), JSON.stringify({ version: 1, entries: null }))
    expect(readReframePlan(dir, 'k')).toBeUndefined()
  })

  it('recovers by overwriting a corrupt file on the next write', () => {
    writeFileSync(join(dir, REFRAME_CACHE_FILE), 'garbage')
    writeReframePlan(dir, 'k', PLAN)
    expect(readReframePlan(dir, 'k')).toEqual({ plan: PLAN })
  })

  it('swallows a write failure rather than failing the caller', () => {
    // The export that produced this plan already succeeded; losing the cache
    // entry costs time on the next run and nothing else.
    const file = join(dir, 'blocked')
    mkdirSync(file)
    // `file` is a DIRECTORY where the writer expects to create a file inside it —
    // close enough to an unwritable location to exercise the guard.
    writeFileSync(join(file, REFRAME_CACHE_FILE), '')
    rmSync(join(file, REFRAME_CACHE_FILE))
    mkdirSync(join(file, REFRAME_CACHE_FILE))
    expect(() => writeReframePlan(file, 'k', PLAN)).not.toThrow()
  })

  it('writes atomically, leaving no partial file behind', () => {
    writeReframePlan(dir, 'k', PLAN)
    const raw = readFileSync(join(dir, REFRAME_CACHE_FILE), 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
  })
})

// ============================================================================
// The runner integration — the part that actually saves the time.
// ============================================================================

const EXPORT_PARAMS: JobParams['export'] = {
  projectId: 'p1',
  clipId: 'c1',
  sourcePath: '/tmp/src.mp4',
  startTime: 10,
  endTime: 40,
  aspectRatio: '9:16',
  outputPath: '/tmp/out.mp4',
  quality: '1080p',
  reframe: 'auto',
  sourceResolution: { width: 1920, height: 1080 },
  fps: 30
}

type Deps = NonNullable<Parameters<typeof createExportRunner>[0]>

function runnerWith(over: Deps): ReturnType<typeof createExportRunner> {
  return createExportRunner({
    exportClip: async () => ({
      outputPath: '/tmp/out.mp4',
      width: 1080,
      height: 1920,
      durationMs: 1
    }),
    resolveAssPath: () => '/tmp/x.ass',
    removeJobTemp: () => {},
    fontsDir: () => '/tmp/fonts',
    cacheDirFor: () => '/tmp/cache',
    sourceMtimeMs: () => 123,
    ...over
  })
}

const CTX = {
  jobId: 'j1',
  signal: new AbortController().signal,
  trackPid: () => {},
  untrackPid: () => {}
}
const EMIT = { progress: () => {}, partial: () => {} }

describe('export runner: a cache HIT skips planning entirely', () => {
  it('does not call planReframe at all when the plan is cached', async () => {
    // The whole feature. A cache that read and then planned anyway would still
    // return the right crop and save nothing.
    const planReframe = vi.fn(async () => PLAN)
    const seen: (unknown | undefined)[] = []
    const exportClip: Deps['exportClip'] = async (o) => {
      seen.push(o.reframePlan)
      return { outputPath: '/tmp/out.mp4', width: 1080, height: 1920, durationMs: 1 }
    }
    const runner = runnerWith({
      exportClip,
      planReframe,
      readReframePlan: () => ({ plan: PLAN }),
      writeReframePlan: () => {}
    })
    await runner(EXPORT_PARAMS, EMIT as never, CTX as never)

    expect(planReframe).not.toHaveBeenCalled()
    expect(seen[0]).toEqual(PLAN)
  })

  it('honours a cached NULL — the expensive "no faces" answer', async () => {
    const planReframe = vi.fn(async () => PLAN)
    const seen: (unknown | undefined)[] = []
    const exportClip: Deps['exportClip'] = async (o) => {
      seen.push(o.reframePlan)
      return { outputPath: '/tmp/out.mp4', width: 1080, height: 1920, durationMs: 1 }
    }
    const runner = runnerWith({
      exportClip,
      planReframe,
      readReframePlan: () => ({ plan: null }),
      writeReframePlan: () => {}
    })
    await runner(EXPORT_PARAMS, EMIT as never, CTX as never)

    expect(planReframe).not.toHaveBeenCalled()
    expect(seen[0]).toBeNull()
  })

  it('plans and WRITES on a miss', async () => {
    const planReframe = vi.fn(async () => PLAN)
    const writeReframePlan = vi.fn()
    const runner = runnerWith({
      planReframe,
      readReframePlan: () => undefined,
      writeReframePlan
    })
    await runner(EXPORT_PARAMS, EMIT as never, CTX as never)

    expect(planReframe).toHaveBeenCalledTimes(1)
    expect(writeReframePlan).toHaveBeenCalledTimes(1)
    expect(writeReframePlan.mock.calls[0][2]).toEqual(PLAN)
  })

  it('caches the null result too, so "no faces" is paid for once', async () => {
    const writeReframePlan = vi.fn()
    const runner = runnerWith({
      planReframe: async () => null,
      readReframePlan: () => undefined,
      writeReframePlan
    })
    await runner(EXPORT_PARAMS, EMIT as never, CTX as never)
    expect(writeReframePlan.mock.calls[0][2]).toBeNull()
  })

  it('does NOT cache a FAILED plan — a transient error must not stick', async () => {
    // A missing model or a crashed ffmpeg is not the answer "there are no faces";
    // caching it would make one bad run poison every later export of that clip.
    const writeReframePlan = vi.fn()
    const runner = runnerWith({
      planReframe: async () => {
        throw new Error('onnx model missing')
      },
      readReframePlan: () => undefined,
      writeReframePlan
    })
    await runner(EXPORT_PARAMS, EMIT as never, CTX as never)
    expect(writeReframePlan).not.toHaveBeenCalled()
  })

  it('never consults the cache when reframe is off', async () => {
    const readReframePlan = vi.fn(() => undefined)
    const runner = runnerWith({ readReframePlan, writeReframePlan: () => {} })
    await runner({ ...EXPORT_PARAMS, reframe: 'off' }, EMIT as never, CTX as never)
    expect(readReframePlan).not.toHaveBeenCalled()
  })
})

describe('export runner: a MANUAL crop override', () => {
  it('skips detection entirely — the user has already decided', async () => {
    // Auto-reframe was "un-overridable" (FEAT-kzej8t): a wrong-speaker lock had
    // no recourse but switching reframing off. With an override, running the
    // face pipeline to discard its answer would be the most expensive no-op in
    // the whole export.
    const planReframe = vi.fn(async () => PLAN)
    const seen: (unknown | undefined)[] = []
    const exportClip: Deps['exportClip'] = async (o) => {
      seen.push(o.reframePlan)
      return { outputPath: '/tmp/out.mp4', width: 1080, height: 1920, durationMs: 1 }
    }
    const runner = runnerWith({
      exportClip,
      planReframe,
      readReframePlan: () => undefined,
      writeReframePlan: () => {}
    })
    await runner(
      { ...EXPORT_PARAMS, reframeCropX: 400, sourceResolution: { width: 1920, height: 1080 } },
      EMIT as never,
      CTX as never
    )

    expect(planReframe).not.toHaveBeenCalled()
    // A 9:16 window over a 1080-high source is 608 wide, pinned at the given x.
    expect(seen[0]).toEqual({ mode: 'static', cropW: 608, cropH: 1080, cropX: 400 })
  })

  it('clamps an override that would hang the window off the source', async () => {
    const seen: (unknown | undefined)[] = []
    const exportClip: Deps['exportClip'] = async (o) => {
      seen.push(o.reframePlan)
      return { outputPath: '/tmp/out.mp4', width: 1080, height: 1920, durationMs: 1 }
    }
    const runner = runnerWith({
      exportClip,
      planReframe: async () => PLAN,
      readReframePlan: () => undefined,
      writeReframePlan: () => {}
    })
    await runner(
      { ...EXPORT_PARAMS, reframeCropX: 99_999, sourceResolution: { width: 1920, height: 1080 } },
      EMIT as never,
      CTX as never
    )
    expect((seen[0] as { cropX: number }).cropX).toBe(1920 - 608)
  })

  it('does not touch the plan CACHE for an override', async () => {
    // An override is not a detection result; writing it would poison the cache
    // for the same clip once the override is cleared.
    const writeReframePlan = vi.fn()
    const readReframePlan = vi.fn(() => undefined)
    const runner = runnerWith({
      planReframe: async () => PLAN,
      readReframePlan,
      writeReframePlan
    })
    await runner({ ...EXPORT_PARAMS, reframeCropX: 400 }, EMIT as never, CTX as never)
    expect(writeReframePlan).not.toHaveBeenCalled()
    expect(readReframePlan).not.toHaveBeenCalled()
  })
})

describe('export runner: the face/motion children are PID-tracked', () => {
  it('threads trackPid/untrackPid into planReframe', async () => {
    // These passes spawn ffmpeg directly (they need stdout, which
    // `ffmpeg-core.runFfmpeg` discards) and bypassed its PID tracking with it —
    // so they were the only ffmpeg children in the app that app-quit could orphan.
    const tracked: number[] = []
    const untracked: number[] = []
    const runner = runnerWith({
      planReframe: async (opts) => {
        opts.onSpawn?.(4242)
        opts.onExit?.(4242)
        return PLAN
      },
      readReframePlan: () => undefined,
      writeReframePlan: () => {}
    })
    await runner(
      EXPORT_PARAMS,
      EMIT as never,
      {
        ...CTX,
        trackPid: (pid: number) => tracked.push(pid),
        untrackPid: (pid: number) => untracked.push(pid)
      } as never
    )

    expect(tracked).toEqual([4242])
    // Untracked on exit, so a later quit cannot SIGKILL a recycled pid.
    expect(untracked).toEqual([4242])
  })
})
