/**
 * src/main/ipc/audio.ts — audio control-plane handlers (STUB).
 *
 * Owned later by T-Media (E.3): wires AUDIO_EXTRACT (FFmpeg 16kHz mono WAV,
 * PRD §6.1). The trunk leaves the body empty so the hub registry compiles.
 */

import type { IpcContext } from './index'

export function registerAudioHandlers(ctx: IpcContext): void {
  void ctx
  // TODO(T-Media): ctx.ipcMain.handle(IPCChannels.AUDIO_EXTRACT, …)
}
