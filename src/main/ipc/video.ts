/**
 * src/main/ipc/video.ts — video control-plane handlers (STUB + fake-mode seam).
 *
 * Owned later by the spine/T tracks (E.3/E.5): wires IMPORT_VIDEO,
 * IMPORT_FROM_URL, EXPORT_CLIP, and system folder/save dialogs. The trunk leaves
 * the REAL bodies for the spine track; it provides ONLY a binary-free fake-mode
 * IMPORT_VIDEO handler (gated on OPENCLIP_FAKE_TRANSCRIBE) so the integration
 * Wave-1 E2E can drive import→…→export over the real main process without a
 * media file or ffprobe. This does not touch the real contract — when the env
 * flag is unset, the channel remains unregistered for the spine track to fill.
 */

import { IPCChannels } from '@shared/channels'
import type { ImportVideoResult } from '@shared/channels'
import type { IpcContext } from './index'

export function registerVideoHandlers(ctx: IpcContext): void {
  // Fake-sidecar mode (plan E.10): a fixed, schema-valid SourceVideo so the
  // integration E2E can import without ffprobe / a real file.
  if (process.env.OPENCLIP_FAKE_TRANSCRIBE) {
    ctx.ipcMain.handle(
      IPCChannels.IMPORT_VIDEO,
      (_e, req: { filePath: string }): ImportVideoResult => ({
        sourceVideo: {
          path: req.filePath,
          duration: 240,
          resolution: { width: 1920, height: 1080 },
          fps: 30,
          format: 'mp4'
        }
      })
    )
    return
  }
  // TODO(spine): ctx.ipcMain.handle(IPCChannels.IMPORT_VIDEO, …) etc.
}
