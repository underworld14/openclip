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
import { snapClipBounds } from '@shared/clip-snap'
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

/**
 * Pull a keyboard mark onto the nearest word/sentence boundary (BUG-yq6qbw).
 *
 * Applied to the DISCRETE I/O marks only, not to `dragClipHandle`. A drag calls
 * its action continuously, so snapping there would make the handle stick to
 * boundaries and fight the user mid-gesture; a mark is a single deliberate
 * action, which is exactly where an assist helps. The tolerance is deliberately
 * tighter than the AI pipeline's — a user aiming at a specific frame should not
 * be moved a second and a half.
 */
const MARK_SNAP_TOLERANCE_SEC = 0.35

function snapMark(
  get: () => ProjectStore,
  next: { start: number; end: number }
): { start: number; end: number } {
  const transcript = get().transcript
  if (!transcript) return next
  const snapped = snapClipBounds(
    { start: next.start, end: next.end, segments: transcript.segments, words: transcript.words },
    {
      // Bounds are already valid here; the snap must only refine them, so the
      // duration window is opened wide enough not to reject a small nudge.
      minDuration: 0,
      maxDuration: Number.POSITIVE_INFINITY,
      toleranceSec: MARK_SNAP_TOLERANCE_SEC
    }
  )
  return { start: snapped.start, end: snapped.end }
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
    const snapped = snapMark(get, next)
    get().updateClip(id, { editedStart: snapped.start, editedEnd: snapped.end })
  },
  markOut: (id, duration) => {
    const clip = findClip(get, id)
    if (!clip) return
    const nextRaw = markOutAt(get().playhead, resolveBounds(clip), duration)
    const next = snapMark(get, nextRaw)
    get().updateClip(id, { editedStart: next.start, editedEnd: next.end })
  }
})
