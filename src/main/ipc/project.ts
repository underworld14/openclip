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
import { projectsDir } from '@main/utils/paths'
import { saveProject, loadProject, listProjects, deleteProject } from '@main/services/project-store'

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

  // project:delete — idempotent removal of a .ocproj file.
  ipcMain.handle(
    IPCChannels.DELETE_PROJECT,
    async (
      _e,
      req: ChannelReq<IPCChannels.DELETE_PROJECT>
    ): Promise<ChannelRes<IPCChannels.DELETE_PROJECT>> => {
      return deleteProject(projectsDir(), req.id)
    }
  )
}
