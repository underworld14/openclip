/**
 * tests/unit/transcript-slice.spec.ts — the transcriptSlice within projectStore
 * (T-Media, E.3). Proves the store HYDRATES from a transcribe `done` result and
 * APPENDS live `partial` words/segments as they stream, plus search filtering.
 * Uses the real combined store (slices combined in index.ts).
 */

import { describe, expect, it, beforeEach } from 'vitest'
import { useProjectStore } from '@renderer/stores/projectStore'
import { transcribeResultFixture, transcribePartialFixture } from '../fixtures/contract'
import { Transcript } from '@shared/schema'

function reset(): void {
  useProjectStore.setState({ transcript: null, transcriptSearch: '' })
}

describe('transcriptSlice: hydrate from a transcribe done result', () => {
  beforeEach(reset)

  it('setTranscript stores a contract-valid Transcript', () => {
    useProjectStore.getState().hydrateTranscript(transcribeResultFixture)
    const t = useProjectStore.getState().transcript
    expect(t).not.toBeNull()
    expect(t!.language).toBe('en')
    expect(t!.segments.length).toBe(transcribeResultFixture.segments.length)
    expect(t!.words.length).toBe(transcribeResultFixture.words.length)
    expect(() => Transcript.parse(t)).not.toThrow()
  })

  it('appendTranscriptPartial accumulates streamed words + closed segments', () => {
    // Start from an empty live transcript and stream a partial in.
    useProjectStore.getState().appendTranscriptPartial(transcribePartialFixture)
    const t1 = useProjectStore.getState().transcript
    expect(t1).not.toBeNull()
    expect(t1!.words.length).toBe(transcribePartialFixture.words.length)
    expect(t1!.segments.length).toBe(transcribePartialFixture.segments.length)

    // A second partial appends (does not replace).
    useProjectStore.getState().appendTranscriptPartial({
      words: [{ word: 'More.', start: 9, end: 9.5, confidence: 0.9 }],
      segments: [{ id: 'seg-x', start: 9, end: 9.5, text: 'More.', confidence: 0.9 }]
    })
    const t2 = useProjectStore.getState().transcript
    expect(t2!.words.length).toBe(transcribePartialFixture.words.length + 1)
    expect(t2!.segments.length).toBe(transcribePartialFixture.segments.length + 1)
  })
})

describe('transcriptSlice: search', () => {
  beforeEach(reset)

  it('setTranscriptSearch stores the query; matchingSegments filters by text', () => {
    useProjectStore.getState().hydrateTranscript(transcribeResultFixture)
    useProjectStore.getState().setTranscriptSearch('wild')
    expect(useProjectStore.getState().transcriptSearch).toBe('wild')
    const matches = useProjectStore.getState().matchingSegments()
    // The fixture's seg-2 contains "wild" (case-insensitive).
    expect(matches.length).toBe(1)
    expect(matches[0].text.toLowerCase()).toContain('wild')
  })

  it('empty query returns all segments', () => {
    useProjectStore.getState().hydrateTranscript(transcribeResultFixture)
    useProjectStore.getState().setTranscriptSearch('')
    expect(useProjectStore.getState().matchingSegments().length).toBe(
      transcribeResultFixture.segments.length
    )
  })
})
