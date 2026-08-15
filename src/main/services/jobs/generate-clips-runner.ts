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
import { providerDisplay } from '@shared/ai-providers'
import { describeProviderFailure, redactSecrets } from '@main/services/ai-errors'
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
  /**
   * Resolves the endpoint for providers that have no fixed one (`custom`).
   * Comes from Settings main-side, never from the job params — a base URL on the
   * job contract would let the renderer choose where the key is sent
   * (FEAT-bysdwg).
   */
  getBaseUrl?: (provider: AIProvider) => string | undefined
  /** Build the provider transport (injected in tests so no SDK is constructed). */
  createTransport?: (args: {
    provider: AIProvider
    model: string
    apiKey: string | null
    baseUrl?: string
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

    // Trickle progress while waiting for the (usually single) LLM call to
    // return (EPIC-k83ghw / BUG-hkmsng). `onChunk` below is the only REAL
    // progress signal, and it only fires at chunk BOUNDARIES — most videos are
    // one chunk, so without this the bar sat at 0% for the whole run, which
    // reads as a frozen button rather than a run in flight. Approaches (never
    // reaches) a conservative 40% ceiling, decaying, and stops the instant a
    // real chunk boundary arrives — capped low enough that a small/multi-chunk
    // transcript's first REAL boundary (which can be a lower percentage, e.g.
    // 1 of 3 chunks) rarely regresses visibly, and a single-chunk run (the
    // common case) jumps cleanly forward from ~40% straight to 100%.
    let ticking = true
    let trickled = 0
    const trickle = setInterval(() => {
      if (!ticking) return
      trickled += (40 - trickled) * 0.12
      emit.progress(Math.round(trickled), 'analyzing')
    }, 600)

    const apiKey = deps.getKey(params.provider)
    const baseUrl = deps.getBaseUrl?.(params.provider)

    // `makeTransport` moved INSIDE the try/finally below (it used to sit
    // between the trickle's setInterval and the try block): a rejection here
    // — an unsupported/misconfigured provider, a real and reachable path —
    // used to skip the `finally` entirely and leak the trickle timer forever
    // (self-review fix, EPIC-k83ghw / BUG-hkmsng). Classifying it through the
    // SAME catch below is also more accurate than letting it fall through to
    // the sidecar's generic ffmpeg/whisper-oriented classifier.
    let timedOut = false
    try {
      const transport = await makeTransport({
        provider: params.provider,
        model: params.model,
        apiKey,
        baseUrl
      })

      // PER-REQUEST deadline (FEAT-bysdwg). This used to be ONE
      // `AbortSignal.timeout` created here and threaded through every chunk, so the
      // "hard deadline per provider request" this file's header promises was really
      // a budget for the whole job: a long transcript that needed four chunks failed
      // as a spurious TIMEOUT even though every individual call answered promptly.
      // Self-hosted models are slower than cloud ones and the custom endpoint's
      // downgrade ladder can add attempts, which turns that latent bug into the
      // common case. `ctx.signal` remains the only run-level signal.
      const guarded: RawTransport = async (prompt, opts) => {
        const perRequest = AbortSignal.timeout(timeoutMs)
        const signals = [perRequest, ...(opts?.signal ? [opts.signal] : [])]
        try {
          return await transport(prompt, { ...opts, signal: AbortSignal.any(signals) })
        } catch (err) {
          // Distinguish "this request ran out of time" from "the user cancelled".
          if (perRequest.aborted && !ctx.signal.aborted) timedOut = true
          throw err
        }
      }

      const result = await generate({
        transport: guarded,
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
        // Endpoint identity for the cache key only — the transport is already
        // built (FEAT-bysdwg).
        provider: params.provider,
        baseUrl,
        cache: deps.cache,
        signal: ctx.signal,
        onChunk: (chunkIndex, chunkCount, clips) => {
          // A real signal has arrived — stop guessing (BUG-hkmsng).
          ticking = false
          emit.partial({ clips, chunkIndex, chunkCount })
          emit.progress(Math.round(((chunkIndex + 1) / chunkCount) * 100), 'analyzing')
        }
      })

      if (!result.ok) {
        // The repair ladder gave up. This is deterministic for this input —
        // retrying the identical prompt will fail identically — so it is a
        // non-retriable INPUT_INVALID, not a crash.
        //
        // Redacted like every other outbound message: this one quotes the MODEL's
        // output (a JSON.parse error embeds a slice of the response), which for a
        // custom endpoint is chosen by a server we do not control.
        throw new JobError(
          'INPUT_INVALID',
          `${result.error.code}: ${redactSecrets(result.error.message, apiKey)}`,
          false
        )
      }

      emit.progress(100, 'analyzing')
      // Carry non-fatal warnings (a chunk that failed while others succeeded)
      // through to the renderer, so a partial run stops looking complete
      // (BUG-yq6qbw). Same reasoning as above: they quote model output.
      const warnings = result.warnings?.map((w) => redactSecrets(w, apiKey))
      return warnings?.length ? { ...result.value, warnings } : result.value
    } catch (err) {
      // A deadline abort with the job itself NOT cancelled is the hung-provider
      // case this ticket exists for. Name it, and mark it retriable: a different
      // moment (or a different model) may well succeed.
      if (timedOut && !ctx.signal.aborted) {
        throw new JobError(
          'TIMEOUT',
          `${providerDisplay(params.provider, baseUrl)} did not respond within ${Math.round(timeoutMs / 1000)}s for model "${params.model}". Try a faster model, or check the server.`,
          true
        )
      }
      // Our own typed errors are already user-facing; anything else came from the
      // provider SDK and must be classified + REDACTED before it leaves main. The
      // raw message is the response body verbatim, which routinely echoes the
      // submitted key — and, for a custom endpoint, is chosen by a server we do
      // not control (FEAT-bysdwg).
      if (!(err instanceof JobError) && !ctx.signal.aborted) {
        const failure = describeProviderFailure(err, {
          provider: params.provider,
          model: params.model,
          baseUrl,
          apiKey
        })
        throw new JobError(failure.code, failure.message, failure.retriable)
      }
      // A user cancel falls through: the manager recognises the aborted
      // controller and emits the terminal CANCELLED itself.
      throw err
    } finally {
      // Stop the trickle on every exit path (success, error, cancel) — a
      // dangling timer would keep emitting progress on a settled job (a
      // harmless no-op per sidecar-manager's guard) forever otherwise.
      ticking = false
      clearInterval(trickle)
    }
  }
}
