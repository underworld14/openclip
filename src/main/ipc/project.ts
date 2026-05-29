/**
 * src/main/ipc/project.ts — project persistence handlers (T-Persist, E.3/E.4).
 *
 * Wires SAVE_PROJECT / LOAD_PROJECT / LIST_PROJECTS / DELETE_PROJECT (PRD §10.1)
 * to the pure `project-store` service. The projects directory is resolved ONCE
 * here from trunk-frozen `utils/paths.ts` (`projectsDir()` — the only place
 * `app.getPath('userData')` is touched), then injected into the store so the
 * store itself stays Electron-free and unit-testable (plan E.3).
 *
 * This is the only project-domain registrar the frozen `HANDLER_REGISTRARS`
 * registry (`ipc/index.ts`) invokes; it owns exactly these four channels and
 * touches no other track's surface (E.4 one-writer-per-file).
 */

import type { IpcContext } from './index'
import { IPCChannels } from '@shared/channels'
import type { ChannelReq, ChannelRes } from '@shared/channels'
import { projectsDir, mediaDir } from '@main/utils/paths'
import { saveProject, loadProject, listProjects, deleteProject } from '@main/services/project-store'
import { deleteProjectMedia } from '@main/services/media-store'

export function registerProjectHandlers(ctx: IpcContext): void {
  const { ipcMain } = ctx

  // project:save — persist a Project to <userData>/projects/<id>.ocproj, bumping
  // updatedAt (an explicit/auto save means the doc changed). Returns the path.
  ipcMain.handle(
    IPCChannels.SAVE_PROJECT,
    async (
      _e,
      req: ChannelReq<IPCChannels.SAVE_PROJECT>
    ): Promise<ChannelRes<IPCChannels.SAVE_PROJECT>> => {
      const { path } = await saveProject(projectsDir(), req.project, { touchUpdatedAt: true })
      return { path }
    }
  )

  // project:load — read + JSON.parse + Zod re-validate (rejects tampered/older
  // files with a typed ProjectStoreError that propagates over IPC — PRD §12.3).
  ipcMain.handle(
    IPCChannels.LOAD_PROJECT,
    async (
      _e,
      req: ChannelReq<IPCChannels.LOAD_PROJECT>
    ): Promise<ChannelRes<IPCChannels.LOAD_PROJECT>> => {
      return loadProject(projectsDir(), req.id)
    }
  )

  // project:list — recent-projects metadata for the Dashboard (newest first).
  ipcMain.handle(
    IPCChannels.LIST_PROJECTS,
    async (): Promise<ChannelRes<IPCChannels.LIST_PROJECTS>> => {
      return listProjects(projectsDir())
    }
  )

  // project:delete — idempotent removal of a .ocproj file. Also reclaims the
  // project's OWNED media dir <userData>/media/<id>/ (Part H) — best-effort, so a
  // media-rm failure never fails the project delete (the launch sweep is the
  // backstop). This only ever touches media/<id>/; a file-import original (outside
  // mediaDir, appOwned:false) is structurally unreachable.
  ipcMain.handle(
    IPCChannels.DELETE_PROJECT,
    async (
      _e,
      req: ChannelReq<IPCChannels.DELETE_PROJECT>
    ): Promise<ChannelRes<IPCChannels.DELETE_PROJECT>> => {
      const res = await deleteProject(projectsDir(), req.id)
      await deleteProjectMedia(req.id, mediaDir()).catch((err) => {
        console.error(`[media] failed to reclaim media for project ${req.id}:`, err)
      })
      return res
    }
  )
}
