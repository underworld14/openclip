/**
 * src/renderer/src/hooks/useJob.ts — wrap a per-job MessagePort as an
 * `AsyncIterable<JobEventFor<K>>` (TRUNK INFRA, frozen after Stage 3 — E.2/E.4).
 *
 * The renderer starts a job via `window.openclip.jobs.start(kind, params)`,
 * which resolves `{ jobId }`; the LIVE per-job `MessagePort` is acquired
 * out-of-band via `acquireJobPort(jobId)` (hooks/jobPort.ts — the contextBridge
 * blocker fix). This module turns that port into:
 *   - `jobEvents(port)` — a pure `AsyncIterable` of typed events, terminating
 *     after the first `done|error` (the job-termination invariant, PRD §10.2);
 *   - `useJob(kind)` — a React hook exposing `{ start, cancel, progress, stage,
 *     status, result, error }`, feeding the `uiStore.tasks` map as it streams.
 *
 * `jobEvents` is deliberately framework-free so it can be unit-tested over a
 * real Node `MessageChannel` driven by the fake-utilityProcess harness (Gate A:
 * "a scripted job over a real MessagePort drives useJob to a 'done' event").
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { JobKind, JobParams, JobResult, JobEventFor, JobErrorCode } from '@shared/jobs'
import { acquireJobPort } from './jobPort'

// ============================================================================
// The structural port we consume (works for DOM MessagePort and Node's).
// ============================================================================

/** Minimal port surface: receive messages, optionally start, optionally close. */
export interface MessagePortLike {
  onmessage: ((ev: { data: unknown }) => void) | null
  start?: () => void
  close?: () => void
  addEventListener?: (type: 'message', listener: (ev: { data: unknown }) => void) => void
}

/** A control message the host may send before/around job events. */
interface JobIdMessage {
  t: 'job-id'
  jobId: string
}

function isJobIdMessage(v: unknown): v is JobIdMessage {
  return typeof v === 'object' && v !== null && (v as { t?: unknown }).t === 'job-id'
}

function isTerminal<K extends JobKind>(ev: JobEventFor<K>): boolean {
  return ev.t === 'done' || ev.t === 'error'
}

// ============================================================================
// jobEvents — MessagePort → AsyncIterable<JobEventFor<K>> (pure, testable)
// ============================================================================

/**
 * Adapt a per-job port into an async iterable of typed `JobEventFor<K>`. The
 * iterator completes after the first terminal (`done`|`error`) event; the
 * non-control `job-id` envelope is skipped. Back-pressure-safe: events arriving
 * before the consumer pulls are buffered.
 */
export async function* jobEvents<K extends JobKind>(
  port: MessagePortLike
): AsyncGenerator<JobEventFor<K>, void, void> {
  const buffer: JobEventFor<K>[] = []
  let resolveNext: (() => void) | null = null
  let finished = false

  const push = (ev: JobEventFor<K>): void => {
    buffer.push(ev)
    if (isTerminal(ev)) finished = true
    resolveNext?.()
    resolveNext = null
  }

  const handler = (msg: { data: unknown }): void => {
    const data = msg.data
    if (isJobIdMessage(data)) return // control envelope, not a JobEvent
    push(data as JobEventFor<K>)
  }

  if (port.addEventListener) port.addEventListener('message', handler)
  else port.onmessage = handler
  port.start?.()

  try {
    while (true) {
      if (buffer.length === 0) {
        if (finished) return
        await new Promise<void>((resolve) => {
          resolveNext = resolve
        })
      }
      while (buffer.length > 0) {
        const ev = buffer.shift()!
        yield ev
        if (isTerminal(ev)) return
      }
    }
  } finally {
    port.close?.()
  }
}

// ============================================================================
// useJob — React hook around jobEvents, wired to the bridge + uiStore tasks.
// ============================================================================

export type JobStatus = 'idle' | 'queued' | 'running' | 'done' | 'error'

export interface UseJobState<K extends JobKind> {
  /** Start the job; streams progress/partial then resolves on done|error. */
  start: (params: JobParams[K]) => Promise<void>
  /** Cooperatively cancel the in-flight job. */
  cancel: () => Promise<void>
  jobId: string | null
  status: JobStatus
  progress: number
  stage: string
  result: JobResult[K] | null
  error: { code: JobErrorCode; message: string; retriable: boolean } | null
}

/**
 * Optional hooks for the caller / store, so `uiStore` can be fed the task map
 * (plan: `tasks: Record<jobId,{kind,progress,status}>` fed by job ports).
 */
export interface UseJobOptions<K extends JobKind> {
  onPartial?: (data: Extract<JobEventFor<K>, { t: 'partial' }>['data']) => void
  onTask?: (task: { jobId: string; kind: K; progress: number; status: JobStatus }) => void
}

/**
 * RESERVED, NOT YET WIRED (audit note openclip-dz5). The shipping components drive
 * jobs through the pure `jobEvents()` generator directly (import-pipeline, export-run,
 * model-download); this React hook + its `onTask` seam feed `uiStore.tasks`, which is
 * currently WRITTEN but never READ by any component — the global job-queue/progress UI
 * it was designed for doesn't exist yet. Kept as a deliberate trunk seam for that
 * future UI; do not mistake it for live runtime plumbing. Delete this + the
 * `uiStore.tasks` map if the queue UI is dropped from the roadmap.
 */
export function useJob<K extends JobKind>(kind: K, options: UseJobOptions<K> = {}): UseJobState<K> {
  const [jobId, setJobId] = useState<string | null>(null)
  const [status, setStatus] = useState<JobStatus>('idle')
  const [progress, setProgress] = useState(0)
  const [stage, setStage] = useState('')
  const [result, setResult] = useState<JobResult[K] | null>(null)
  const [error, setError] = useState<UseJobState<K>['error']>(null)
  const jobIdRef = useRef<string | null>(null)
  const progressRef = useRef(0)
  const optionsRef = useRef(options)
  // Keep the latest options/progress reachable from the streaming loop without
  // writing refs during render (react-hooks: no ref access in render body).
  useEffect(() => {
    optionsRef.current = options
  }, [options])
  useEffect(() => {
    progressRef.current = progress
  }, [progress])

  const start = useCallback(
    async (params: JobParams[K]): Promise<void> => {
      setStatus('running')
      setError(null)
      setResult(null)
      let id: string
      let port: MessagePortLike
      try {
        id = (await window.openclip.jobs.start(kind, params)).jobId
        setJobId(id)
        jobIdRef.current = id
        // Acquire the LIVE per-job port (delivered out-of-band, keyed by jobId).
        port = await acquireJobPort(id)
      } catch (e) {
        // jobs.start() / acquireJobPort() rejected (e.g. the per-job port never arrived,
        // openclip-ki6) — surface a terminal error instead of leaving status stuck on
        // 'running' forever (audit fix openclip-73y).
        setStatus('error')
        setError({
          code: 'SIDECAR_CRASH',
          message: e instanceof Error ? e.message : String(e),
          retriable: true
        })
        return
      }
      const emitTask = (s: JobStatus, p: number): void =>
        optionsRef.current.onTask?.({ jobId: id, kind, progress: p, status: s })

      for await (const ev of jobEvents<K>(port)) {
        switch (ev.t) {
          case 'progress': {
            const s: JobStatus = ev.stage === 'queued' ? 'queued' : 'running'
            setStatus(s)
            setProgress(ev.pct)
            setStage(ev.stage)
            emitTask(s, ev.pct)
            break
          }
          case 'partial':
            optionsRef.current.onPartial?.((ev as Extract<JobEventFor<K>, { t: 'partial' }>).data)
            break
          case 'done':
            setStatus('done')
            setProgress(100)
            setResult((ev as Extract<JobEventFor<K>, { t: 'done' }>).result)
            emitTask('done', 100)
            break
          case 'error':
            setStatus('error')
            setError({ code: ev.code, message: ev.message, retriable: ev.retriable })
            emitTask('error', progressRef.current)
            break
        }
      }
    },
    [kind]
  )

  const cancel = useCallback(async (): Promise<void> => {
    const id = jobIdRef.current
    if (id) await window.openclip.jobs.cancel(id)
  }, [])

  return { start, cancel, jobId, status, progress, stage, result, error }
}
