/**
 * src/main/ipc/ai.ts — AI (BYOK) control-plane handlers (STUB).
 *
 * Owned later by T-AI (E.3): wires GENERATE_CLIPS, GENERATE_TITLES,
 * ENHANCE_CAPTIONS via `ai-client.ts` (structured output + Zod repair +
 * map-reduce). Reads keys from `ctx.keyVault` (raw key never returned). The
 * trunk leaves the body empty so the hub registry compiles.
 */

import type { IpcContext } from './index'

export function registerAiHandlers(ctx: IpcContext): void {
  void ctx
  // TODO(T-AI): ctx.ipcMain.handle(IPCChannels.GENERATE_CLIPS, …)
}
