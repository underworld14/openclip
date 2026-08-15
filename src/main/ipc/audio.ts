/**
 * src/main/ipc/audio.ts — audio job wiring (T-Media, E.3; moved onto the job
 * plane at EPIC-k83ghw / BUG-sg6kqg).
 *
 * Registers the `extract-audio` runner with the sidecar (the startup seam, E.3:
 * main/index.ts loops HANDLER_REGISTRARS at init). `JOB_START('extract-audio',
 * { projectId, sourcePath })` probes the source, extracts a 16kHz mono WAV via
 * FFmpeg (content-addressed cached, PRD §17), and streams real progress with
 * the ffmpeg PID tracked for cooperative cancel + kill-on-quit.
 *
 * There is no request/response extract channel — like `transcribe`, extraction
 * is a streaming job by contract (jobs.ts), so this registrar only plugs in
 * the runner. It used to be a plain `invoke` (`audio:extract`): no progress, no
 * PID tracking, no cancel — see BUG-sg6kqg for the user-facing symptom.
 */

import type { IpcContext } from './index'
import { registerRunner, hasRunner } from '@main/services/sidecar-manager'
import { extractAudioRunner } from '@main/services/jobs/extract-audio-runner'

export function registerAudioHandlers(ctx: IpcContext): void {
  void ctx
  // Plug the runner into the sidecar's JOB_RUNNERS registry (startup seam, E.4).
  // Guarded so a re-registration (e.g. test re-import) doesn't throw.
  if (!hasRunner('extract-audio')) registerRunner('extract-audio', extractAudioRunner)
}
