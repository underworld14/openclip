/**
 * src/main/ipc/model.ts — whisper model status/download handlers (STUB).
 *
 * Owned later by T-Media (E.3): wires MODEL_STATUS (presence on disk) and
 * MODEL_DOWNLOAD (kicks off a streaming `model-download` job via the sidecar,
 * PRD §13). The trunk leaves the body empty so the hub registry compiles.
 */

import type { IpcContext } from './index'

export function registerModelHandlers(ctx: IpcContext): void {
  void ctx
  // TODO(T-Media): ctx.ipcMain.handle(IPCChannels.MODEL_STATUS, …)
}
