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
import type { ApiKeyStatus, ModelInfo } from '@shared/channels'

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
  /** Provider model list for the picker (Part H — OpenRouter), recommended-first. */
  models: ModelInfo[]
  modelsLoading: boolean
  modelsError: string | null
  modelsFetchedAt: number | null
  /** Why the last `save` was rejected by main, if it was (FEAT-bysdwg). */
  saveError: string | null
  setSettings: (patch: Partial<Settings>) => void
  setKeyStatus: (status: ApiKeyStatus) => void
  /** Fetch the current provider's model list via the bridge (Part H). */
  loadModels: (refresh?: boolean) => Promise<void>
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

export const useSettingsStore = create<SettingsStore>()((set, get) => ({
  settings: DEFAULT_SETTINGS,
  keyStatus: {},
  models: [],
  modelsLoading: false,
  modelsError: null,
  modelsFetchedAt: null,
  saveError: null,
  setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
  setKeyStatus: (status) =>
    set((s) => ({ keyStatus: { ...s.keyStatus, [status.provider]: status } })),
  loadModels: async (refresh) => {
    const provider = get().settings.aiProvider
    set({ modelsLoading: true, modelsError: null })
    try {
      const res = await window.openclip.ai.listModels({ provider, refresh })
      // Drop a stale completion if the user switched providers mid-fetch.
      if (get().settings.aiProvider !== provider) return
      set({ models: res.models, modelsFetchedAt: res.fetchedAt, modelsLoading: false })
    } catch (e) {
      if (get().settings.aiProvider !== provider) return
      // Store only a message string — never any key material.
      set({
        modelsLoading: false,
        modelsError: e instanceof Error ? e.message : String(e)
      })
    }
  },
  load: async () => {
    const settings = await window.openclip.settings.get()
    // Load the clip provider's key status and, when set + distinct, the emoji
    // provider's too (Part K — the AI emoji path can use a separate provider/key).
    const providers = Array.from(
      new Set([settings.aiProvider, settings.emojiProvider].filter(Boolean) as AIProvider[])
    )
    const statuses = await Promise.all(
      providers.map((provider) => window.openclip.settings.apiKeyStatus({ provider }))
    )
    set((s) => {
      const keyStatus = { ...s.keyStatus }
      for (const status of statuses) keyStatus[status.provider] = status
      return { settings, keyStatus }
    })
  },
  save: async (patch) => {
    let settings: Settings
    try {
      settings = await window.openclip.settings.set({ settings: patch })
    } catch (e) {
      // `updateSettings` rejects a patch that fails the schema (BUG-yxvrwx). Every
      // caller here is `void save(...)`, so an unhandled rejection would leave the
      // user with a field that silently did not persist — now a real signal
      // (FEAT-bysdwg). Fields validate before calling; this is the backstop.
      set({ saveError: e instanceof Error ? e.message : String(e) })
      return
    }
    // Switching provider invalidates the model list (it's per-provider) — and so
    // does pointing the custom provider at a DIFFERENT server, where a list from
    // the previous endpoint is worse than none.
    const providerChanged = !!patch.aiProvider
    const endpointChanged = 'baseUrl' in patch
    set((s) =>
      (providerChanged && patch.aiProvider !== s.settings.aiProvider) ||
      (endpointChanged && patch.baseUrl !== s.settings.baseUrl)
        ? { settings, saveError: null, models: [], modelsError: null, modelsFetchedAt: null }
        : { settings, saveError: null }
    )
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
