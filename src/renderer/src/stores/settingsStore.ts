/**
 * src/renderer/src/stores/settingsStore.ts — app settings store (STUB; owned by
 * T-AI, E.3).
 *
 * Plan `settingsStore`: `aiProvider`, `model`, `baseUrl`, `aspectRatio`,
 * `maxClips`, `min/maxDuration`, whisper model, language, forceCpu, telemetry.
 * Keys live in the OS keychain via main only (never in this store — PRD §12.2);
 * this store holds only the renderer-safe `ApiKeyStatus` per provider. Thin
 * actions call `window.openclip.settings` directly. The trunk ships the shape;
 * T-AI fills the action bodies.
 */

import { create } from 'zustand'
import type { Settings, AIProvider } from '@shared/schema'
import type { ApiKeyStatus } from '@shared/channels'

const DEFAULT_SETTINGS: Settings = {
  aiProvider: 'openai',
  model: '', // resolved current model id (PRD §4.3 — not hardcoded)
  baseUrl: undefined,
  whisperModel: 'base', // MVP default (PRD §6.2)
  language: undefined, // whisper auto-detect
  aspectRatio: '9:16',
  maxClips: 5,
  minDuration: 15,
  maxDuration: 90,
  forceCpu: false,
  telemetryOptIn: false
}

export interface SettingsStore {
  settings: Settings
  /** Renderer-safe key status per provider (NEVER the raw key — PRD §12.2). */
  keyStatus: Partial<Record<AIProvider, ApiKeyStatus>>
  setSettings: (patch: Partial<Settings>) => void
  setKeyStatus: (status: ApiKeyStatus) => void
  /** Load settings from main (body owned by T-AI). */
  load: () => Promise<void>
  /** Persist settings via the bridge (body owned by T-AI). */
  save: (patch: Partial<Settings>) => Promise<void>
}

export const useSettingsStore = create<SettingsStore>()((set) => ({
  settings: DEFAULT_SETTINGS,
  keyStatus: {},
  setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
  setKeyStatus: (status) =>
    set((s) => ({ keyStatus: { ...s.keyStatus, [status.provider]: status } })),
  load: async () => {
    // Thin action: T-AI fills to `window.openclip.settings.get()`.
  },
  save: async (patch) => {
    // Thin action: T-AI fills to `window.openclip.settings.set({ settings })`.
    void patch
  }
}))
