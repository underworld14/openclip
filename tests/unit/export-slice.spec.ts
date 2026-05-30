/**
 * tests/unit/export-slice.spec.ts — exportSlice composition + param building
 * (EXPORT spine, plan E.5; INTEGRATION GAP fix, plan Gate C / task 5).
 *
 * The load-bearing assertions:
 *   1. `composeProject()` builds the Project to export from LIVE slice state
 *      (clipsSlice + transcriptSlice), NOT the stale `currentProject` snapshot —
 *      so an edited/approved clip set and the streamed transcript are what gets
 *      exported/persisted (the gap flagged at Gate C).
 *   2. `buildExportParams()` applies the SHARED pure `resolveBounds(clip)` so the
 *      cut span honours the timeline trim (critic fix M2).
 */

import { describe, expect, it, beforeEach } from 'vitest'
import { createMockOpenclip } from '../mocks/openclip'
import {
  projectFixture,
  clipFixture,
  transcriptFixture,
  exportRecordFixture
} from '../fixtures/contract'
import { composeLiveProject, buildExportParams } from '@renderer/stores/projectStore/exportSlice'
import type { Clip } from '@shared/schema'

function installBridge(): void {
  ;(globalThis as { window?: unknown }).window = { openclip: createMockOpenclip() }
}

// ── Pure helpers (no store) ──────────────────────────────────────────────────

describe('composeLiveProject (pure)', () => {
  it('layers live clips + transcript + export history over the base project', () => {
    const liveClips: Clip[] = [{ ...clipFixture, id: 'live-1', status: 'approved' }]
    const liveHistory = [exportRecordFixture]
    const composed = composeLiveProject(projectFixture, liveClips, transcriptFixture, liveHistory)
    expect(composed.clips).toBe(liveClips) // live clips win
    expect(composed.clips[0].status).toBe('approved')
    expect(composed.transcript).toBe(transcriptFixture)
    expect(composed.exportHistory).toBe(liveHistory) // live history wins
    // base metadata preserved
    expect(composed.id).toBe(projectFixture.id)
    expect(composed.sourceVideo).toBe(projectFixture.sourceVideo)
  })

  it('keeps the base transcript when no live transcript is present', () => {
    const composed = composeLiveProject(projectFixture, [], null, [])
    expect(composed.transcript).toBe(projectFixture.transcript)
    expect(composed.clips).toEqual([])
    expect(composed.exportHistory).toEqual([])
  })
})

describe('buildExportParams (pure, applies resolveBounds)', () => {
  it('uses the edited bounds when present (fix M2)', () => {
    const clip: Clip = {
      ...clipFixture,
      startTime: 12.5,
      endTime: 41,
      editedStart: 13,
      editedEnd: 40
    }
    const params = buildExportParams({
      projectId: 'p1',
      clip,
      source: projectFixture.sourceVideo,
      settings: projectFixture.settings,
      outputPath: '/out/clip.mp4'
    })
    expect(params).toMatchObject({
      projectId: 'p1',
      clipId: clip.id,
      sourcePath: projectFixture.sourceVideo.path,
      startTime: 13, // editedStart wins
      endTime: 40, // editedEnd wins
      aspectRatio: '9:16',
      outputPath: '/out/clip.mp4',
      quality: '1080p'
    })
  })

  it('falls back to the suggested span when not edited', () => {
    const clip: Clip = {
      ...clipFixture,
      startTime: 5,
      endTime: 20,
      editedStart: undefined,
      editedEnd: undefined
    }
    const params = buildExportParams({
      projectId: 'p1',
      clip,
      source: projectFixture.sourceVideo,
      settings: projectFixture.settings,
      outputPath: '/o.mp4'
    })
    expect(params.startTime).toBe(5)
    expect(params.endTime).toBe(20)
  })

  it('throws on a non-positive span', () => {
    const clip: Clip = { ...clipFixture, editedStart: 40, editedEnd: 10 }
    expect(() =>
      buildExportParams({
        projectId: 'p1',
        clip,
        source: projectFixture.sourceVideo,
        settings: projectFixture.settings,
        outputPath: '/o.mp4'
      })
    ).toThrow(/non-positive/)
  })

  it('threads caption inputs (words + style) when captionsEnabled (PRD §6.4)', () => {
    const params = buildExportParams({
      projectId: 'p1',
      clip: { ...clipFixture, editedStart: undefined, editedEnd: undefined },
      source: projectFixture.sourceVideo,
      settings: projectFixture.settings,
      outputPath: '/o.mp4',
      captionsEnabled: true,
      words: transcriptFixture.words
    })
    expect(params.captions).toBeDefined()
    expect(params.captions!.words).toBe(transcriptFixture.words)
  })

  it('omits captions when disabled or when no words are supplied', () => {
    const base = {
      projectId: 'p1',
      clip: { ...clipFixture, editedStart: undefined, editedEnd: undefined },
      source: projectFixture.sourceVideo,
      settings: projectFixture.settings,
      outputPath: '/o.mp4'
    }
    expect(buildExportParams({ ...base, captionsEnabled: false }).captions).toBeUndefined()
    expect(
      buildExportParams({ ...base, captionsEnabled: true, words: [] }).captions
    ).toBeUndefined()
    expect(buildExportParams(base).captions).toBeUndefined()
  })
})

// ── Store-level composition (the integration-gap assertion) ──────────────────

describe('exportSlice.composeProject (live store state)', () => {
  beforeEach(() => installBridge())

  it('composes from the LIVE clipsSlice + transcriptSlice, not the stale currentProject', async () => {
    const { useProjectStore } = await import('@renderer/stores/projectStore')
    const store = useProjectStore.getState()

    // Open a project whose persisted clips/transcript are STALE.
    store.setCurrentProject({
      ...projectFixture,
      clips: [{ ...clipFixture, id: 'stale', title: 'STALE CLIP' }],
      transcript: { language: 'en', segments: [], words: [] }
    })

    // Now the live slices diverge: AI generated new clips, transcript streamed in.
    const liveClip: Clip = { ...clipFixture, id: 'live', title: 'LIVE CLIP', status: 'approved' }
    useProjectStore.getState().setClips([liveClip])
    useProjectStore.getState().setTranscript(transcriptFixture)

    const composed = useProjectStore.getState().composeProject()
    expect(composed).not.toBeNull()
    // The exported clip set reflects the LIVE clipsSlice, not currentProject.clips.
    expect(composed!.clips).toHaveLength(1)
    expect(composed!.clips[0].id).toBe('live')
    expect(composed!.clips[0].title).toBe('LIVE CLIP')
    // …and the LIVE transcript, not the stale empty one.
    expect(composed!.transcript.segments.length).toBeGreaterThan(0)
    expect(composed!.transcript).toEqual(transcriptFixture)
  })

  it('returns null when no project is open', async () => {
    const { useProjectStore } = await import('@renderer/stores/projectStore')
    useProjectStore.getState().setCurrentProject(null)
    expect(useProjectStore.getState().composeProject()).toBeNull()
  })
})
