/**
 * tests/unit/timeline-slice.spec.ts — the timelineSlice within projectStore
 * (TIMELINE spine, plan E.5 / PRD §6.6). Proves the trim actions persist
 * `editedStart`/`editedEnd` onto the SELECTED clip and that the SHARED
 * `resolveBounds` then reflects those edits — the cross-cut to export (fix M2:
 * "Export honors the edited bounds").
 *
 * Uses the real combined store (slices combined in index.ts).
 */

import { describe, expect, it, beforeEach } from 'vitest'
import { useProjectStore } from '@renderer/stores/projectStore'
import { resolveBounds } from '@shared/clip-bounds'
import { clipFixture } from '../fixtures/contract'
import type { Clip } from '@shared/schema'

const DURATION = 60

function seedOneClip(): Clip {
  // A clip with NO edits yet (suggested span 12.5..41), selected.
  const clip: Clip = {
    ...clipFixture,
    id: 'tl-clip',
    startTime: 12.5,
    endTime: 41,
    editedStart: undefined,
    editedEnd: undefined
  }
  useProjectStore.setState({
    clips: [clip],
    selectedClipId: clip.id,
    playhead: 0,
    isPlaying: false,
    zoom: 1
  })
  return clip
}

function liveClip(): Clip {
  return useProjectStore.getState().clips[0]
}

describe('timelineSlice: transient view state', () => {
  beforeEach(seedOneClip)

  it('setPlayhead / setPlaying / setZoom update state', () => {
    const s = useProjectStore.getState()
    s.setPlayhead(12.3)
    s.setPlaying(true)
    s.setZoom(2)
    const next = useProjectStore.getState()
    expect(next.playhead).toBe(12.3)
    expect(next.isPlaying).toBe(true)
    expect(next.zoom).toBe(2)
  })
})

describe('timelineSlice: setClipBounds (direct write)', () => {
  beforeEach(seedOneClip)

  it('writes editedStart/editedEnd onto the clip and resolveBounds reflects it', () => {
    useProjectStore.getState().setClipBounds('tl-clip', 15, 30)
    const c = liveClip()
    expect(c.editedStart).toBe(15)
    expect(c.editedEnd).toBe(30)
    expect(resolveBounds(c)).toEqual({ start: 15, end: 30 })
  })
})

describe('timelineSlice: dragClipHandle (drag-handle retrim)', () => {
  beforeEach(seedOneClip)

  it('dragging the IN handle updates editedStart (resolveBounds reflects it)', () => {
    useProjectStore.getState().dragClipHandle('tl-clip', 'in', 20, DURATION)
    const c = liveClip()
    expect(c.editedStart).toBe(20)
    expect(c.editedEnd).toBe(41) // unchanged OUT (fell back from endTime)
    expect(resolveBounds(c)).toEqual({ start: 20, end: 41 })
  })

  it('dragging the OUT handle updates editedEnd (resolveBounds reflects it)', () => {
    useProjectStore.getState().dragClipHandle('tl-clip', 'out', 35, DURATION)
    const c = liveClip()
    expect(c.editedStart).toBe(12.5) // unchanged IN (fell back from startTime)
    expect(c.editedEnd).toBe(35)
    expect(resolveBounds(c)).toEqual({ start: 12.5, end: 35 })
  })

  it('clamps a handle drag so the span stays positive (handles cannot cross)', () => {
    // Drag IN past OUT — it should clamp just below the OUT point.
    useProjectStore.getState().dragClipHandle('tl-clip', 'in', 99, DURATION)
    const c = liveClip()
    const { start, end } = resolveBounds(c)
    expect(start).toBeLessThan(end)
  })

  it('is a no-op for an unknown clip id', () => {
    useProjectStore.getState().dragClipHandle('nope', 'in', 20, DURATION)
    expect(liveClip().editedStart).toBeUndefined()
  })
})

describe('timelineSlice: markIn / markOut at the playhead (I / O keys)', () => {
  beforeEach(seedOneClip)

  it('markIn sets editedStart to the current playhead', () => {
    useProjectStore.getState().setPlayhead(18)
    useProjectStore.getState().markIn('tl-clip')
    const c = liveClip()
    expect(c.editedStart).toBe(18)
    expect(resolveBounds(c).start).toBe(18)
  })

  it('markOut sets editedEnd to the current playhead', () => {
    useProjectStore.getState().setPlayhead(33)
    useProjectStore.getState().markOut('tl-clip', DURATION)
    const c = liveClip()
    expect(c.editedEnd).toBe(33)
    expect(resolveBounds(c).end).toBe(33)
  })

  it('mark in/out together produce a coherent trimmed span honored by resolveBounds', () => {
    const store = useProjectStore.getState()
    store.setPlayhead(16)
    store.markIn('tl-clip')
    useProjectStore.getState().setPlayhead(28)
    useProjectStore.getState().markOut('tl-clip', DURATION)
    expect(resolveBounds(liveClip())).toEqual({ start: 16, end: 28 })
  })
})
