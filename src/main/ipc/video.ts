/**
 * src/main/ipc/video.ts — video control-plane handlers (STUB).
 *
 * Owned later by the spine/T tracks (E.3/E.5): wires IMPORT_VIDEO,
 * IMPORT_FROM_URL, EXPORT_CLIP, and system folder/save dialogs. The trunk
 * leaves the body empty so the hub registry compiles; tracks fill it in.
 */

import type { IpcContext } from './index'

export function registerVideoHandlers(ctx: IpcContext): void {
  void ctx
  // TODO(spine): ctx.ipcMain.handle(IPCChannels.IMPORT_VIDEO, …) etc.
}
