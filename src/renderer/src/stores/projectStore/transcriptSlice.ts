/**
 * transcriptSlice — transcript state within projectStore (T-Media, E.3).
 *
 * Plan E.4: each slice is a `StateCreator` combined once in `index.ts`; thin
 * actions call `window.openclip` directly so backend tracks never touch the
 * store. The trunk shipped the slice shape (transcript + search + setters); this
 * track fills it out with the I1 vertical-slice actions:
 *
 *   - `hydrateTranscript(result)` — set the full transcript from a transcribe
 *     job `done` result (JobResult['transcribe']) → drops straight into
 *     `Project.transcript` (the result is exactly that body minus v0.4 speakers).
 *   - `appendTranscriptPartial(partial)` — append streamed words + closed
 *     segments live as the job runs (JobPartial['transcribe'], PRD §6.2 sidebar).
 *   - `matchingSegments()` — segments filtered by the search query (PRD §6.2).
 */

import type { StateCreator } from 'zustand'
import type { Transcript, TranscriptSegment } from '@shared/schema'
import type { JobResult, JobPartial } from '@shared/jobs'
import type { ProjectStore } from './index'

export interface TranscriptSlice {
  transcript: Transcript | null
  transcriptSearch: string
  setTranscript: (transcript: Transcript | null) => void
  setTranscriptSearch: (q: string) => void
  /** Set the full transcript from a transcribe job `done` result. */
  hydrateTranscript: (result: JobResult['transcribe']) => void
  /** Append streamed words + closed segments as the transcribe job runs. */
  appendTranscriptPartial: (partial: JobPartial['transcribe']) => void
  /** Segments matching the current search query (all when empty) — PRD §6.2. */
  matchingSegments: () => TranscriptSegment[]
}

const EMPTY: Transcript = { language: '', segments: [], words: [] }

export const createTranscriptSlice: StateCreator<ProjectStore, [], [], TranscriptSlice> = (
  set,
  get
) => ({
  transcript: null,
  transcriptSearch: '',
  setTranscript: (transcript) => set({ transcript }),
  setTranscriptSearch: (transcriptSearch) => set({ transcriptSearch }),

  hydrateTranscript: (result) =>
    set({
      transcript: {
        language: result.language,
        segments: result.segments,
        words: result.words
      }
    }),

  appendTranscriptPartial: (partial) =>
    set((s) => {
      const base = s.transcript ?? EMPTY
      return {
        transcript: {
          ...base,
          words: [...base.words, ...partial.words],
          segments: [...base.segments, ...partial.segments]
        }
      }
    }),

  matchingSegments: () => {
    const t = get().transcript
    if (!t) return []
    const q = get().transcriptSearch.trim().toLowerCase()
    if (q.length === 0) return t.segments
    return t.segments.filter((seg) => seg.text.toLowerCase().includes(q))
  }
})
