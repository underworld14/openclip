/**
 * src/main/ipc/transcribe.ts — transcription job wiring (T-Media, E.3).
 *
 * Registers the `transcribe` runner with the sidecar (the startup seam, E.3:
 * main/index.ts loops HANDLER_REGISTRARS at init). Once registered,
 * `JOB_START('transcribe', { projectId, wavPath, model, language? })` spawns
 * whisper-cli and streams progress + per-word/segment partials over the per-job
 * MessagePort, terminating with the parsed transcript as `done` (PRD §6.2/§10.2).
 *
 * There is no request/response transcribe channel — transcription is a streaming
 * job by contract (jobs.ts), so this registrar only plugs in the runner.
 */

import type { IpcContext } from './index'
import { registerRunner, hasRunner } from '@main/services/sidecar-manager'
import { transcribeRunner } from '@main/services/jobs/transcribe-runner'

export function registerTranscribeHandlers(ctx: IpcContext): void {
  void ctx
  // Plug the runner into the sidecar's JOB_RUNNERS registry (startup seam, E.4).
  // Guarded so a re-registration (e.g. test re-import) doesn't throw.
  if (!hasRunner('transcribe')) registerRunner('transcribe', transcribeRunner)
}
