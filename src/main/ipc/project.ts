/**
 * src/main/ipc/project.ts — project persistence handlers (STUB).
 *
 * Owned later by T-Persist (E.3): wires SAVE_PROJECT / LOAD_PROJECT /
 * LIST_PROJECTS / DELETE_PROJECT against `project-store.ts` (.ocproj JSON,
 * PRD §17 / plan P5). The trunk leaves the body empty so the hub compiles.
 */

import type { IpcContext } from './index'

export function registerProjectHandlers(ctx: IpcContext): void {
  void ctx
  // TODO(T-Persist): ctx.ipcMain.handle(IPCChannels.SAVE_PROJECT, …)
}
