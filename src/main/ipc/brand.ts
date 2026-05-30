/**
 * src/main/ipc/brand.ts — brand-kit control-plane handlers (Part K).
 *
 * Wires the `brand:*` namespace to the main-side `brand-store` service: the
 * app-level brand library persisted under `<userData>/brands/<id>/` (mirrors
 * media-store). list/save/delete + adopt a PNG logo into the brand dir. The
 * brands root comes from trunk-frozen `paths.brandsDir()`; the service itself is
 * Electron-free so it stays unit-testable.
 */

import { IPCChannels } from '@shared/channels'
import type { BrandTemplate } from '@shared/schema'
import { brandsDir } from '@main/utils/paths'
import { adoptBrandLogo, deleteBrand, listBrands, saveBrand } from '@main/services/brand-store'
import type { IpcContext } from './index'

export function registerBrandHandlers(ctx: IpcContext): void {
  ctx.ipcMain.handle(IPCChannels.BRAND_LIST, async () => {
    return listBrands(brandsDir())
  })

  ctx.ipcMain.handle(IPCChannels.BRAND_SAVE, async (_e, req: { brand: BrandTemplate }) => {
    return saveBrand(brandsDir(), req.brand)
  })

  ctx.ipcMain.handle(IPCChannels.BRAND_DELETE, async (_e, req: { id: string }) => {
    return deleteBrand(brandsDir(), req.id)
  })

  ctx.ipcMain.handle(
    IPCChannels.BRAND_SET_LOGO,
    async (_e, req: { id: string; srcPath: string }) => {
      return adoptBrandLogo(brandsDir(), req.id, req.srcPath)
    }
  )
}
