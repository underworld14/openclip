/**
 * timelineSlice — playhead + per-clip trim edits within projectStore
 * (TIMELINE spine, plan E.5 / E.4 slice pattern; PRD §6.6).
 *
 * The minimal timeline writes `editedStart` / `editedEnd` onto the SELECTED clip
 * when the user drags the trim handles or hits I / O. Those edits flow through
 * `updateClip` (clipsSlice) onto the clip, and the SHARED pure `resolveBounds`
 * (`editedStart ?? startTime`, `editedEnd ?? endTime`) honours them on export
 * (PRD §6.6 "Export honors the edited bounds"; critic fix M2). This slice owns
 * the transient view state (playhead / isPlaying / zoom) + the thin trim actions;
 * all the clamping arithmetic lives in the pure `timeline-math` helpers so it is
 * unit-testable without a store.
 */

import type { StateCreator } from 'zustand'
import type { ProjectStore } from './index'
import {
  applyHandleDrag,
  markInAt,
  markOutAt,
  type TrimHandle,
  type TrimBounds
} from '@renderer/components/timeline-math'
import { resolveBounds } from '@shared/clip-bounds'
import type { Clip } from '@shared/schema'

export interface TimelineSlice {
  playhead: number
  isPlaying: boolean
  zoom: number
  setPlayhead: (t: number) => void
  setPlaying: (playing: boolean) => void
  setZoom: (zoom: number) => void
  /** Write the minimal-timeline trim bounds onto a clip (PRD §6.6). */
  setClipBounds: (id: string, editedStart: number, editedEnd: number) => void
  /**
   * Apply a drag of one trim handle to `time` (absolute seconds) on the given
   * clip, clamping against the source duration + the other handle, and persist
   * the resulting bounds as `editedStart`/`editedEnd` (PRD §6.6).
   */
  dragClipHandle: (id: string, handle: TrimHandle, time: number, duration: number) => void
  /** Keyboard I: set the selected clip's IN point to the current playhead. */
  markIn: (id: string) => void
  /** Keyboard O: set the selected clip's OUT point to the current playhead. */
  markOut: (id: string, duration: number) => void
}

/** Find a clip by id in the live clips slice (the source of truth for bounds). */
function findClip(get: () => ProjectStore, id: string): Clip | undefined {
  return get().clips.find((c) => c.id === id)
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
  setClipBounds: (id, editedStart, editedEnd) => get().updateClip(id, { editedStart, editedEnd }),
  dragClipHandle: (id, handle, time, duration) => {
    const clip = findClip(get, id)
    if (!clip) return
    const bounds: TrimBounds = resolveBounds(clip)
    const next = applyHandleDrag({ handle, time, bounds, duration })
    get().updateClip(id, { editedStart: next.start, editedEnd: next.end })
  },
  markIn: (id) => {
    const clip = findClip(get, id)
    if (!clip) return
    const next = markInAt(get().playhead, resolveBounds(clip))
    get().updateClip(id, { editedStart: next.start, editedEnd: next.end })
  },
  markOut: (id, duration) => {
    const clip = findClip(get, id)
    if (!clip) return
    const next = markOutAt(get().playhead, resolveBounds(clip), duration)
    get().updateClip(id, { editedStart: next.start, editedEnd: next.end })
  }
})
