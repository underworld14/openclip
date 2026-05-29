/**
 * preload/api/jobs.ts — `window.openclip.jobs` (the streaming-job surface).
 *
 * TRUNK INFRA, frozen seam (plan E.4). This is REAL (not a stub): it implements
 * the MessagePort-per-job handoff exactly as the main side expects
 * (`wireJobControlPlane` in main/index.ts) and per Electron's verified API —
 * `MessagePort`s cannot ride `invoke`, only `ipcRenderer.postMessage(channel,
 * msg, [port])` (PRD §10.2 / Electron message-ports tutorial):
 *
 *   1. open a `MessageChannel`; keep `port1`, transfer `port2` to main;
 *   2. main starts the job and posts `{ t:'job-id', jobId }` as the first
 *      message on the port; we resolve `start()` with `{ jobId, port: port1 }`;
 *   3. subsequent `JobEvent`s stream on `port1` and are consumed by `useJob`'s
 *      `jobEvents()` async iterable.
 *
 * `cancel(jobId)` stays a plain `invoke` so it can never be starved by a busy
 * data port (PRD §10.2).
 */

import { ipcRenderer } from 'electron'
import { IPCChannels } from '@shared/channels'
import type { JobKind, JobParams, JobsAPI } from '@shared/jobs'

interface JobIdEnvelope {
  t: 'job-id'
  jobId: string
}

function isJobIdEnvelope(v: unknown): v is JobIdEnvelope {
  return typeof v === 'object' && v !== null && (v as { t?: unknown }).t === 'job-id'
}

export function buildJobsApi(): JobsAPI {
  return {
    start<K extends JobKind>(
      kind: K,
      params: JobParams[K]
    ): Promise<{ jobId: string; port: MessagePort }> {
      const { port1, port2 } = new MessageChannel()
      return new Promise((resolve) => {
        const onFirst = (ev: MessageEvent): void => {
          if (isJobIdEnvelope(ev.data)) {
            port1.removeEventListener('message', onFirst)
            resolve({ jobId: ev.data.jobId, port: port1 })
          }
        }
        port1.addEventListener('message', onFirst)
        port1.start()
        // Transfer the peer port to main with the job request.
        ipcRenderer.postMessage(IPCChannels.JOB_START, { kind, params }, [port2])
      })
    },
    async cancel(jobId: string): Promise<void> {
      await ipcRenderer.invoke(IPCChannels.JOB_CANCEL, { jobId })
    }
  }
}
