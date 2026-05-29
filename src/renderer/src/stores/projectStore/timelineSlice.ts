/**
 * timelineSlice — playhead + per-clip trim edits within projectStore (STUB;
 * owned by the timeline spine, E.5). Plan E.4 slice pattern; the trim handles
 * write `editedStart/editedEnd` onto the selected clip (PRD §6.6). The trunk
 * ships the slice shape only.
 */

import type { StateCreator } from 'zustand'
import type { ProjectStore } from './index'

export interface TimelineSlice {
  playhead: number
  isPlaying: boolean
  zoom: number
  setPlayhead: (t: number) => void
  setPlaying: (playing: boolean) => void
  setZoom: (zoom: number) => void
  /** Write the minimal-timeline trim bounds onto a clip (PRD §6.6). */
  setClipBounds: (id: string, editedStart: number, editedEnd: number) => void
}

export const createTimelineSlice: StateCreator<ProjectStore, [], [], TimelineSlice> = (
  set,
  get
) => ({
  playhead: 0,
  isPlaying: false,
  zoom: 1,
  setPlayhead: (playhead) => set({ playhead }),
  setPlaying: (isPlaying) => set({ isPlaying }),
  setZoom: (zoom) => set({ zoom }),
  setClipBounds: (id, editedStart, editedEnd) => get().updateClip(id, { editedStart, editedEnd })
})
