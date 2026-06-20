/**
 * tests/unit/generate-clips-view.spec.ts — the pure "Auto Generate Clips" view-
 * model (P0 dead-button fix). The vitest env is `node` (no jsdom), so we test the
 * LOAD-BEARING pure logic the App header button renders from:
 *   - `buildGenerateClipsRequest(project, settings)` — maps the open project +
 *     app settings into the FROZEN `GenerateClipsRequest` (segments-only — the
 *     word stream stays local; PRD §16).
 *   - `createGenerateClipsHandler(deps)` — the click-handler core that builds the
 *     request and dispatches `generateClips`, mirroring the other framework-free
 *     controller cores (import-controller).
 */

import { describe, expect, it, vi } from 'vitest'
import {
  buildGenerateClipsRequest,
  createGenerateClipsHandler
} from '@renderer/components/generateClips'
import { projectFixture, settingsFixture } from '../fixtures/contract'
import type { Settings } from '@shared/schema'

describe('buildGenerateClipsRequest', () => {
  it('maps the open project + settings into the frozen GenerateClipsRequest', () => {
    const settings: Settings = {
      ...settingsFixture,
      aiProvider: 'anthropic',
      model: 'claude-sonnet-4.5',
      maxClips: 8
    }
    const req = buildGenerateClipsRequest(projectFixture, settings)

    expect(req).toEqual({
      projectId: projectFixture.id,
      provider: 'anthropic',
      model: 'claude-sonnet-4.5',
      segments: projectFixture.transcript.segments,
      videoTitle: projectFixture.name,
      durationSeconds: projectFixture.sourceVideo.duration,
      // clipStyle / targetPlatform / min+maxDuration come from the PROJECT settings
      clipStyle: projectFixture.settings.clipStyle,
      numClips: 8,
      targetPlatform: projectFixture.settings.targetPlatform,
      // Clip-length bounds threaded from project settings (audit fix openclip-t0v).
      minDuration: projectFixture.settings.minDuration,
      maxDuration: projectFixture.settings.maxDuration
    })
  })

  it('sends segment-level transcript ONLY — never the word stream (PRD §16)', () => {
    const req = buildGenerateClipsRequest(projectFixture, settingsFixture)
    // The request carries the same segments array reference, and nothing else
    // from the transcript (no `words`).
    expect(req.segments).toEqual(projectFixture.transcript.segments)
    expect((req as unknown as Record<string, unknown>).words).toBeUndefined()
    // sanity: the project DOES have a local word stream we are NOT forwarding
    expect(projectFixture.transcript.words.length).toBeGreaterThan(0)
  })

  it('draws clipStyle + targetPlatform from the PROJECT settings, not app settings', () => {
    const project = {
      ...projectFixture,
      settings: {
        ...projectFixture.settings,
        clipStyle: 'funny' as const,
        targetPlatform: 'youtube' as const
      }
    }
    const req = buildGenerateClipsRequest(project, settingsFixture)
    expect(req.clipStyle).toBe('funny')
    expect(req.targetPlatform).toBe('youtube')
  })
})

describe('createGenerateClipsHandler', () => {
  it('builds the request and dispatches generateClips when a project is open', async () => {
    const generateClips = vi.fn().mockResolvedValue(undefined)
    const handler = createGenerateClipsHandler({
      getProject: () => projectFixture,
      getSettings: () => settingsFixture,
      generateClips
    })

    await handler()

    expect(generateClips).toHaveBeenCalledTimes(1)
    expect(generateClips).toHaveBeenCalledWith(
      buildGenerateClipsRequest(projectFixture, settingsFixture)
    )
  })

  it('is a no-op when there is no open project (cannot build a request)', async () => {
    const generateClips = vi.fn().mockResolvedValue(undefined)
    const handler = createGenerateClipsHandler({
      getProject: () => null,
      getSettings: () => settingsFixture,
      generateClips
    })

    await handler()

    expect(generateClips).not.toHaveBeenCalled()
  })
})
