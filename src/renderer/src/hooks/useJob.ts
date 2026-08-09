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
 *   - `drainJob(...)` — the single consumer loop every orchestrator drives.
 *
 * The `useJob` React hook this file is NAMED for is gone (see the note further
 * down); the filename is kept because every orchestrator imports `drainJob`
 * from it and a rename would be churn for its own sake.
 *
 * Both are deliberately framework-free so they can be unit-tested over a real
 * Node `MessageChannel` driven by the fake-utilityProcess harness (Gate A:
 * "a scripted job over a real MessagePort drives a job to a 'done' event").
 */

import type { JobKind, JobParams, JobResult, JobPartial, JobEventFor } from '@shared/jobs'
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
  removeEventListener?: (type: 'message', listener: (ev: { data: unknown }) => void) => void
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
    // Detach the listener SYMMETRICALLY (audit fix openclip-2g3/vet): the generator
    // previously relied solely on port.close() to make the listener collectable, but
    // an add without a matching remove is a latent leak if a long-lived/shared port is
    // ever passed (today each job gets a fresh port). Remove, then close.
    if (port.removeEventListener) port.removeEventListener('message', handler)
    else port.onmessage = null
    port.close?.()
  }
}

// ============================================================================
// drainJob — the one streaming-job consumer (audit fix openclip-60b)
// ============================================================================

/** Bridge surface derived from the global `window.openclip` typing. */
type OpenClipBridge = typeof window.openclip

export interface DrainJobCallbacks<K extends JobKind> {
  /** The assigned jobId, right after start (so callers can track/cancel it). */
  onStart?: (jobId: string) => void
  /** 0..100 progress + stage from `{t:'progress'}` events. */
  onProgress?: (pct: number, stage: string) => void
  /** Streamed partials (e.g. transcript words, download bytes) from `{t:'partial'}`. */
  onPartial?: (data: JobPartial[K]) => void
}

/**
 * The single streaming-job drain loop (audit fix openclip-60b): start the job, pair the
 * out-of-band MessagePort, drive `jobEvents` to the terminal event, and enforce the
 * job-termination invariant (PRD §10.2 — every job ends with `done` xor `error`, never a
 * silent hang). Previously runExport / runModelDownload / runUrlDownload / the transcribe
 * tail each repeated this skeleton verbatim and had to keep the error-string format and
 * the result guard in sync by hand. Per-job specifics (progress banding, on-done side
 * effects like onTranscript) stay in the caller, which wires the callbacks and post-
 * processes the returned result. Throws `<kind> failed [code]: message` on a terminal
 * error and `<kind> ended without a result` if the stream closed with no `done`.
 */
export async function drainJob<K extends JobKind>(
  bridge: OpenClipBridge,
  kind: K,
  params: JobParams[K],
  cbs: DrainJobCallbacks<K> = {}
): Promise<JobResult[K]> {
  const { jobId } = await bridge.jobs.start(kind, params)
  cbs.onStart?.(jobId)
  const port = await acquireJobPort(jobId)
  let result: JobResult[K] | null = null
  for await (const ev of jobEvents<K>(port)) {
    switch (ev.t) {
      case 'progress':
        cbs.onProgress?.(ev.pct, ev.stage)
        break
      case 'partial':
        cbs.onPartial?.(ev.data)
        break
      case 'done':
        result = ev.result
        break
      case 'error':
        throw new Error(`${kind} failed [${ev.code}]: ${ev.message}`)
    }
  }
  if (result === null) throw new Error(`${kind} ended without a result`)
  return result
}

// ============================================================================
// Job status vocabulary
// ============================================================================

/**
 * The `useJob` React hook that used to live here has been REMOVED (EPIC-zpa1nd),
 * as its own doc note anticipated: it existed to feed `uiStore.tasks` for a
 * global job-queue UI that did not exist, and it had zero call sites — every
 * shipping surface drives jobs through `drainJob` above. That UI now exists
 * (`JobStatusBar` over `stores/jobsStore`), and it tracks at the ORCHESTRATOR
 * level rather than per-job, because one user-visible activity (an import) spans
 * several jobs and invokes. A per-job React hook was the wrong seam for it.
 *
 * This type survives the hook: `jobsStore` reuses the same vocabulary.
 */
export type JobStatus = 'idle' | 'queued' | 'running' | 'done' | 'error'
