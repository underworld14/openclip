/**
 * transcriptSlice — transcript state within projectStore (STUB; owned by
 * T-Media, E.3). Plan E.4: each slice is a `StateCreator` combined once in
 * `index.ts`; thin actions call `window.openclip` directly so backend tracks
 * never touch the store. The trunk ships the slice shape; the track fills in
 * the action bodies.
 */

import type { StateCreator } from 'zustand'
import type { Transcript } from '@shared/schema'
import type { ProjectStore } from './index'

export interface TranscriptSlice {
  transcript: Transcript | null
  transcriptSearch: string
  setTranscript: (transcript: Transcript | null) => void
  setTranscriptSearch: (q: string) => void
}

export const createTranscriptSlice: StateCreator<ProjectStore, [], [], TranscriptSlice> = (
  set
) => ({
  transcript: null,
  transcriptSearch: '',
  setTranscript: (transcript) => set({ transcript }),
  setTranscriptSearch: (transcriptSearch) => set({ transcriptSearch })
})
