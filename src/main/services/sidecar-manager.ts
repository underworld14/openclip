/**
 * src/main/services/sidecar-manager.ts — the sidecar HOST INTERFACE + job
 * router (TRUNK INFRA, frozen after Stage 3 — plan E.2/E.4).
 *
 * This file owns the FROZEN seams; the fan-out tracks plug in only their own
 * `services/jobs/<kind>-runner.ts` via `registerRunner(kind, runner)` (E.4),
 * never co-editing this file or each other.
 *
 * Responsibilities (PRD §17 / plan Part B):
 *   - `registerRunner(kind, runner)` + a `JOB_RUNNERS` registry (the seam).
 *   - `startJob(kind, params)` → opens a `MessageChannelMain`, hands one port to
 *     the renderer (transferred via the JOB_START IPC) and drives the runner,
 *     streaming `JobEventFor<K>` over the other port. Always terminates with a
 *     `done|error` event (cancel → `{t:'error',code:'CANCELLED'}`).
 *   - PID tracking + kill-on-quit: SIGTERM then SIGKILL after a 3s grace on
 *     before-quit/will-quit/SIGINT/SIGTERM/port-close (NOT child-process-gone —
 *     openclip-032; that fires for recoverable Electron GPU/utility crashes).
 *   - p-queue concurrency: 1 transcribe; `min(2, ceil(cores/4))` exports;
 *     model-download unthrottled. Queue position surfaced as stage `"queued"`.
 *
 * NOTE on isolation: the PRD spawns native children inside an Electron
 * `utilityProcess`. This manager is the HOST-side API that the fan-out tracks
 * code against; the concrete utilityProcess entry + its `process.parentPort`
 * wiring is brought in by T-Media when it lands the real whisper runner. The
 * `JobRunner` contract here is deliberately transport-agnostic so a runner can
 * either spawn directly (dev/tests via the fake harness) or be marshalled into
 * the utilityProcess — the seam does not change.
 */

import { cpus } from 'node:os'
import type { JobKind, JobParams, JobResult, JobPartial, JobErrorCode } from '@shared/jobs'

// ============================================================================
// Runner contract (the frozen seam every track implements)
// ============================================================================

/**
 * The sink a runner pushes events into. Mirrors `JobEventFor<K>` but split into
 * named methods so a runner cannot emit a malformed union member. The manager
 * guarantees exactly one terminal call (`done` xor `error`) reaches the port.
 */
export interface JobEmitter<K extends JobKind> {
  progress(pct: number, stage: string, etaMs?: number): void
  partial(data: JobPartial[K]): void
  done(result: JobResult[K]): void
  error(code: JobErrorCode, message: string, retriable: boolean): void
}

/** Context handed to every runner: cancellation + a PID-registration hook. */
export interface JobRunnerContext {
  /** Aborted on cancel/quit/port-close; runners must stop their child on abort. */
  readonly signal: AbortSignal
  /** Runners call this for each native child they spawn so it's killed on quit. */
  trackPid(pid: number): void
  /** The id of this job (for temp-dir scoping, logs). */
  readonly jobId: string
}

/**
 * A job runner for kind `K`. Resolves (or rejects) when the underlying work
 * finishes; intermediate progress/partial are pushed through `emit`. A runner
 * SHOULD resolve normally and let the manager emit the terminal `done`; throwing
 * is mapped to a typed `error` event by the manager.
 */
export type JobRunner<K extends JobKind> = (
  params: JobParams[K],
  emit: JobEmitter<K>,
  ctx: JobRunnerContext
) => Promise<JobResult[K]>

// ============================================================================
// JOB_RUNNERS registry (plan E.4) — the per-kind seam
// ============================================================================

const JOB_RUNNERS = new Map<JobKind, JobRunner<JobKind>>()

/**
 * Register the runner for a job kind. Each fan-out track calls this once from
 * its own `services/jobs/<kind>-runner.ts` at main-process init. Re-registering
 * a kind throws (catches duplicate ownership at startup).
 */
export function registerRunner<K extends JobKind>(kind: K, runner: JobRunner<K>): void {
  if (JOB_RUNNERS.has(kind)) {
    throw new Error(`sidecar-manager: a runner for "${kind}" is already registered`)
  }
  JOB_RUNNERS.set(kind, runner as unknown as JobRunner<JobKind>)
}

/** Test/registry helper — whether a kind has a runner yet. */
export function hasRunner(kind: JobKind): boolean {
  return JOB_RUNNERS.has(kind)
}

/** Internal/test accessor for the registered runner of a kind. */
export function getRunner<K extends JobKind>(kind: K): JobRunner<K> | undefined {
  return JOB_RUNNERS.get(kind) as JobRunner<K> | undefined
}

// ============================================================================
// Concurrency (plan Part B / PRD §17)
// ============================================================================

/** `min(2, ceil(cores/4))` exports run concurrently (PRD §17). */
export function exportConcurrency(coreCount = cpus().length): number {
  return Math.min(2, Math.max(1, Math.ceil(coreCount / 4)))
}

/** Per-kind concurrency ceilings. */
export function concurrencyFor(kind: JobKind, coreCount = cpus().length): number {
  switch (kind) {
    case 'transcribe':
      return 1 // RAM/CPU heavy — strictly serial (PRD §17)
    case 'export':
      return exportConcurrency(coreCount)
    case 'model-download':
      return 4 // network-bound, cheap to overlap
    case 'url-download':
      return 2 // network-bound; allow a couple of concurrent URL imports (F.4)
    default:
      return 1
  }
}

// ============================================================================
// The host port shape (structural — works for both Electron MessageChannelMain
// ports and the Node MessagePort used by the fake-utilityProcess test harness).
// ============================================================================

/** A minimal port we can post `JobEvent`s on and close. */
export interface EventPort {
  postMessage(value: unknown): void
  close?(): void
  /** Optional: notified when the peer (renderer) closes — implicit cancel. */
  on?(event: 'close', listener: () => void): void
  start?(): void
}

// ============================================================================
// SidecarManager — the host that owns queues, PIDs, port handoff, lifecycle.
// ============================================================================

interface ActiveJob {
  kind: JobKind
  controller: AbortController
  pids: Set<number>
  settled: boolean
  /** True once the limiter has ADMITTED this job's runner (vs. still queued). */
  started: boolean
  /** Settle a still-QUEUED job with the terminal CANCELLED (audit fix openclip-yyi/sf0). */
  cancelQueued: () => void
}

export interface SidecarManagerOptions {
  /** Override core count (tests). */
  coreCount?: number
  /** Grace period before SIGKILL after SIGTERM (ms). Default 3000 (PRD §17). */
  killGraceMs?: number
  /**
   * How to terminate a tracked PID. Injectable so tests don't kill real procs.
   * Default sends an OS signal via `process.kill`.
   */
  killPid?: (pid: number, signal: NodeJS.Signals) => void
  /**
   * Factory for a per-kind concurrency-limited queue. Injectable so unit tests
   * can avoid importing the ESM-only p-queue; production passes a p-queue-backed
   * limiter (see `createPQueueLimiterFactory`).
   */
  limiterFactory?: (concurrency: number) => Limiter
}

/** A minimal concurrency limiter (p-queue is the production implementation). */
export interface Limiter {
  /** Run `task` respecting the concurrency cap; resolves with its result. */
  add<T>(task: () => Promise<T>): Promise<T>
  /** Number of tasks waiting (used to surface the `"queued"` stage). */
  readonly pending: number
}

export class SidecarManager {
  private readonly active = new Map<string, ActiveJob>()
  private readonly limiters = new Map<JobKind, Limiter>()
  private readonly coreCount: number
  private readonly killGraceMs: number
  private readonly killPid: (pid: number, signal: NodeJS.Signals) => void
  private limiterFactory: (concurrency: number) => Limiter
  private seq = 0

  constructor(opts: SidecarManagerOptions = {}) {
    this.coreCount = opts.coreCount ?? cpus().length
    this.killGraceMs = opts.killGraceMs ?? 3000
    this.killPid =
      opts.killPid ??
      ((pid, signal) => {
        try {
          process.kill(pid, signal)
        } catch {
          /* already gone */
        }
      })
    this.limiterFactory = opts.limiterFactory ?? defaultArrayLimiterFactory
  }

  /**
   * Swap the limiter factory (e.g. to the p-queue-backed one) BEFORE any job
   * runs. Only affects kinds whose limiter hasn't been lazily created yet, so
   * it must be called at init (main/index.ts) — throws if a limiter exists.
   */
  setLimiterFactory(factory: (concurrency: number) => Limiter): void {
    if (this.limiters.size > 0) {
      throw new Error('sidecar-manager: limiter factory must be set before any job runs')
    }
    this.limiterFactory = factory
  }

  private limiterFor(kind: JobKind): Limiter {
    let l = this.limiters.get(kind)
    if (!l) {
      l = this.limiterFactory(concurrencyFor(kind, this.coreCount))
      this.limiters.set(kind, l)
    }
    return l
  }

  private nextJobId(kind: JobKind): string {
    this.seq += 1
    return `${kind}-${Date.now().toString(36)}-${this.seq}`
  }

  /** Active job ids (used by the launch-time temp sweeper, PRD §17). */
  activeJobIds(): string[] {
    return [...this.active.keys()]
  }

  /**
   * Run a job of `kind`, streaming events to `port`. Resolves with the jobId
   * immediately so callers can hand the renderer its port; the work proceeds
   * asynchronously and always terminates the port with a done|error event.
   *
   * If the kind has no registered runner yet (pre-fan-out), emits a typed
   * INPUT_INVALID error so the contract never silently hangs.
   */
  startJob<K extends JobKind>(kind: K, params: JobParams[K], port: EventPort): string {
    const jobId = this.nextJobId(kind)
    const controller = new AbortController()
    const job: ActiveJob = {
      kind,
      controller,
      pids: new Set(),
      settled: false,
      started: false,
      cancelQueued: () => {}
    }
    this.active.set(jobId, job)

    const settle = (
      terminal:
        | { t: 'done'; result: JobResult[K] }
        | { t: 'error'; code: JobErrorCode; message: string; retriable: boolean }
    ): void => {
      if (job.settled) return
      job.settled = true
      // Remove from `active` FIRST and guard the port calls (audit fix openclip-asx):
      // if `port.postMessage`/`close` throws (e.g. the renderer was torn down so the
      // MessagePort is dead), the job — and its tracked PIDs — would otherwise leak in
      // `active` forever because the delete below never ran. The terminal event is moot
      // once the peer is gone, so a throw is swallowed; the job is always reclaimed.
      this.active.delete(jobId)
      try {
        port.postMessage(terminal)
      } catch {
        /* peer port already gone — terminal is moot, don't leak the job */
      }
      try {
        port.close?.()
      } catch {
        /* peer port already gone */
      }
    }
    // Settle a job that is cancelled while still QUEUED (not yet admitted by the
    // limiter), so cancel()/killAll() deliver the terminal CANCELLED deterministically
    // instead of waiting for the limiter to drain (audit fix openclip-yyi/sf0). settle
    // is idempotent (the `settled` guard), so the queued task's later admission — which
    // hits the aborted check and returns — is a harmless no-op.
    job.cancelQueued = (): void =>
      settle({ t: 'error', code: 'CANCELLED', message: 'job cancelled before start', retriable: false })

    const emit: JobEmitter<K> = {
      progress: (pct, stage, etaMs) => {
        if (job.settled) return
        port.postMessage({ t: 'progress', pct, stage, etaMs })
      },
      partial: (data) => {
        if (job.settled) return
        port.postMessage({ t: 'partial', data })
      },
      done: (result) => settle({ t: 'done', result }),
      error: (code, message, retriable) => settle({ t: 'error', code, message, retriable })
    }

    // Port close (renderer crash / nav away) ⇒ implicit cancel (PRD §17).
    port.on?.('close', () => this.cancel(jobId))
    port.start?.()

    const runner = getRunner(kind)
    if (!runner) {
      emit.error('INPUT_INVALID', `no runner registered for job kind "${kind}"`, false)
      return jobId
    }

    const ctx: JobRunnerContext = {
      signal: controller.signal,
      trackPid: (pid: number) => job.pids.add(pid),
      jobId
    }

    // Surface queue position before the limiter admits the task.
    const limiter = this.limiterFor(kind)
    if (limiter.pending > 0) emit.progress(0, 'queued')

    limiter
      .add(async () => {
        // Admitted by the limiter — mark started so cancel()/killAll() use the runner's
        // abort path (not the queued short-circuit) from here on (openclip-yyi/sf0).
        job.started = true
        if (controller.signal.aborted) {
          emit.error('CANCELLED', 'job cancelled before start', false)
          return
        }
        const result = await runner(params, emit, ctx)
        emit.done(result)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) {
          emit.error('CANCELLED', 'job cancelled', false)
          return
        }
        const message = err instanceof Error ? err.message : String(err)
        emit.error('SIDECAR_CRASH', message, true)
      })

    return jobId
  }

  /**
   * Cooperatively cancel a running job: abort its controller (runner stops its
   * child), then escalate any tracked PIDs SIGTERM→SIGKILL. The runner's
   * rejection path emits the terminal `{t:'error',code:'CANCELLED'}`.
   */
  cancel(jobId: string): void {
    const job = this.active.get(jobId)
    if (!job) return
    job.controller.abort()
    this.escalateKill(job)
    // A still-QUEUED job has no running runner to emit its terminal on abort, so settle
    // it synchronously rather than waiting for the limiter to admit + reject it
    // (audit fix openclip-yyi). A started job's runner emits CANCELLED via its abort.
    if (!job.started) job.cancelQueued()
  }

  /** SIGTERM all tracked PIDs, then SIGKILL after the grace period (PRD §17). */
  private escalateKill(job: ActiveJob): void {
    for (const pid of job.pids) this.killPid(pid, 'SIGTERM')
    if (job.pids.size === 0) return
    setTimeout(() => {
      for (const pid of job.pids) this.killPid(pid, 'SIGKILL')
    }, this.killGraceMs).unref?.()
  }

  /** Kill EVERYTHING — wired to before-quit/will-quit/SIGINT (PRD §17). */
  killAll(): void {
    for (const [jobId, job] of this.active) {
      job.controller.abort()
      this.escalateKill(job)
      // Deliver the terminal CANCELLED for a still-QUEUED job NOW instead of letting
      // its limiter task fire later on a torn-down port (audit fix openclip-sf0).
      // cancelQueued is idempotent + already deletes from `active`, so guard the loop's
      // own delete below for the started/already-settled case.
      if (!job.started && !job.settled) job.cancelQueued()
      this.active.delete(jobId)
    }
  }

  /**
   * Bind process-lifecycle kill hooks. Call once at main-process init with the
   * Electron `app`. Registers before-quit/will-quit/SIGINT/SIGTERM → killAll (PRD §17
   * orphan prevention).
   *
   * NOTE (audit fix openclip-032): `child-process-gone` is deliberately NOT a kill
   * trigger. It fires for Electron's OWN child processes (GPU / Utility / renderer),
   * NOT for our ffmpeg/whisper/yt-dlp children — those are plain `child_process.spawn`
   * and are torn down by each runner's close/error handlers (+ the per-job port-close
   * → cancel). A transient GPU-process crash (common on macOS under memory pressure,
   * exactly during a big export) used to trip killAll() and SIGKILL every running
   * job, surfacing CANCELLED mid-encode even though the app kept running.
   */
  installLifecycleHooks(app: {
    on(event: string, listener: (...args: unknown[]) => void): void
  }): void {
    const kill = (): void => this.killAll()
    app.on('before-quit', kill)
    app.on('will-quit', kill)
    process.once('SIGINT', kill)
    process.once('SIGTERM', kill)
  }
}

// ============================================================================
// Default limiter (no external dep) — used by tests and as a safe fallback.
// Production should pass `createPQueueLimiterFactory()` (below) for fairness.
// ============================================================================

export function defaultArrayLimiterFactory(concurrency: number): Limiter {
  let activeCount = 0
  const queue: Array<() => void> = []
  const pump = (): void => {
    while (activeCount < concurrency && queue.length > 0) {
      const run = queue.shift()!
      activeCount += 1
      run()
    }
  }
  return {
    get pending(): number {
      return queue.length
    },
    add<T>(task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const run = (): void => {
          // `Promise.resolve().then(task)` so a SYNCHRONOUS throw from `task()` becomes
          // a rejected promise (audit fix openclip-40a): otherwise the throw escapes
          // `run()` before `.finally` attaches, `activeCount` is never decremented, and
          // that kind's slot is permanently consumed — starving every later job of the
          // kind. The wrapper guarantees the `.finally` (decrement + pump) always runs.
          Promise.resolve()
            .then(task)
            .then(resolve, reject)
            .finally(() => {
              activeCount -= 1
              pump()
            })
        }
        queue.push(run)
        pump()
      })
    }
  }
}

/**
 * Production limiter factory backed by p-queue (ESM). Imported dynamically so
 * the manager stays unit-testable without pulling the ESM-only dependency into
 * a CJS test context. Wired in `main/index.ts`.
 */
export async function createPQueueLimiterFactory(): Promise<(c: number) => Limiter> {
  const { default: PQueue } = await import('p-queue')
  return (concurrency: number): Limiter => {
    const q = new PQueue({ concurrency })
    return {
      get pending(): number {
        return q.size
      },
      add<T>(task: () => Promise<T>): Promise<T> {
        // p-queue's add returns Promise<T | void>; our tasks always resolve T.
        return q.add(task) as Promise<T>
      }
    }
  }
}
