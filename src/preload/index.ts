/**
 * src/preload/index.ts — the typed contextBridge that exposes `window.openclip`.
 *
 * FROZEN as part of the OUTER contract + the E.4 assembly seam.
 *
 * `OpenClipBridge` is DERIVED from `ChannelMap` + `JobsAPI` via the mapped
 * types in `./api/types` — it is NOT hand-duplicated. This module ASSEMBLES the
 * bridge from the per-domain `preload/api/*` builders (plan E.4): each fan-out
 * track wires the matching main handler for its namespace; the preload surface
 * itself is frozen here. The runtime method-name derivation lives once in
 * `./api/_invoke` and is kept in lockstep with the type-level `MethodName`
 * (asserted by `preload-parity.spec.ts`, plan E.7).
 */

import { contextBridge } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { JobsAPI } from '@shared/jobs'
import type { NamespaceMethods } from './api/types'

import { buildVideoApi } from './api/video'
import { buildAudioApi } from './api/audio'
import { buildAiApi } from './api/ai'
import { buildProjectApi } from './api/project'
import { buildSettingsApi } from './api/settings'
import { buildModelApi } from './api/model'
import { buildJobsApi, installJobPortForwarder } from './api/jobs'

// ============================================================================
// OpenClipBridge — the public, derived `window.openclip` type (E.4 namespaces)
// ============================================================================

export interface OpenClipBridge {
  /** video:import, video:import:url, video:export → import, importUrl, export */
  video: NamespaceMethods<'video'>
  /** audio:extract → extract */
  audio: NamespaceMethods<'audio'>
  /** ai:generate-clips, ai:generate-titles, ai:enhance-captions */
  ai: NamespaceMethods<'ai'>
  /** project:save|load|list|delete */
  project: NamespaceMethods<'project'>
  /** settings:get|set|api-key-status|set-api-key */
  settings: NamespaceMethods<'settings'>
  /** model:status|download */
  model: NamespaceMethods<'model'>
  /** streaming jobs — modeled by JobsAPI (start→{jobId}; port out-of-band) */
  jobs: JobsAPI
}

// ============================================================================
// Assemble the bridge from the per-domain builders (plan E.4)
// ============================================================================

const openclip: OpenClipBridge = {
  video: buildVideoApi(),
  audio: buildAudioApi(),
  ai: buildAiApi(),
  project: buildProjectApi(),
  settings: buildSettingsApi(),
  model: buildModelApi(),
  jobs: buildJobsApi()
}

// ============================================================================
// Expose to the renderer (contextIsolation on)
// ============================================================================

// Forward each transferred per-job MessagePort from the isolated world into the
// renderer's MAIN world (the only contextIsolation-safe way to hand the renderer
// a LIVE port — see api/jobs.ts). Installed once, in BOTH isolation modes.
installJobPortForwarder()

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('openclip', openclip)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (defined in index.d.ts)
  window.electron = electronAPI
  // @ts-ignore (defined in index.d.ts)
  window.openclip = openclip
}
