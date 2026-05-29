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
})
