/**
 * tests/unit/generate-clips-runner.spec.ts — the `generate-clips` JobRunner
 * (EPIC-zpa1nd / FEAT-c0zn3j).
 *
 * The behaviours that made clip detection worth moving onto the job plane at
 * all: per-chunk progress, streamed provisional candidates, a cancel that stops
 * paying for the remaining chunks, and a hard deadline so a provider that never
 * answers surfaces as a typed TIMEOUT instead of a permanently frozen button.
 *
 * No network: the transport is injected (the `ai-client` seam), as in every
 * other AI spec here.
 */

import { describe, expect, it, vi } from 'vitest'
import { JobError, type JobParams } from '@shared/jobs'
import { createGenerateClipsRunner } from '@main/services/jobs/generate-clips-runner'
import type { RawTransport } from '@main/services/ai-client'
import type { JobEmitter, JobRunnerContext } from '@main/services/sidecar-manager'
import { clipSchemaFixture } from '../fixtures/contract'

const PARAMS: JobParams['generate-clips'] = {
  projectId: 'p1',
  provider: 'openai',
  model: 'gpt-4o-mini',
  segments: [
    { id: 's1', start: 0, end: 30, text: 'first', confidence: 0.9 },
    { id: 's2', start: 30, end: 60, text: 'second', confidence: 0.9 }
  ],
  videoTitle: 'Demo',
  durationSeconds: 240,
  clipStyle: 'all',
  numClips: 5,
  targetPlatform: 'tiktok'
}

function emitter(): JobEmitter<'generate-clips'> & {
  progressCalls: Array<[number, string]>
  partials: Array<{ clips: unknown[]; chunkIndex: number; chunkCount: number }>
} {
  const progressCalls: Array<[number, string]> = []
  const partials: Array<{ clips: unknown[]; chunkIndex: number; chunkCount: number }> = []
  return {
    progressCalls,
    partials,
    progress: (pct, stage) => progressCalls.push([pct, stage]),
    partial: (data) => partials.push(data),
    done: () => {},
    error: () => {}
  }
}

/** The slice of `generateClips`' argument object these fakes actually read. */
type GenerateArgs = {
  numClips: number
  signal?: AbortSignal
  onChunk?: (index: number, count: number, clips: unknown[]) => void
}

function context(signal?: AbortSignal): JobRunnerContext {
  return {
    signal: signal ?? new AbortController().signal,
    trackPid: () => {},
    untrackPid: () => {},
    jobId: 'generate-clips-1'
  }
}

describe('generate-clips runner', () => {
  it('emits per-chunk progress and partials, and returns the ranked result', async () => {
    const generateClips = vi.fn(async (args: GenerateArgs) => {
      args.onChunk?.(0, 2, clipSchemaFixture.clips)
      args.onChunk?.(1, 2, clipSchemaFixture.clips)
      return { ok: true as const, value: clipSchemaFixture }
    })
    const runner = createGenerateClipsRunner({
      getKey: () => 'sk-test',
      createTransport: () => async () => ({ rawText: '{}' }),
      generateClips: generateClips as never
    })
    const emit = emitter()

    const result = await runner(PARAMS, emit, context())

    expect(result).toEqual(clipSchemaFixture)
    // Map-reduce always knew its chunk count; nothing had ever asked it for one.
    expect(emit.partials.map((p) => p.chunkIndex)).toEqual([0, 1])
    expect(emit.progressCalls).toContainEqual([50, 'analyzing'])
    expect(emit.progressCalls).toContainEqual([100, 'analyzing'])
  })

  it('never sends the API key anywhere but the transport factory', async () => {
    const createTransport = vi.fn(async () => async () => ({ rawText: '{}' }))
    const runner = createGenerateClipsRunner({
      getKey: () => 'sk-secret',
      createTransport: createTransport as never,
      generateClips: (async () => ({ ok: true, value: clipSchemaFixture })) as never
    })
    const emit = emitter()

    await runner(PARAMS, emit, context())

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-secret', provider: 'openai' })
    )
    // The key must not ride along in anything that crosses the port (PRD §12.2).
    expect(JSON.stringify(emit.partials)).not.toContain('sk-secret')
  })

  it('clamps numClips at the trust boundary (openclip-9hc)', async () => {
    const generateClips = vi.fn(async (args: GenerateArgs) => {
      void args // captured via mock.calls below
      return { ok: true as const, value: clipSchemaFixture }
    })
    const runner = createGenerateClipsRunner({
      getKey: () => null,
      createTransport: () => async () => ({ rawText: '{}' }),
      generateClips: generateClips as never
    })

    await runner({ ...PARAMS, numClips: 10_000 }, emitter(), context())
    expect(generateClips.mock.calls[0][0]).toMatchObject({ numClips: 50 })

    await runner({ ...PARAMS, numClips: 0 }, emitter(), context())
    expect(generateClips.mock.calls[1][0]).toMatchObject({ numClips: 1 })
  })

  it('raises a typed TIMEOUT when the provider never answers', async () => {
    // The reproduced failure: a real OpenRouter model that returned nothing on a
    // 406-second transcript. Without a deadline this hangs the app forever.
    //
    // The deadline is PER REQUEST (FEAT-bysdwg), not per job, so the deadline is
    // only armed around an actual provider call — hence a fake transport that
    // never answers, driven by a `generateClips` that calls it. Previously one
    // timeout covered the whole run, which meant a transcript needing several
    // chunks could exhaust it while every individual call answered promptly.
    const runner = createGenerateClipsRunner({
      getKey: () => null,
      createTransport: () => (_prompt, opts) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => reject(opts.signal?.reason))
        }),
      requestTimeoutMs: 20,
      generateClips: (async (args: { transport: RawTransport }) =>
        args.transport({ system: 's', user: 'u' })) as never
    })

    const err = await runner(PARAMS, emitter(), context()).catch((e) => e)

    expect(err).toBeInstanceOf(JobError)
    expect((err as JobError).code).toBe('TIMEOUT')
    expect((err as JobError).retriable).toBe(true)
    // The message has to name the thing the user can change.
    expect((err as JobError).message).toContain('gpt-4o-mini')
  })

  it('lets a user cancel through as a cancel, not a timeout', async () => {
    // The sidecar manager recognises its own aborted controller and emits the
    // terminal CANCELLED; dressing it up as TIMEOUT here would misreport what
    // happened and mark it retriable.
    const controller = new AbortController()
    const runner = createGenerateClipsRunner({
      getKey: () => null,
      createTransport: () => async () => ({ rawText: '{}' }),
      requestTimeoutMs: 60_000,
      generateClips: (async (args: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          args.signal?.addEventListener('abort', () => reject(new Error('aborted')))
          controller.abort()
        })) as never
    })

    const err = await runner(PARAMS, emitter(), context(controller.signal)).catch((e) => e)

    expect(err).not.toBeInstanceOf(JobError)
    expect((err as Error).message).toBe('aborted')
  })

  it('redacts a provider error before it leaves main, and types it (FEAT-bysdwg)', async () => {
    // The GENERATE path never went through `humanTransportError` — a transport
    // throw travelled runner → sidecar-manager → useJob → the UI with the raw
    // response body attached, and the SDK builds that message as the body
    // VERBATIM. For a user-supplied endpoint the body is chosen by a server we
    // do not control, and provider 401s routinely echo the submitted key.
    const runner = createGenerateClipsRunner({
      getKey: () => 'sk-secret-value',
      getBaseUrl: () => 'http://localhost:1234/v1',
      createTransport: () => async () => {
        throw new Error('401 {"error":{"message":"Incorrect API key provided: sk-secret-value"}}')
      },
      generateClips: (async (args: { transport: RawTransport }) =>
        args.transport({ system: 's', user: 'u' })) as never
    })

    const err = (await runner(PARAMS, emitter(), context()).catch((e) => e)) as JobError

    expect(err).toBeInstanceOf(JobError)
    expect(err.code).toBe('API_AUTH') // was SIDECAR_CRASH with a body attached
    expect(err.retriable).toBe(false)
    expect(err.message).not.toContain('sk-secret-value')
  })

  it('caps an unrecognised provider error rather than forwarding a wall of text', async () => {
    const runner = createGenerateClipsRunner({
      getKey: () => null,
      getBaseUrl: () => 'http://localhost:1234/v1',
      createTransport: () => async () => {
        throw new Error('teapot '.repeat(500))
      },
      generateClips: (async (args: { transport: RawTransport }) =>
        args.transport({ system: 's', user: 'u' })) as never
    })

    const err = (await runner(PARAMS, emitter(), context()).catch((e) => e)) as JobError

    expect(err.message.length).toBeLessThan(500)
  })

  it('passes the main-side endpoint to the transport factory', async () => {
    const createTransport = vi.fn(async () => async () => ({ rawText: '{}' }))
    const runner = createGenerateClipsRunner({
      getKey: () => null,
      getBaseUrl: () => 'http://localhost:1234/v1',
      createTransport: createTransport as never,
      generateClips: (async () => ({ ok: true, value: clipSchemaFixture })) as never
    })

    await runner(PARAMS, emitter(), context())

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'http://localhost:1234/v1' })
    )
  })

  it('reports an unrepairable model response as non-retriable INPUT_INVALID', async () => {
    // Deterministic for this input: retrying the identical prompt fails
    // identically, so marking it retriable would invite a pointless retry loop.
    const runner = createGenerateClipsRunner({
      getKey: () => null,
      createTransport: () => async () => ({ rawText: '{}' }),
      generateClips: (async () => ({
        ok: false,
        error: { code: 'INPUT_INVALID', retriable: true, message: 'bad json' }
      })) as never
    })

    const err = await runner(PARAMS, emitter(), context()).catch((e) => e)

    expect(err).toBeInstanceOf(JobError)
    expect((err as JobError).code).toBe('INPUT_INVALID')
    expect((err as JobError).retriable).toBe(false)
  })
})

// EPIC-k83ghw / BUG-hkmsng: `onChunk` is the only REAL progress signal, and it
// only fires at chunk BOUNDARIES. Most videos are a single chunk, so without
// a trickle the bar sat at 0% for the whole run — indistinguishable from a
// frozen button. Fake timers drive the 600ms ticker deterministically.
describe('generate-clips runner: progress trickles while waiting for a single (unchunked) LLM call', () => {
  it('advances progress between 0 and 100 with no real signal yet, then jumps to 100 on completion', async () => {
    vi.useFakeTimers()
    try {
      let resolveGenerate!: (v: { ok: true; value: typeof clipSchemaFixture }) => void
      const pending = new Promise<{ ok: true; value: typeof clipSchemaFixture }>((resolve) => {
        resolveGenerate = resolve
      })
      const runner = createGenerateClipsRunner({
        getKey: () => null,
        createTransport: () => async () => ({ rawText: '{}' }),
        // No onChunk call at all — exactly the common single-chunk shape.
        generateClips: (() => pending) as never
      })
      const emit = emitter()

      const done = runner(PARAMS, emit, context())

      // Let several trickle ticks fire while the "LLM call" is still pending.
      await vi.advanceTimersByTimeAsync(600 * 5)

      const midRunPcts = emit.progressCalls.map((c) => c[0])
      expect(midRunPcts[0]).toBe(0) // the leading "started" emit
      const trickled = midRunPcts.slice(1)
      expect(trickled.length).toBeGreaterThan(0)
      // Monotonically non-decreasing, and — the whole point — never claims
      // false completion while nothing real has happened yet.
      for (let i = 1; i < trickled.length; i++)
        expect(trickled[i]).toBeGreaterThanOrEqual(trickled[i - 1])
      for (const pct of trickled) expect(pct).toBeLessThan(90)

      // The real call resolves — jumps cleanly to 100, and no further ticks
      // land after settlement (the `finally` cleared the interval).
      resolveGenerate({ ok: true, value: clipSchemaFixture })
      await vi.advanceTimersByTimeAsync(0)
      await done

      expect(emit.progressCalls.at(-1)).toEqual([100, 'analyzing'])
      const countAtDone = emit.progressCalls.length
      await vi.advanceTimersByTimeAsync(600 * 5)
      expect(emit.progressCalls.length).toBe(countAtDone)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops trickling the instant a REAL chunk boundary arrives, and never regresses backward from it', async () => {
    vi.useFakeTimers()
    try {
      let resolveGenerate!: (v: { ok: true; value: typeof clipSchemaFixture }) => void
      const pending = new Promise<{ ok: true; value: typeof clipSchemaFixture }>((resolve) => {
        resolveGenerate = resolve
      })
      const runner = createGenerateClipsRunner({
        getKey: () => null,
        createTransport: () => async () => ({ rawText: '{}' }),
        generateClips: ((args: GenerateArgs) => {
          // A real chunk boundary arrives mid-run.
          args.onChunk?.(0, 3, clipSchemaFixture.clips)
          return pending
        }) as never
      })
      const emit = emitter()

      const done = runner(PARAMS, emit, context())
      await vi.advanceTimersByTimeAsync(0) // let the synchronous onChunk land
      const afterChunk = emit.progressCalls.at(-1)!
      expect(afterChunk).toEqual([Math.round((1 / 3) * 100), 'analyzing'])

      // Ticks that would have fired after this must not overwrite it — the
      // runner stops ticking on the first real signal.
      await vi.advanceTimersByTimeAsync(600 * 5)
      expect(emit.progressCalls.at(-1)).toEqual(afterChunk)

      resolveGenerate({ ok: true, value: clipSchemaFixture })
      await vi.advanceTimersByTimeAsync(0)
      await done
    } finally {
      vi.useRealTimers()
    }
  })
})
