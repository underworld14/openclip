/**
 * src/main/ipc/media.ts — media control-plane handler (Part H).
 *
 * `MEDIA_ADOPT_SOURCE` moves a just-downloaded source file into the persistent,
 * app-owned store `<userData>/media/<projectId>/` so it survives OS temp cleanup
 * and is reclaimed with the project. The renderer (import-controller) calls this
 * for URL/YouTube imports only; file imports keep the user's original path.
 *
 * Trust boundary: `projectId` becomes a path segment, so it's validated (no
 * separators / `..`) by `adoptIntoMedia` before any filesystem write.
 */

import { IPCChannels } from '@shared/channels'
import type { ChannelReq, ChannelRes } from '@shared/channels'
import { mediaDir } from '@main/utils/paths'
import { adoptIntoMedia, deleteProjectMedia } from '@main/services/media-store'
import type { IpcContext } from './index'

export function registerMediaHandlers(ctx: IpcContext): void {
  ctx.ipcMain.handle(
    IPCChannels.MEDIA_ADOPT_SOURCE,
    async (
      _e,
      req: ChannelReq<IPCChannels.MEDIA_ADOPT_SOURCE>
    ): Promise<ChannelRes<IPCChannels.MEDIA_ADOPT_SOURCE>> => {
      const path = await adoptIntoMedia(req.filePath, req.projectId, mediaDir())
      return { path }
    }
  )

  // Reclaim a project's adopted media dir immediately (openclip-e5s). `projectId` is
  // validated as a single path segment by deleteProjectMedia before any fs write.
  ctx.ipcMain.handle(
    IPCChannels.MEDIA_RECLAIM,
    async (
      _e,
      req: ChannelReq<IPCChannels.MEDIA_RECLAIM>
    ): Promise<ChannelRes<IPCChannels.MEDIA_RECLAIM>> => {
      const { deleted } = await deleteProjectMedia(req.projectId, mediaDir())
      return { reclaimed: deleted }
    }
  )
}
