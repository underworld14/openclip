/**
 * tests/unit/batch-export.spec.ts — the PURE batch orchestration (Part K, Step 4)
 * driven against the mock bridge (multiple concurrent `export` jobs over real
 * Node MessageChannels). Covers collision-safe naming, all-success, and per-clip
 * failure isolation (one error must not abort the batch).
 */

import { describe, it, expect } from 'vitest'
import { createMockOpenclip } from '../mocks/openclip'
import { projectFixture, clipFixture } from '../fixtures/contract'
import { runBatchExport, deriveBatchFileNames } from '@renderer/components/batch-export'
import { PLATFORM_PRESETS } from '@renderer/components/platformPresets'
import { resolveEffectiveCaptionStyle } from '@renderer/components/captionPresets'
import type { Clip, Project } from '@shared/schema'

const preset = PLATFORM_PRESETS[0] // tiktok 9:16 1080p

function makeClips(n: number): Clip[] {
  return Array.from({ length: n }, (_, i) => ({
    ...clipFixture,
    id: `c${i}`,
    title: `Clip ${i}`,
    editedStart: undefined,
    editedEnd: undefined
  }))
}

const project: Project = {
  ...projectFixture,
  transcript: {
    language: 'en',
    segments: [],
    words: [{ word: 'hi', start: 0, end: 0.3, confidence: 1 }]
  }
}

describe('deriveBatchFileNames', () => {
  it('dedupes identical/empty slugs deterministically', () => {
    const out = deriveBatchFileNames(
      [
        { id: 'a', title: 'The Take' },
        { id: 'b', title: 'The Take' },
        { id: 'c', title: '***' }, // empty slug → 'clip'
        { id: 'd', title: '***' }
      ],
      '/out'
    )
    expect(out.map((o) => o.outputPath)).toEqual([
      '/out/the-take.mp4',
      '/out/the-take-2.mp4',
      '/out/clip.mp4',
      '/out/clip-2.mp4'
    ])
    expect(new Set(out.map((o) => o.outputPath)).size).toBe(4)
  })

  it('trims a trailing slash from the directory', () => {
    expect(deriveBatchFileNames([{ id: 'a', title: 'X' }], '/out/')[0].outputPath).toBe(
      '/out/x.mp4'
    )
  })
})

describe('runBatchExport', () => {
  it('exports every clip to a unique path and reports done', async () => {
    const bridge = createMockOpenclip()
    const statuses: Array<{ id: string; status: string }> = []
    const results = await runBatchExport({
      bridge,
      project,
      clips: makeClips(3),
      dir: '/out',
      preset,
      onClipStatus: (id, status) => statuses.push({ id, status })
    })
    expect(results).toHaveLength(3)
    expect(results.every((r) => r.status === 'done')).toBe(true)
    expect(results.map((r) => r.outputPath)).toEqual([
      '/out/clip-0.mp4',
      '/out/clip-1.mp4',
      '/out/clip-2.mp4'
    ])
    expect(results[0].result?.width).toBe(1080)
    expect(results[0].result?.height).toBe(1920)
    // each clip moved running → done
    expect(statuses.filter((s) => s.status === 'done')).toHaveLength(3)
  })

  it('cancel-all: a pre-aborted signal skips every clip without starting a job', async () => {
    const bridge = createMockOpenclip()
    const started: string[] = []
    const origStart = bridge.jobs.start.bind(bridge.jobs)
    bridge.jobs.start = ((kind: 'export', params: never) => {
      started.push(kind)
      return origStart(kind, params)
    }) as typeof bridge.jobs.start
    const controller = new AbortController()
    controller.abort()
    const results = await runBatchExport({
      bridge,
      project,
      clips: makeClips(3),
      dir: '/out',
      preset,
      signal: controller.signal
    })
    expect(results).toHaveLength(3)
    expect(results.every((r) => r.status === 'canceled')).toBe(true)
    expect(started).toHaveLength(0) // no job started after abort
  })

  it('isolates per-clip failures — one error does not abort the batch (resolves, never rejects)', async () => {
    const bridge = createMockOpenclip({
      scripts: {
        export: {
          steps: [{ t: 'error', code: 'SIDECAR_CRASH', message: 'boom', retriable: true }]
        }
      }
    })
    const results = await runBatchExport({
      bridge,
      project,
      clips: makeClips(2),
      dir: '/out',
      preset
    })
    expect(results).toHaveLength(2)
    expect(results.every((r) => r.status === 'error')).toBe(true)
    expect(results[0].error).toContain('boom')
  })

  it('carries the chosen framing (fitMode + reframe) into every export job (EPIC-k83ghw / BUG-15cddx)', async () => {
    // Before this, a batch always centre-cropped every clip — fitMode/reframe
    // were never threaded through at all, unlike the single-clip export path.
    const bridge = createMockOpenclip()
    const captured: unknown[] = []
    const origStart = bridge.jobs.start.bind(bridge.jobs)
    bridge.jobs.start = ((kind: 'export', params: never) => {
      if (kind === 'export') captured.push(params)
      return origStart(kind, params)
    }) as typeof bridge.jobs.start

    await runBatchExport({
      bridge,
      project,
      clips: makeClips(1),
      dir: '/out',
      preset,
      fitMode: 'letterbox',
      reframe: 'auto'
    })

    expect(captured).toHaveLength(1)
    expect((captured[0] as { fitMode?: string }).fitMode).toBe('letterbox')
    expect((captured[0] as { reframe?: string }).reframe).toBe('auto')
  })

  it('honours the PROJECT caption template, not the platform preset default (EPIC-k83ghw / BUG-15cddx)', async () => {
    // `preset.captionTemplateId` is a per-platform DEFAULT for a fresh project,
    // not an override of a style the user already picked in the caption
    // gallery — using it unconditionally meant every clip silently switched
    // styles on batch export (e.g. every TikTok export forced to
    // "tiktok-bounce" regardless of what the live preview showed).
    const bridge = createMockOpenclip()
    const captured: unknown[] = []
    const origStart = bridge.jobs.start.bind(bridge.jobs)
    bridge.jobs.start = ((kind: 'export', params: never) => {
      if (kind === 'export') captured.push(params)
      return origStart(kind, params)
    }) as typeof bridge.jobs.start

    const projectWithChosenStyle: Project = {
      ...project,
      settings: { ...project.settings, captionTemplateId: 'hormozi' }
    }
    expect(preset.captionTemplateId).not.toBe('hormozi') // sanity: genuinely different from the preset default

    await runBatchExport({
      bridge,
      project: projectWithChosenStyle,
      clips: makeClips(1),
      dir: '/out',
      preset
    })

    const style = (captured[0] as { captions?: { style?: unknown } }).captions?.style
    const hormoziStyle = resolveEffectiveCaptionStyle('hormozi', {})
    const presetDefaultStyle = resolveEffectiveCaptionStyle(preset.captionTemplateId, {})
    expect(style).toEqual(hormoziStyle)
    expect(style).not.toEqual(presetDefaultStyle) // genuinely a different template, not a coincidence
  })
})
