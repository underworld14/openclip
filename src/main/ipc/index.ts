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
import type { MediaAccess } from '@main/utils/media-access'
import type { Settings } from '@shared/schema'

import { registerVideoHandlers } from './video'
import { registerAudioHandlers } from './audio'
import { registerAiHandlers } from './ai'
import { registerMediaHandlers } from './media'
import { registerBrandHandlers } from './brand'
import { registerProjectHandlers } from './project'
import { registerSettingsHandlers } from './settings'
import { registerModelHandlers } from './model'
import { registerTranscribeHandlers } from './transcribe'
import { registerSystemPreflightHandler } from './system'

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
  /**
   * The sidecar host: job routing, queues, PID kill-on-quit. NOTE: job RUNNERS
   * are NOT registered on this instance — `SidecarManager` has no
   * `registerRunner`. Tracks register their runner via the module-level
   * `registerRunner(kind, runner)` export from `@main/services/sidecar-manager`
   * (the `JOB_RUNNERS` registry seam); `startJob` then looks the runner up.
   */
  readonly sidecar: SidecarManager
  /** API-key vault (safeStorage); raw keys NEVER cross IPC (PRD §12.2). */
  readonly keyVault: KeyVault
  /**
   * The `openclip-media://` allow-list (audit fix openclip-8tx). Handlers that
   * learn of a legitimate source path (import/probe, project load) `grant()` it
   * so the privileged media scheme may serve it; everything else is 403'd.
   */
  readonly mediaAccess: MediaAccess
  /**
   * The persisted app Settings, read fresh (FEAT-bysdwg).
   *
   * The ENDPOINT a provider talks to is resolved from here exactly as its key is
   * resolved from `keyVault` — never from a renderer-supplied payload. Putting a
   * base URL on the IPC/job contract would let a compromised renderer name the
   * destination the user's decrypted BYOK key is attached to, which is precisely
   * what PRD §12.2 keeps main-only.
   *
   * Deliberately uncached: the base URL is a field users edit while getting an
   * endpoint working, and it must take effect without a restart.
   */
  getSettings(): Settings
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
  registerMediaHandlers,
  registerBrandHandlers,
  registerProjectHandlers,
  registerSettingsHandlers,
  registerModelHandlers,
  registerTranscribeHandlers,
  registerSystemPreflightHandler
])

/** Convenience: run every registrar against a context (called by main/index.ts). */
export function registerAllHandlers(ctx: IpcContext): void {
  for (const register of HANDLER_REGISTRARS) register(ctx)
}
