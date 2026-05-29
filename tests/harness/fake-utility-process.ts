/**
 * tests/harness/fake-utility-process.ts — a fake `utilityProcess`/sidecar
 * harness that emits SCRIPTED `progress/partial/done/error` over a real
 * MessagePort (plan E.2 / PRD §18 sidecar-port harness).
 *
 * It lets us test cancellation, queueing and the job-termination invariant
 * WITHOUT a real whisper/FFmpeg binary. Two surfaces:
 *
 *   - `scriptedRunner(script)` → a `JobRunner` you can `registerRunner(kind, …)`
 *     on a real `SidecarManager`, driving its full queue/port machinery.
 *   - `driveScriptOverChannel(channel, script)` → posts a scripted JobEvent
 *     stream directly onto a Node `MessageChannel` port, for testing the
 *     renderer-side `jobEvents()`/`useJob` consumer in isolation.
 *
 * Both consume the SAME `JobScript` so a test's expectations stay consistent.
 */

import type { JobKind, JobResult, JobPartial, JobErrorCode } from '@shared/jobs'
import type { JobRunner, JobEmitter, JobRunnerContext } from '@main/services/sidecar-manager'

// ============================================================================
// JobScript — the scripted sequence a fake runner plays back
// ============================================================================

export type ScriptStep<K extends JobKind> =
  | { t: 'progress'; pct: number; stage: string; etaMs?: number }
  | { t: 'partial'; data: JobPartial[K] }
  | { t: 'done'; result: JobResult[K] }
  | { t: 'error'; code: JobErrorCode; message: string; retriable: boolean }

export interface JobScript<K extends JobKind> {
  steps: ScriptStep<K>[]
  /** Delay (ms) between steps. Default 0 (synchronous-ish microtask cadence). */
  stepDelayMs?: number
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ============================================================================
// scriptedRunner — a JobRunner for SidecarManager.registerRunner
// ============================================================================

/**
 * Build a `JobRunner<K>` that plays `script` through the manager-provided
 * `emit`. A terminal `done`/`error` step controls how the runner settles:
 *   - `done`  → resolves with the result (manager emits the terminal done).
 *   - `error` → throws (manager maps to a terminal error) UNLESS the test wants
 *     to emit the error itself; here we resolve via `emit.error` then return.
 * Honours `ctx.signal` so cancellation tests work.
 */
export function scriptedRunner<K extends JobKind>(script: JobScript<K>): JobRunner<K> {
  return async (_params, emit: JobEmitter<K>, ctx: JobRunnerContext): Promise<JobResult[K]> => {
    const stepDelay = script.stepDelayMs ?? 0
    let doneResult: JobResult[K] | undefined
    for (const step of script.steps) {
      if (ctx.signal.aborted) throw new Error('aborted')
      if (stepDelay) await delay(stepDelay)
      switch (step.t) {
        case 'progress':
          emit.progress(step.pct, step.stage, step.etaMs)
          break
        case 'partial':
          emit.partial(step.data)
          break
        case 'done':
          doneResult = step.result
          break
        case 'error':
          // Throw so the manager emits the terminal error with our code.
          throw Object.assign(new Error(step.message), { jobErrorCode: step.code })
      }
    }
    if (doneResult === undefined) {
      throw new Error('scriptedRunner: script had no terminal done/error step')
    }
    return doneResult
  }
}

// ============================================================================
// driveScriptOverChannel — post a scripted JobEvent stream onto a port
// (for the renderer-side jobEvents()/useJob consumer, mirroring the wire shape
//  the main side produces: a {t:'job-id'} envelope, then JobEvents).
// ============================================================================

/** A minimal port we can post onto (Node MessagePort satisfies this). */
export interface PostablePort {
  postMessage(value: unknown): void
}

export interface DriveOptions {
  /** Emit the `{t:'job-id'}` envelope first (as main does). Default true. */
  emitJobId?: boolean
  jobId?: string
  stepDelayMs?: number
}

export async function driveScriptOverChannel<K extends JobKind>(
  port: PostablePort,
  script: JobScript<K>,
  opts: DriveOptions = {}
): Promise<void> {
  const stepDelay = opts.stepDelayMs ?? script.stepDelayMs ?? 0
  if (opts.emitJobId !== false) {
    port.postMessage({ t: 'job-id', jobId: opts.jobId ?? 'fake-job-1' })
  }
  for (const step of script.steps) {
    if (stepDelay) await delay(stepDelay)
    port.postMessage(step)
  }
}
