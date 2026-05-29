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
  /** Load settings + the current provider's key status from main. */
  load: () => Promise<void>
  /** Persist a settings patch via the bridge; updates local state with the result. */
  save: (patch: Partial<Settings>) => Promise<void>
  /**
   * Send a user-typed API key to main (it crosses to MAIN, which persists it via
   * safeStorage and returns ONLY the status — the raw key is never returned and
   * is never stored in this renderer store; PRD §12.2).
   */
  setApiKey: (provider: AIProvider, key: string) => Promise<void>
  /** Pull the {provider,hasKey,last4} status for one provider (no key material). */
  refreshKeyStatus: (provider: AIProvider) => Promise<void>
}

export const useSettingsStore = create<SettingsStore>()((set) => ({
  settings: DEFAULT_SETTINGS,
  keyStatus: {},
  setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
  setKeyStatus: (status) =>
    set((s) => ({ keyStatus: { ...s.keyStatus, [status.provider]: status } })),
  load: async () => {
    const settings = await window.openclip.settings.get()
    const status = await window.openclip.settings.apiKeyStatus({ provider: settings.aiProvider })
    set((s) => ({
      settings,
      keyStatus: { ...s.keyStatus, [status.provider]: status }
    }))
  },
  save: async (patch) => {
    const settings = await window.openclip.settings.set({ settings: patch })
    set({ settings })
  },
  setApiKey: async (provider, key) => {
    const status = await window.openclip.settings.setApiKey({ provider, key })
    set((s) => ({ keyStatus: { ...s.keyStatus, [status.provider]: status } }))
  },
  refreshKeyStatus: async (provider) => {
    const status = await window.openclip.settings.apiKeyStatus({ provider })
    set((s) => ({ keyStatus: { ...s.keyStatus, [status.provider]: status } }))
  }
}))
