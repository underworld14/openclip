/**
 * src/main/ipc/transcribe.ts — transcription job wiring (STUB).
 *
 * Owned later by T-Media (E.3): registers the `transcribe` runner with the
 * sidecar (`ctx.sidecar`) so JOB_START('transcribe', …) spawns whisper-cli and
 * streams progress/partial segments over the per-job MessagePort (PRD §6.2 /
 * §10.2). The trunk leaves the body empty so the hub registry compiles.
 */

import type { IpcContext } from './index'

export function registerTranscribeHandlers(ctx: IpcContext): void {
  void ctx
  // TODO(T-Media): registerRunner('transcribe', transcribeRunner) on ctx.sidecar
}
