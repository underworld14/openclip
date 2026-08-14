/**
 * src/main/services/jobs/generate-clips-runner.ts — the `generate-clips`
 * JobRunner (EPIC-zpa1nd / FEAT-c0zn3j). Registered with the sidecar from
 * `ipc/ai.ts`, which owns the key vault and the transport factory.
 *
 * Clip detection was the last long operation still running as a plain `invoke`:
 * one repair-laddered LLM call per transcript chunk, strictly sequential, with
 * no progress, no cancel and no timeout. On a slow model that is minutes of a
 * frozen button, and on a wedged connection it never ends — reproduced against
 * a real OpenRouter model that never returned on a 406-second transcript.
 *
 * As a job it gets the MessagePort progress/cancel plane and the "always
 * terminates done xor error" invariant for free. The two things it has to add
 * itself are a HARD DEADLINE per provider request and mapping an abort to the
 * right terminal code — a user cancel and a hung provider are different events
 * and must not both read as "something went wrong".
 *
 * Thin glue over the same `generateClips` core the `ai:generate-clips` invoke
 * handler calls, with an INJECTED transport factory so it is unit-testable with
 * no network (PRD §18).
 */

import { JobError } from '@shared/jobs'
import type { JobResult, JobParams } from '@shared/jobs'
import type { AIProvider } from '@shared/schema'
import type { JobRunner, JobEmitter, JobRunnerContext } from '@main/services/sidecar-manager'
import {
  AI_REQUEST_TIMEOUT_MS,
  createTransport,
  generateClips as defaultGenerateClips,
  type RawTransport
} from '@main/services/ai-client'

export interface GenerateClipsRunnerDeps {
  /** Decrypts the BYOK key MAIN-SIDE; it never crosses IPC (PRD §12.2). */
  getKey: (provider: AIProvider) => string | null
  /** Build the provider transport (injected in tests so no SDK is constructed). */
  createTransport?: (args: {
    provider: AIProvider
    model: string
    apiKey: string | null
  }) => RawTransport | Promise<RawTransport>
  /** The map-reduce + repair-ladder core (injected in tests). */
  generateClips?: typeof defaultGenerateClips
  /** Shared with the invoke handler so both entry points hit one cache (PRD §16). */
  cache?: Map<string, unknown>
  /** Per-request deadline override (tests use a tiny one). */
  requestTimeoutMs?: number
}

/**
 * Build the `generate-clips` runner. Emits `progress(pct,'analyzing')` and a
 * `partial` per chunk, and returns the authoritative clamped/ranked ClipSchema
 * as the `done` result.
 */
export function createGenerateClipsRunner(
  deps: GenerateClipsRunnerDeps
): JobRunner<'generate-clips'> {
  const makeTransport = deps.createTransport ?? createTransport
  const generate = deps.generateClips ?? defaultGenerateClips
  const timeoutMs = deps.requestTimeoutMs ?? AI_REQUEST_TIMEOUT_MS

  return async (
    params: JobParams['generate-clips'],
    emit: JobEmitter<'generate-clips'>,
    ctx: JobRunnerContext
  ): Promise<JobResult['generate-clips']> => {
    // Lead with a real stage so the bar never sits blank while the SDK module
    // is lazily imported and the first request is in flight.
    emit.progress(0, 'analyzing')

    const transport = await makeTransport({
      provider: params.provider,
      model: params.model,
      apiKey: deps.getKey(params.provider)
    })

    // Cancel OR deadline, whichever lands first. Tracked separately because the
    // two mean different things to the user: `ctx.signal` is "you asked me to
    // stop" (the manager emits CANCELLED), a timeout is "the provider never
    // answered" and deserves the typed, retriable TIMEOUT below.
    const deadline = AbortSignal.timeout(timeoutMs)
    const signal = AbortSignal.any([ctx.signal, deadline])

    try {
      const result = await generate({
        transport,
        segments: params.segments,
        videoTitle: params.videoTitle,
        durationSeconds: params.durationSeconds,
        clipStyle: params.clipStyle,
        // Clamp to a sane 1..50 at the trust boundary (audit fix openclip-9hc):
        // an unbounded value inflates the prompt + BYOK token cost and risks
        // output truncation; a non-positive one yields an always-empty result.
        numClips: Math.max(1, Math.min(50, Math.floor(params.numClips) || 1)),
        targetPlatform: params.targetPlatform,
        minDuration: params.minDuration ?? 15,
        maxDuration: params.maxDuration ?? 90,
        // Pre-flight targeting (FEAT-n762y6). `segments` arrive already sliced to
        // `range`; the range itself is carried so the prompt can tell the model
        // it is looking at a window of a longer video, not the whole thing.
        range: params.range,
        keywords: params.keywords,
        customPrompt: params.customPrompt,
        model: params.model,
        cache: deps.cache,
        signal,
        onChunk: (chunkIndex, chunkCount, clips) => {
          emit.partial({ clips, chunkIndex, chunkCount })
          emit.progress(Math.round(((chunkIndex + 1) / chunkCount) * 100), 'analyzing')
        }
      })

      if (!result.ok) {
        // The repair ladder gave up. This is deterministic for this input —
        // retrying the identical prompt will fail identically — so it is a
        // non-retriable INPUT_INVALID, not a crash.
        throw new JobError('INPUT_INVALID', `${result.error.code}: ${result.error.message}`, false)
      }

      emit.progress(100, 'analyzing')
      // Carry non-fatal warnings (a chunk that failed while others succeeded)
      // through to the renderer, so a partial run stops looking complete
      // (BUG-yq6qbw).
      return result.warnings?.length ? { ...result.value, warnings: result.warnings } : result.value
    } catch (err) {
      // A deadline abort with the job itself NOT cancelled is the hung-provider
      // case this ticket exists for. Name it, and mark it retriable: a different
      // moment (or a different model) may well succeed.
      if (deadline.aborted && !ctx.signal.aborted) {
        throw new JobError(
          'TIMEOUT',
          `${params.provider} did not respond within ${Math.round(timeoutMs / 1000)}s for model "${params.model}". Try a faster model, or check the provider's status.`,
          true
        )
      }
      // A user cancel falls through: the manager recognises the aborted
      // controller and emits the terminal CANCELLED itself.
      throw err
    }
  }
}
