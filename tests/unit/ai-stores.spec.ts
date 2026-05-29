/**
 * tests/unit/ai-stores.spec.ts — clipsSlice + settingsStore thin actions
 * (T-AI, plan E.3/E.4). Thin actions call window.openclip directly; we install
 * the schema-valid mock bridge on globalThis.window and assert the stores wire
 * to it without leaking key material.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest'
import { createMockOpenclip } from '../mocks/openclip'
import { clipsFixture, settingsFixture, apiKeyStatusFixture } from '../fixtures/contract'

// Install a mock bridge on window before importing the stores (they read
// window.openclip in their thin actions).
function installBridge(overrides?: Partial<ReturnType<typeof createMockOpenclip>>): void {
  const bridge = { ...createMockOpenclip(), ...overrides }
  ;(globalThis as { window?: unknown }).window = { openclip: bridge }
}

describe('clipsSlice (projectStore)', () => {
  beforeEach(() => installBridge())

  it('setClips replaces the clip list', async () => {
    const { useProjectStore } = await import('@renderer/stores/projectStore')
    useProjectStore.getState().setClips(clipsFixture)
    expect(useProjectStore.getState().clips).toEqual(clipsFixture)
  })

  it('updateClip patches one clip by id (approve/reject status)', async () => {
    const { useProjectStore } = await import('@renderer/stores/projectStore')
    useProjectStore.getState().setClips(clipsFixture)
    useProjectStore.getState().updateClip('clip-1', { status: 'approved' })
    expect(useProjectStore.getState().clips[0].status).toBe('approved')
  })

  it('selectClip sets the selected id', async () => {
    const { useProjectStore } = await import('@renderer/stores/projectStore')
    useProjectStore.getState().selectClip('clip-1')
    expect(useProjectStore.getState().selectedClipId).toBe('clip-1')
  })

  it('generateClips calls window.openclip.ai.generateClips and stores results', async () => {
    const generateClips = vi.fn(async () => ({
      clips: [
        {
          start_time: 12.5,
          end_time: 41,
          title: 'Generated',
          hook: 'h',
          virality_score: 8,
          clip_type: 'hook' as const,
          keywords: [],
          suggested_caption: 'c',
          hashtags: []
        }
      ],
      analysis: {
        total_duration: 240,
        clips_found: 1,
        best_clip_index: 0,
        overall_virality_potential: 'high' as const
      }
    }))
    const bridge = createMockOpenclip()
    bridge.ai.generateClips = generateClips as never
    installBridge(bridge)

    const { useProjectStore } = await import('@renderer/stores/projectStore')
    await useProjectStore.getState().generateClips({
      projectId: 'p1',
      provider: 'openai',
      model: 'gpt-4o-mini',
      segments: [],
      videoTitle: 'Demo',
      durationSeconds: 240,
      clipStyle: 'all',
      numClips: 5,
      targetPlatform: 'tiktok'
    })
    expect(generateClips).toHaveBeenCalledOnce()
    const clips = useProjectStore.getState().clips
    expect(clips).toHaveLength(1)
    // Mapped from DetectedClip (snake_case) → Clip (camelCase), status suggested.
    expect(clips[0].title).toBe('Generated')
    expect(clips[0].viralityScore).toBe(8)
    expect(clips[0].startTime).toBe(12.5)
    expect(clips[0].status).toBe('suggested')
  })
})

describe('settingsStore', () => {
  beforeEach(() => installBridge())

  it('load() pulls settings + key status via the bridge (never the raw key)', async () => {
    const { useSettingsStore } = await import('@renderer/stores/settingsStore')
    await useSettingsStore.getState().load()
    expect(useSettingsStore.getState().settings.aiProvider).toBe(settingsFixture.aiProvider)
    // No raw key anywhere in the store snapshot.
    expect(JSON.stringify(useSettingsStore.getState())).not.toMatch(/sk-|secret/i)
  })

  it('save(patch) persists via window.openclip.settings.set and updates state', async () => {
    const set = vi.fn(async () => ({ ...settingsFixture, maxClips: 9 }))
    const bridge = createMockOpenclip()
    bridge.settings.set = set as never
    installBridge(bridge)

    const { useSettingsStore } = await import('@renderer/stores/settingsStore')
    await useSettingsStore.getState().save({ maxClips: 9 })
    expect(set).toHaveBeenCalledWith({ settings: { maxClips: 9 } })
    expect(useSettingsStore.getState().settings.maxClips).toBe(9)
  })

  it('setApiKey() round-trips through the bridge and stores only the status', async () => {
    const setApiKey = vi.fn(async () => apiKeyStatusFixture)
    const bridge = createMockOpenclip()
    bridge.settings.setApiKey = setApiKey as never
    installBridge(bridge)

    const { useSettingsStore } = await import('@renderer/stores/settingsStore')
    await useSettingsStore.getState().setApiKey('openai', 'sk-typed-by-user')
    // Bridge called with the key (it crosses to MAIN, which never returns it).
    expect(setApiKey).toHaveBeenCalledWith({ provider: 'openai', key: 'sk-typed-by-user' })
    // Store keeps only the status, never the raw key.
    expect(useSettingsStore.getState().keyStatus.openai).toEqual(apiKeyStatusFixture)
    expect(JSON.stringify(useSettingsStore.getState().keyStatus)).not.toContain('sk-typed-by-user')
  })

  it('refreshKeyStatus() pulls api-key-status for a provider', async () => {
    const apiKeyStatus = vi.fn(async () => ({ provider: 'anthropic' as const, hasKey: false }))
    const bridge = createMockOpenclip()
    bridge.settings.apiKeyStatus = apiKeyStatus as never
    installBridge(bridge)

    const { useSettingsStore } = await import('@renderer/stores/settingsStore')
    await useSettingsStore.getState().refreshKeyStatus('anthropic')
    expect(apiKeyStatus).toHaveBeenCalledWith({ provider: 'anthropic' })
    expect(useSettingsStore.getState().keyStatus.anthropic).toEqual({
      provider: 'anthropic',
      hasKey: false
    })
  })

  it('loadModels() pulls the provider model list via the bridge (Part H)', async () => {
    const listModels = vi.fn(async () => ({
      provider: 'openrouter' as const,
      models: [
        {
          id: 'anthropic/claude-sonnet-4.5',
          name: 'Claude',
          supportsStructured: true,
          recommended: true
        }
      ],
      fetchedAt: 123,
      fromCache: false
    }))
    const bridge = createMockOpenclip()
    bridge.ai.listModels = listModels as never
    installBridge(bridge)

    const { useSettingsStore } = await import('@renderer/stores/settingsStore')
    useSettingsStore.setState({ settings: { ...settingsFixture, aiProvider: 'openrouter' } })
    await useSettingsStore.getState().loadModels(true)
    expect(listModels).toHaveBeenCalledWith({ provider: 'openrouter', refresh: true })
    expect(useSettingsStore.getState().models).toHaveLength(1)
    expect(useSettingsStore.getState().modelsLoading).toBe(false)
    expect(useSettingsStore.getState().modelsFetchedAt).toBe(123)
  })

  it('loadModels() stores an error message (no key material) when the bridge throws', async () => {
    const listModels = vi.fn(async () => {
      throw new Error('OpenRouter model list failed: HTTP 401')
    })
    const bridge = createMockOpenclip()
    bridge.ai.listModels = listModels as never
    installBridge(bridge)

    const { useSettingsStore } = await import('@renderer/stores/settingsStore')
    useSettingsStore.setState({ settings: { ...settingsFixture, aiProvider: 'openrouter' } })
    await useSettingsStore.getState().loadModels()
    expect(useSettingsStore.getState().modelsError).toMatch(/HTTP 401/)
    expect(useSettingsStore.getState().modelsLoading).toBe(false)
  })
})
