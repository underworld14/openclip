/**
 * src/main/ipc/index.ts — the IPC HUB (plan E.4 decoupling pattern).
 *
 * FROZEN seam: `main/index.ts` loops the `HANDLER_REGISTRARS` array below; each
 * fan-out track fills ONLY its own `ipc/<domain>.ts` `registerXxxHandlers(ctx)`
 * body. No track ever edits this file or another track's domain module (E.4).
 *
 * Dependency injection: every registrar receives a single `IpcContext` (the DI
 * seam) so no handler reaches for a module-level singleton — the trunk wires the
 * concrete context once in `main/index.ts`, tracks consume the interface only.
 */

import type { IpcMain, BrowserWindow } from 'electron'
import type { KeyVault } from '@main/utils/security'
import type { SidecarManager } from '@main/services/sidecar-manager'

import { registerVideoHandlers } from './video'
import { registerAudioHandlers } from './audio'
import { registerAiHandlers } from './ai'
import { registerProjectHandlers } from './project'
import { registerSettingsHandlers } from './settings'
import { registerModelHandlers } from './model'
import { registerTranscribeHandlers } from './transcribe'

// ============================================================================
// IpcContext — the DI seam handed to every registrar (plan E.4)
// ============================================================================

/**
 * Everything a handler may need, injected once by the trunk. Tracks read from
 * this; they never import a singleton. Kept intentionally small + stable so it
 * is frozen alongside the other contract surfaces.
 */
export interface IpcContext {
  /** The Electron ipcMain to register `handle`/`on` against. */
  readonly ipcMain: IpcMain
  /** Resolves the focused/main BrowserWindow (for dialogs, port handoff). */
  getMainWindow(): BrowserWindow | null
  /** The sidecar host: job routing, queues, PID kill-on-quit. */
  readonly sidecar: SidecarManager
  /** API-key vault (safeStorage); raw keys NEVER cross IPC (PRD §12.2). */
  readonly keyVault: KeyVault
}

/** The shape every `ipc/<domain>.ts` exports. */
export type HandlerRegistrar = (ctx: IpcContext) => void

// ============================================================================
// HANDLER_REGISTRARS — the frozen registry main/index.ts iterates (E.4)
// ============================================================================

/**
 * The exhaustive set of per-domain registrars, frozen at trunk time. Order is
 * not significant (each registers disjoint channels). Adding a new domain is a
 * trunk-owned change, never a track edit.
 */
export const HANDLER_REGISTRARS: ReadonlyArray<HandlerRegistrar> = Object.freeze([
  registerVideoHandlers,
  registerAudioHandlers,
  registerAiHandlers,
  registerProjectHandlers,
  registerSettingsHandlers,
  registerModelHandlers,
  registerTranscribeHandlers
])

/** Convenience: run every registrar against a context (called by main/index.ts). */
export function registerAllHandlers(ctx: IpcContext): void {
  for (const register of HANDLER_REGISTRARS) register(ctx)
}
