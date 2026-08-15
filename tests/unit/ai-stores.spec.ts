/**
 * tests/unit/ai-stores.spec.ts — clipsSlice + settingsStore thin actions
 * (T-AI, plan E.3/E.4). Thin actions call window.openclip directly; we install
 * the schema-valid mock bridge on globalThis.window and assert the stores wire
 * to it without leaking key material.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest'
import { createMockOpenclip } from '../mocks/openclip'
import {
  clipFixture,
  clipsFixture,
  projectFixture,
  settingsFixture,
  apiKeyStatusFixture
} from '../fixtures/contract'

// Install a mock bridge on window before importing the stores (they read
// window.openclip in their thin actions).
function installBridge(overrides?: Partial<ReturnType<typeof createMockOpenclip>>): void {
  const bridge = { ...createMockOpenclip(), ...overrides }
  ;(globalThis as { window?: unknown }).window = { openclip: bridge }
}

describe('clipsSlice (projectStore)', () => {
  beforeEach(async () => {
    installBridge()
    // generateClips guards every write on `req.projectId` matching the OPEN
    // project (EPIC-k83ghw / BUG-93txd0), so these tests need one open whose
    // id matches GENERATE_REQUEST below — a bare `null` currentProject (the
    // module's default) would make every guard fail and silently drop the
    // result, which is exactly the regression this guard exists to prevent.
    const { useProjectStore } = await import('@renderer/stores/projectStore')
    useProjectStore.getState().setCurrentProject({ ...projectFixture, id: 'p1' })
    // A clean slate: `clips` is a separate slice from `currentProject` and
    // previous tests in this file leave it non-empty, which — now that a
    // regenerate PRESERVES trimmed/approved clips (BUG-vv87d6) rather than
    // always replacing wholesale — would otherwise leak an unrelated fixture
    // clip into this run's result. Tests that need specific starting clips
    // already set them explicitly.
    useProjectStore.getState().setClips([])
  })

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

  const GENERATE_REQUEST = {
    projectId: 'p1',
    provider: 'openai' as const,
    model: 'gpt-4o-mini',
    segments: [],
    videoTitle: 'Demo',
    durationSeconds: 240,
    clipStyle: 'all' as const,
    numClips: 5,
    targetPlatform: 'tiktok' as const
  }

  /**
   * Clip detection runs on the STREAMING JOB plane now (FEAT-c0zn3j), not the
   * `ai:generate-clips` invoke — that is what gives it progress and a cancel.
   * The mock bridge's default `generate-clips` script emits two chunk partials
   * and then a terminal `done`.
   */
  it('drives the generate-clips job and stores the terminal result', async () => {
    const { useProjectStore } = await import('@renderer/stores/projectStore')
    await useProjectStore.getState().generateClips(GENERATE_REQUEST)

    const state = useProjectStore.getState()
    expect(state.generating).toBe(false)
    expect(state.generateError).toBeNull()
    expect(state.generateJobId).toBeNull()

    // The `done` payload is the authoritative set — one clip, even though two
    // chunk partials arrived carrying the same candidate. Accumulating partials
    // as final is exactly how cross-chunk duplicates would appear.
    const clips = state.clips
    expect(clips).toHaveLength(1)
    expect(clips[0].title).toBe('The wildest take of the year')
    expect(clips[0].viralityScore).toBe(9)
    expect(clips[0].startTime).toBe(12.5)
    expect(clips[0].status).toBe('suggested')
  })

  it('streams provisional clips while running, then clears them', async () => {
    const { useProjectStore } = await import('@renderer/stores/projectStore')
    useProjectStore.getState().setClips([])

    // Provisional candidates must never reach `clips`: that array is one of the
    // refs autosave watches, so unranked guesses landing there get written into
    // the .ocproj as though the user had accepted them.
    let sawProvisional = 0
    let clipsDuringRun = 0
    const unsubscribe = useProjectStore.subscribe((s) => {
      if (s.generating) {
        sawProvisional = Math.max(sawProvisional, s.provisionalClips.length)
        clipsDuringRun = Math.max(clipsDuringRun, s.clips.length)
      }
    })

    await useProjectStore.getState().generateClips(GENERATE_REQUEST)
    unsubscribe()

    expect(sawProvisional).toBeGreaterThan(0)
    expect(clipsDuringRun).toBe(0)
    expect(useProjectStore.getState().provisionalClips).toEqual([])
  })

  it('keeps the previous clips when a regeneration fails', async () => {
    // A failed regeneration must not destroy results the user already had —
    // they may have been about to export them.
    const bridge = createMockOpenclip({
      scripts: {
        'generate-clips': {
          steps: [{ t: 'error', code: 'API_RATE_LIMIT', message: 'slow down', retriable: true }]
        }
      }
    })
    installBridge(bridge)

    const { useProjectStore } = await import('@renderer/stores/projectStore')
    useProjectStore.getState().setClips(clipsFixture)
    await useProjectStore.getState().generateClips(GENERATE_REQUEST)

    expect(useProjectStore.getState().clips).toEqual(clipsFixture)
    expect(useProjectStore.getState().generateError).toContain('slow down')
  })

  // EPIC-k83ghw / BUG-hkmsng: a run that legitimately finds zero clips is a
  // SUCCESS, not a failure — must not be confused with "never ran" by wiping
  // whatever the user already had.
  it('a zero-clip result keeps the previous clips AND shows the explanation', async () => {
    const bridge = createMockOpenclip({
      scripts: {
        'generate-clips': {
          steps: [
            { t: 'progress', pct: 100, stage: 'analyzing' },
            {
              t: 'done',
              result: {
                clips: [],
                analysis: {
                  total_duration: 240,
                  clips_found: 0,
                  best_clip_index: 0,
                  overall_virality_potential: 'low'
                },
                warnings: ['No moment matched your 15–90s length range — try widening the range.']
              }
            }
          ]
        }
      }
    })
    installBridge(bridge)

    const { useProjectStore } = await import('@renderer/stores/projectStore')
    // Seed with an UNREVIEWED, UNTOUCHED clip from a prior run — status
    // 'suggested' and no edited bounds, so it fails EVERY condition of the
    // `preserved` filter (approved/exported/edited status, or edited bounds).
    // This is the exact case the old `[...preserved, ...result.clips]` logic
    // dropped on a zero-result run, silently.
    const untouched = { ...clipFixture, editedStart: undefined, editedEnd: undefined }
    useProjectStore.getState().setClips([untouched])
    await useProjectStore.getState().generateClips(GENERATE_REQUEST)

    const state = useProjectStore.getState()
    expect(state.generating).toBe(false)
    expect(state.clips).toEqual([untouched])
    expect(state.generateWarnings).toEqual([
      'No moment matched your 15–90s length range — try widening the range.'
    ])
    expect(state.generateError).toBeNull()
  })

  it('a NON-empty regenerate still replaces an untouched suggestion as before (no regression)', async () => {
    const { useProjectStore } = await import('@renderer/stores/projectStore')
    const untouched = {
      ...clipFixture,
      id: 'stale-suggestion',
      editedStart: undefined,
      editedEnd: undefined
    }
    useProjectStore.getState().setClips([untouched])
    await useProjectStore.getState().generateClips(GENERATE_REQUEST)

    // The default mock script returns one real clip — the stale, untouched
    // suggestion is gone, replaced by the fresh result (BUG-vv87d6 behaviour,
    // unaffected by the zero-clip special case above).
    const clips = useProjectStore.getState().clips
    expect(clips).toHaveLength(1)
    expect(clips[0].id).not.toBe('stale-suggestion')
    expect(clips[0].title).toBe('The wildest take of the year')
  })

  it('reports a terminal job error through generateError', async () => {
    const bridge = createMockOpenclip({
      scripts: {
        'generate-clips': {
          steps: [
            { t: 'error', code: 'TIMEOUT', message: 'openai did not respond', retriable: true }
          ]
        }
      }
    })
    installBridge(bridge)

    const { useProjectStore } = await import('@renderer/stores/projectStore')
    await useProjectStore.getState().generateClips(GENERATE_REQUEST)

    const state = useProjectStore.getState()
    expect(state.generating).toBe(false)
    expect(state.generateError).toContain('did not respond')
  })

  it('treats a cancellation as the user’s own doing, not an error', async () => {
    const bridge = createMockOpenclip({
      scripts: {
        'generate-clips': {
          steps: [{ t: 'error', code: 'CANCELLED', message: 'job cancelled', retriable: false }]
        }
      }
    })
    installBridge(bridge)

    const { useProjectStore } = await import('@renderer/stores/projectStore')
    await useProjectStore.getState().generateClips(GENERATE_REQUEST)

    const state = useProjectStore.getState()
    expect(state.generating).toBe(false)
    // Showing "generate-clips failed [CANCELLED]" to someone who just clicked
    // Cancel is presenting their own action back to them as a failure.
    expect(state.generateError).toBeNull()
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
