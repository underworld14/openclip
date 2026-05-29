/**
 * preload/api/jobs.ts — `window.openclip.jobs` (the streaming-job surface).
 *
 * TRUNK INFRA, frozen seam (plan E.4). The MessagePort-per-job handoff is the
 * contextIsolation-safe Electron 41 pattern (verified via the Electron
 * message-ports tutorial / `MessageChannelMain` API, PRD §10.2):
 *
 *   1. `start(kind, params)` is a plain `invoke(JOB_START)` returning `{ jobId }`
 *      ONLY. A `MessagePort` is a transferable — it can NEITHER ride
 *      `ipcRenderer.invoke` NOR be returned across `contextBridge` (the bridge
 *      structure-clones+freezes return values into a dead plain Object with no
 *      `postMessage`/`onmessage`). So we never try to return it.
 *   2. The MAIN side opens a `MessageChannelMain`, keeps `port1` (fed by the
 *      sidecar runner) and TRANSFERS `port2` to this frame via
 *      `senderFrame.postMessage(JOB_PORT, {jobId}, [port2])`.
 *   3. `installJobPortForwarder()` (called once from preload/index.ts) listens
 *      for that on the ISOLATED world and forwards the LIVE port into the
 *      renderer's MAIN world with `window.postMessage(…, [port])` — the
 *      supported isolated→main transfer (it stays a real MessagePort, not a
 *      cloned Object). The renderer pairs it to the jobId (hooks/jobPort.ts).
 *
 * `cancel(jobId)` stays a plain `invoke` so it can never be starved by a busy
 * data port (PRD §10.2).
 */

import { ipcRenderer } from 'electron'
import { IPCChannels } from '@shared/channels'
import type { JobKind, JobParams, JobsAPI } from '@shared/jobs'

/** The window-message tag the main world listens for to pair the live port. */
export const JOB_PORT_MESSAGE = 'openclip:job-port' as const

/**
 * Install the one-time bridge that forwards each transferred per-job
 * `MessagePort` from the isolated (preload) world into the renderer's MAIN
 * world. Called once from `preload/index.ts` at preload init. Idempotent.
 *
 * The transferred ports arrive on `event.ports`; re-transferring them via
 * `window.postMessage(msg, '*', event.ports)` hands a LIVE `MessagePort` to the
 * main world's `window.addEventListener('message', …)` (DOM `MessageEvent.ports`).
 */
let installed = false
export function installJobPortForwarder(): void {
  if (installed) return
  installed = true
  ipcRenderer.on(IPCChannels.JOB_PORT, (event, msg: { jobId: string }) => {
    window.postMessage({ __openclip: JOB_PORT_MESSAGE, jobId: msg.jobId }, '*', event.ports)
  })
}

export function buildJobsApi(): JobsAPI {
  return {
    async start<K extends JobKind>(kind: K, params: JobParams[K]): Promise<{ jobId: string }> {
      return ipcRenderer.invoke(IPCChannels.JOB_START, { kind, params }) as Promise<{
        jobId: string
      }>
    },
    async cancel(jobId: string): Promise<void> {
      await ipcRenderer.invoke(IPCChannels.JOB_CANCEL, { jobId })
    }
  }
}
