/**
 * tests/unit/import-pipeline.spec.ts — the I1 vertical-slice orchestration
 * (import → audio extract → transcribe) as a PURE async function driven by the
 * mock OpenClip bridge + the fake-port harness. This is the headless heart of
 * ImportPanel: it proves the slice end-to-end (events stream, the store hydrates)
 * without a DOM. The DOM/visual proof is the Playwright E2E.
 */

import { describe, expect, it } from 'vitest'
import { runImportPipeline } from '@renderer/components/import-pipeline'
import { createMockOpenclip } from '../mocks/openclip'
import { transcribeResultFixture, transcribePartialFixture } from '../fixtures/contract'

describe('runImportPipeline: import → extract → transcribe', () => {
  it('probes, extracts, transcribes, streams progress + partials, returns transcript', async () => {
    const openclip = createMockOpenclip()
    const progresses: number[] = []
    const partials: number[] = []
    let hydrated: typeof transcribeResultFixture | null = null

    const result = await runImportPipeline({
      bridge: openclip,
      filePath: '/tmp/sample.mp4',
      projectId: 'p1',
      model: 'base',
      onProgress: (pct, stage) => progresses.push(pct) || void stage,
      onPartial: (p) => partials.push(p.words.length),
      onTranscript: (t) => {
        hydrated = t
      }
    })

    // Probe → sourceVideo from the mock IMPORT_VIDEO canned fixture.
    expect(result.sourceVideo).toBeTruthy()
    expect(result.sourceVideo.duration).toBeGreaterThan(0)
    // Extract → a wav path.
    expect(result.wavPath).toMatch(/\.16k\.wav$|audio\.16k\.wav/)
    // Transcribe streamed progress + at least one partial, and produced the
    // contract transcribe result (the default script ends in `done`).
    expect(progresses.length).toBeGreaterThan(0)
    expect(partials.reduce((a, b) => a + b, 0)).toBeGreaterThan(0)
    expect(result.transcript).toEqual(transcribeResultFixture)
    expect(hydrated).toEqual(transcribeResultFixture)
    void transcribePartialFixture
  })

  it('surfaces a job error as a thrown pipeline error (no silent hang)', async () => {
    const openclip = createMockOpenclip({
      scripts: {
        transcribe: {
          steps: [
            { t: 'progress', pct: 10, stage: 'transcribing' },
            { t: 'error', code: 'SIDECAR_CRASH', message: 'whisper died', retriable: true }
          ]
        }
      }
    })
    await expect(
      runImportPipeline({
        bridge: openclip,
        filePath: '/tmp/sample.mp4',
        projectId: 'p1',
        model: 'base'
      })
    ).rejects.toThrow(/whisper died|SIDECAR_CRASH/)
  })

  // EPIC-k83ghw / BUG-sg6kqg: extraction used to be a plain `invoke` — no jobId,
  // no progress, so Cancel during "Extracting audio" was a silent no-op and the
  // bar sat frozen. It is now the `extract-audio` streaming job like every other
  // long operation; these two tests pin exactly the behaviour that fixes.
  it('extraction reports its own jobId (so a caller can cancel it) and advances progress', async () => {
    const openclip = createMockOpenclip()
    let extractJobId: string | null = null
    const stagesSeen: string[] = []

    await runImportPipeline({
      bridge: openclip,
      filePath: '/tmp/sample.mp4',
      projectId: 'p1',
      model: 'base',
      onExtractStart: (jobId) => {
        extractJobId = jobId
      },
      onProgress: (_pct, stage) => stagesSeen.push(stage)
    })

    expect(extractJobId).toMatch(/^extract-audio-/)
    // The default mock script reports a mid-extraction progress tick before
    // `done` — proof the bar moves instead of sitting frozen at one value.
    expect(stagesSeen.filter((s) => s === 'extracting').length).toBeGreaterThan(1)
  })

  it('a cancelled extraction surfaces as a thrown pipeline error, not a hang', async () => {
    const openclip = createMockOpenclip({
      scripts: {
        'extract-audio': {
          steps: [
            { t: 'progress', pct: 10, stage: 'extracting' },
            { t: 'error', code: 'CANCELLED', message: 'job cancelled', retriable: false }
          ]
        }
      }
    })
    await expect(
      runImportPipeline({
        bridge: openclip,
        filePath: '/tmp/sample.mp4',
        projectId: 'p1',
        model: 'base'
      })
    ).rejects.toThrow(/CANCELLED/)
  })
})
