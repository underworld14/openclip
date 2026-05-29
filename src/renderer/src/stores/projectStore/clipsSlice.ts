/**
 * clipsSlice — clip suggestions/edits within projectStore (STUB; owned by
 * T-AI, E.3). Plan E.4 slice pattern. Thin actions call `window.openclip`
 * directly. The trunk ships the slice shape; the track fills action bodies.
 */

import type { StateCreator } from 'zustand'
import type { Clip } from '@shared/schema'
import type { ProjectStore } from './index'

export interface ClipsSlice {
  clips: Clip[]
  selectedClipId: string | null
  setClips: (clips: Clip[]) => void
  updateClip: (id: string, patch: Partial<Clip>) => void
  selectClip: (id: string | null) => void
}

export const createClipsSlice: StateCreator<ProjectStore, [], [], ClipsSlice> = (set) => ({
  clips: [],
  selectedClipId: null,
  setClips: (clips) => set({ clips }),
  updateClip: (id, patch) =>
    set((s) => ({ clips: s.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) })),
  selectClip: (selectedClipId) => set({ selectedClipId })
})
