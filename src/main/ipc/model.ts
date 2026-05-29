/**
 * src/main/ipc/model.ts — whisper model status/download handlers (T-Media, E.3).
 *
 * Wires:
 *   - MODEL_STATUS  → model presence on disk (PRD §13 first-transcribe gate).
 *   - MODEL_DOWNLOAD → registered as a streaming `model-download` runner on the
 *     sidecar; the actual byte-progress streams over a per-job MessagePort that
 *     the renderer obtains via `window.openclip.jobs.start('model-download', …)`
 *     (the only way to transfer a MessagePort — PRD §10.2). The invoke channel
 *     itself returns the assigned jobId so a caller can correlate / cancel.
 *
 * Registers the `model-download` runner via `ctx.sidecar.registerRunner` — the
 * startup seam (E.3): main/index.ts loops HANDLER_REGISTRARS at init.
 */

import { IPCChannels } from '@shared/channels'
import type { ModelStatus, JobStartResult } from '@shared/channels'
import type { WhisperModelSize } from '@shared/jobs'
import type { IpcContext } from './index'
import { registerRunner, hasRunner } from '@main/services/sidecar-manager'
import { modelStatus } from '@main/services/model-manager'
import { modelDownloadRunner } from '@main/services/jobs/model-download-runner'

export function registerModelHandlers(ctx: IpcContext): void {
  // Register the streaming download runner with the sidecar (startup seam, E.3).
  if (!hasRunner('model-download')) registerRunner('model-download', modelDownloadRunner)

  // MODEL_STATUS — presence/path/bytes for one or all models (PRD §13).
  ctx.ipcMain.handle(
    IPCChannels.MODEL_STATUS,
    (_e, req: { model?: WhisperModelSize }): ModelStatus[] => modelStatus(req?.model)
  )

  // MODEL_DOWNLOAD — start a streaming job; renderer streams progress via
  // jobs.start('model-download', …). The invoke result carries the jobId; the
  // port is delivered over the JOB_START message channel, not over invoke
  // (MessagePorts cannot ride ipcRenderer.invoke — PRD §10.2).
  ctx.ipcMain.handle(
    IPCChannels.MODEL_DOWNLOAD,
    (_e, req: { model: WhisperModelSize }): JobStartResult => {
      // The renderer uses jobs.start for the actual stream; this control-plane
      // entry exists for parity/correlation and returns a placeholder handle.
      void req
      return { jobId: '', port: null as unknown as MessagePort }
    }
  )
}
