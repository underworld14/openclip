/**
 * src/renderer/src/hooks/jobPort.ts — the per-job MessagePort REGISTRY (TRUNK
 * INFRA). Pairs each LIVE per-job `MessagePort` (delivered out-of-band by the
 * main process) to the `jobId` returned by `window.openclip.jobs.start()`.
 *
 * WHY this exists (the contextBridge blocker fix): a `MessagePort` cannot be
 * returned across `contextBridge.exposeInMainWorld` (the bridge clones+freezes
 * return values into a dead Object). So `jobs.start()` returns `{ jobId }` only,
 * and the main process TRANSFERS the live port to the renderer's MAIN world (via
 * `MessageChannelMain` → `senderFrame.postMessage(JOB_PORT)` → the preload's
 * `window.postMessage(…, [port])` forwarder). This module receives those live
 * ports on `window`'s `message` event and resolves `acquireJobPort(jobId)` with
 * the matching one — buffering for EITHER arrival order (port-before-waiter or
 * waiter-before-port).
 *
 * Framework-free + environment-agnostic so it is unit-testable: the `window`
 * listener is installed lazily only when a `window` exists, and tests (or the
 * mock bridge) can push a port straight in via `registerJobPort(jobId, port)`.
 */

import type { MessagePortLike } from './useJob'

/** The tag the preload forwarder stamps on each main-world port message. */
export const JOB_PORT_MESSAGE = 'openclip:job-port' as const

interface JobPortMessage {
  __openclip: typeof JOB_PORT_MESSAGE
  jobId: string
}

function isJobPortMessage(v: unknown): v is JobPortMessage {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { __openclip?: unknown }).__openclip === JOB_PORT_MESSAGE &&
    typeof (v as { jobId?: unknown }).jobId === 'string'
  )
}

// Ports that have arrived but not yet been claimed, and waiters that are blocked
// on a jobId whose port hasn't arrived yet. Exactly one side is non-empty per id.
const ready = new Map<string, MessagePortLike>()
const waiters = new Map<string, (port: MessagePortLike) => void>()

/**
 * Register a live per-job port under its jobId. Called by the `window` message
 * listener in production and directly by the mock bridge / tests. If a consumer
 * is already awaiting this jobId, it is resolved immediately.
 */
export function registerJobPort(jobId: string, port: MessagePortLike): void {
  const waiter = waiters.get(jobId)
  if (waiter) {
    waiters.delete(jobId)
    waiter(port)
    return
  }
  ready.set(jobId, port)
}

/**
 * Resolve with the LIVE `MessagePort` for `jobId`, whether it has already
 * arrived (claimed from the buffer) or arrives later (a waiter is parked). The
 * returned port is a real DOM `MessagePort` (has `postMessage`/`onmessage`),
 * never a cloned Object — that is the whole point of the out-of-band transfer.
 */
export function acquireJobPort(jobId: string, timeoutMs = 30_000): Promise<MessagePortLike> {
  ensureWindowListener()
  const existing = ready.get(jobId)
  if (existing) {
    ready.delete(jobId)
    return Promise.resolve(existing)
  }
  return new Promise<MessagePortLike>((resolve, reject) => {
    const wrappedResolve = (port: MessagePortLike): void => {
      clearTimeout(timer)
      resolve(port)
    }
    // Bounded wait (audit fix openclip-ki6/me0/jp1): the per-job port is delivered on
    // the SAME tick as the `jobs.start()` invoke response, so any real delay means it
    // is GONE — e.g. main/index.ts drops the port when `event.senderFrame` is null
    // (frame destroyed/navigated mid-invoke). Without this, every consumer
    // `await acquireJobPort(jobId)` hangs FOREVER (stuck progress bar, busy:true, a
    // Promise.all that never settles) — violating the "never a silent hang" spirit.
    // Reject + clear the parked waiter so the consumer surfaces a typed error instead.
    const timer = setTimeout(() => {
      if (waiters.get(jobId) === wrappedResolve) waiters.delete(jobId)
      reject(
        new Error(
          `job ${jobId}: per-job MessagePort never arrived (timed out after ${timeoutMs}ms) — the job stream cannot be consumed`
        )
      )
    }, timeoutMs)
    waiters.set(jobId, wrappedResolve)
  })
}

let listenerInstalled = false
/**
 * Attach the main-world `message` listener (idempotent; no-op outside a browser).
 *
 * Called at MODULE LOAD, not lazily on first use. It used to run only from inside
 * `acquireJobPort`, which quietly broke the port-before-waiter half of this
 * registry's contract: for the FIRST job on a page nobody had called
 * `acquireJobPort` yet, so no listener existed, so the preload's forwarded
 * `window.postMessage` was dropped and `ready` stayed empty — the consumer then
 * waited out the full 30s timeout and the job stream was unconsumable.
 *
 * It is a genuine race, not a theoretical one: main transfers the port BEFORE the
 * JOB_START invoke returns (main/index.ts:245), so whether the port beats the
 * renderer's `await jobs.start()` continuation depends on machine load. It
 * surfaced as an intermittent CI hang on whichever E2E happened to start the
 * first transcribe of its app instance (BUG-zcqyb7).
 *
 * Installing at import time is safe and cheap: this module is pulled in by
 * `useJob`/`import-pipeline` during app startup, long before any job can start,
 * and the listener ignores every message that isn't a tagged port handoff.
 */
function ensureWindowListener(): void {
  if (listenerInstalled) return
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
  listenerInstalled = true
  window.addEventListener('message', (event: MessageEvent) => {
    if (!isJobPortMessage(event.data)) return
    const [port] = event.ports
    if (port) registerJobPort(event.data.jobId, port as unknown as MessagePortLike)
  })
}

// Install eagerly — see above. `acquireJobPort` still calls it defensively for
// the case where this module is imported before a `window` exists.
ensureWindowListener()

/** TEST-ONLY: clear any buffered ports/waiters between tests. */
export function __resetJobPortRegistry(): void {
  ready.clear()
  waiters.clear()
}
