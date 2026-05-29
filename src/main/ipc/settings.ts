/**
 * src/main/ipc/settings.ts — settings + API-key-status handlers (STUB).
 *
 * Owned later by T-AI (E.3, settings folded in — plan E.3 note): wires
 * GET_SETTINGS / SET_SETTINGS / GET_API_KEY_STATUS / SET_API_KEY. SET_API_KEY
 * persists via `ctx.keyVault` and returns ONLY `{provider,hasKey,last4}` — the
 * raw key never crosses IPC (PRD §12.2). The trunk leaves the body empty.
 */

import type { IpcContext } from './index'

export function registerSettingsHandlers(ctx: IpcContext): void {
  void ctx
  // TODO(T-AI): ctx.ipcMain.handle(IPCChannels.GET_API_KEY_STATUS, …)
}
