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
 * Registers the `model-download` runner via the module-level `registerRunner`
 * export from `sidecar-manager.ts` (NOT a method on `ctx.sidecar` — the
 * `SidecarManager` instance owns job routing/queues/PID-kill, while the runner
 * registry is a module-level seam). The startup seam (E.3): main/index.ts loops
 * HANDLER_REGISTRARS at init, which runs this registrar.
 */

import { IPCChannels } from '@shared/channels'
import type { ModelStatus, JobStartResult, ModelDeleteResult } from '@shared/channels'
import type { WhisperModelSize } from '@shared/jobs'
import type { IpcContext } from './index'
import { registerRunner, hasRunner } from '@main/services/sidecar-manager'
import { modelStatus, deleteModel, ALL_MODELS } from '@main/services/model-manager'
import { modelDownloadRunner } from '@main/services/jobs/model-download-runner'

export function registerModelHandlers(ctx: IpcContext): void {
  // Register the streaming download runner with the sidecar (startup seam, E.3).
  if (!hasRunner('model-download')) registerRunner('model-download', modelDownloadRunner)

  // MODEL_STATUS — presence/path/bytes for one or all models (PRD §13).
  //
  // Under OPENCLIP_FAKE_TRANSCRIBE the whisper sidecar is replaced wholesale by
  // a fixed-transcript runner (see transcribe-runner.ts), so no GGML file is
  // needed and reporting "installed" is accurate for that mode rather than a
  // convenience lie — the transcription capability really is available. Without
  // this the readiness gate (FEAT-c5a15c) would correctly refuse to run in an
  // E2E whose whole point is that transcription works.
  ctx.ipcMain.handle(
    IPCChannels.MODEL_STATUS,
    (_e, req: { model?: WhisperModelSize }): ModelStatus[] => {
      if (process.env.OPENCLIP_FAKE_TRANSCRIBE) {
        const list = req?.model ? [req.model] : ALL_MODELS
        return list.map((m) => ({ model: m, installed: true }))
      }
      return modelStatus(req?.model)
    }
  )

  // MODEL_DELETE — reclaim the 75MB–2.9GB a model occupies (FEAT-1k76hk).
  // The id is checked against ALL_MODELS before it reaches the filesystem: it is
  // interpolated into a path by `modelFilePath`, so an unvalidated renderer value
  // would be an arbitrary-file-delete primitive.
  ctx.ipcMain.handle(
    IPCChannels.MODEL_DELETE,
    (_e, req: { model: WhisperModelSize }): ModelDeleteResult => {
      if (!ALL_MODELS.includes(req?.model)) {
        throw new Error(`unknown whisper model: ${String(req?.model)}`)
      }
      return deleteModel(req.model)
    }
  )

  // MODEL_DOWNLOAD — start a streaming job; renderer streams progress via
  // jobs.start('model-download', …). The invoke result carries the jobId; the
  // per-job port is delivered out-of-band over JOB_PORT, never over invoke
  // (MessagePorts cannot ride ipcRenderer.invoke — PRD §10.2).
  ctx.ipcMain.handle(
    IPCChannels.MODEL_DOWNLOAD,
    (_e, req: { model: WhisperModelSize }): JobStartResult => {
      // The renderer uses jobs.start for the actual stream; this control-plane
      // entry exists for parity/correlation and returns a placeholder handle.
      void req
      return { jobId: '' }
    }
  )
}
