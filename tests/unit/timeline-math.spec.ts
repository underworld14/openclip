/**
 * tests/unit/timeline-math.spec.ts — the PURE minimal-timeline arithmetic
 * (TIMELINE spine, plan E.5 / PRD §6.6). Tested WITHOUT a DOM/store/FFmpeg
 * (mirrors clip-bounds.spec / export-slice pure tests).
 *
 * Load-bearing assertions: a drag of a handle resolves to clamped
 * `editedStart`/`editedEnd` (in [0,duration], start < end with a min gap, handles
 * never cross), and mark-in/out at the playhead behave the same way.
 */

import { describe, expect, it } from 'vitest'
import {
  clamp,
  pxToTime,
  timeToFraction,
  applyHandleDrag,
  markInAt,
  markOutAt,
  formatTime,
  computeVisibleWindow,
  windowToFraction,
  pxToWindowTime,
  MIN_TRIM_GAP,
  type TrimBounds
} from '@renderer/components/timeline-math'

describe('clamp', () => {
  it('clamps into [lo,hi]', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-1, 0, 10)).toBe(0)
    expect(clamp(11, 0, 10)).toBe(10)
  })
})

describe('pxToTime', () => {
  it('maps pixels to absolute time across the track width', () => {
    // 200px track, 60s duration → 100px = 30s.
    expect(pxToTime(100, 200, 60)).toBe(30)
    expect(pxToTime(0, 200, 60)).toBe(0)
    expect(pxToTime(200, 200, 60)).toBe(60)
  })
  it('clamps out-of-bounds pixels to [0,duration]', () => {
    expect(pxToTime(-50, 200, 60)).toBe(0)
    expect(pxToTime(500, 200, 60)).toBe(60)
  })
  it('returns 0 for a degenerate width or duration', () => {
    expect(pxToTime(100, 0, 60)).toBe(0)
    expect(pxToTime(100, 200, 0)).toBe(0)
  })
})

describe('timeToFraction', () => {
  it('maps a time to a 0..1 fraction', () => {
    expect(timeToFraction(30, 60)).toBe(0.5)
    expect(timeToFraction(0, 60)).toBe(0)
    expect(timeToFraction(60, 60)).toBe(1)
  })
  it('clamps and guards a zero duration', () => {
    expect(timeToFraction(90, 60)).toBe(1)
    expect(timeToFraction(-5, 60)).toBe(0)
    expect(timeToFraction(5, 0)).toBe(0)
  })
})

describe('applyHandleDrag', () => {
  const bounds: TrimBounds = { start: 10, end: 40 }
  const duration = 60

  it('dragging the IN handle sets the new start (editedStart)', () => {
    expect(applyHandleDrag({ handle: 'in', time: 15, bounds, duration })).toEqual({
      start: 15,
      end: 40
    })
  })

  it('dragging the OUT handle sets the new end (editedEnd)', () => {
    expect(applyHandleDrag({ handle: 'out', time: 35, bounds, duration })).toEqual({
      start: 10,
      end: 35
    })
  })

  it('the IN handle cannot cross the OUT handle (min gap held)', () => {
    const next = applyHandleDrag({ handle: 'in', time: 50, bounds, duration })
    expect(next.start).toBeCloseTo(bounds.end - MIN_TRIM_GAP)
    expect(next.start).toBeLessThan(next.end)
  })

  it('the OUT handle cannot cross the IN handle (min gap held)', () => {
    const next = applyHandleDrag({ handle: 'out', time: 5, bounds, duration })
    expect(next.end).toBeCloseTo(bounds.start + MIN_TRIM_GAP)
    expect(next.end).toBeGreaterThan(next.start)
  })

  it('clamps the IN handle to >= 0', () => {
    expect(applyHandleDrag({ handle: 'in', time: -5, bounds, duration }).start).toBe(0)
  })

  it('clamps the OUT handle to <= duration', () => {
    expect(applyHandleDrag({ handle: 'out', time: 999, bounds, duration }).end).toBe(duration)
  })
})

describe('markInAt / markOutAt', () => {
  const bounds: TrimBounds = { start: 10, end: 40 }
  const duration = 60

  it('markInAt sets the IN point to the playhead', () => {
    expect(markInAt(20, bounds)).toEqual({ start: 20, end: 40 })
  })
  it('markOutAt sets the OUT point to the playhead', () => {
    expect(markOutAt(30, bounds, duration)).toEqual({ start: 10, end: 30 })
  })
  it('markInAt cannot pass the OUT point', () => {
    expect(markInAt(45, bounds).start).toBeCloseTo(bounds.end - MIN_TRIM_GAP)
  })
  it('markOutAt cannot pass the IN point and is duration-clamped', () => {
    expect(markOutAt(5, bounds, duration).end).toBeCloseTo(bounds.start + MIN_TRIM_GAP)
    expect(markOutAt(100, bounds, duration).end).toBe(duration)
  })
})

describe('formatTime', () => {
  it('formats m:ss.cs', () => {
    expect(formatTime(0)).toBe('0:00.00')
    expect(formatTime(5.25)).toBe('0:05.25')
    expect(formatTime(65.5)).toBe('1:05.50')
  })
  it('clamps negatives to 0:00.00', () => {
    expect(formatTime(-3)).toBe('0:00.00')
  })
  it('carries centisecond rounding cleanly', () => {
    // 9.999 rounds cs to 100 → carries to the next whole second.
    expect(formatTime(9.999)).toBe('0:10.00')
  })
})

describe('computeVisibleWindow (EPIC-k83ghw / BUG-9v667j)', () => {
  it('is a comfortable multiple of a SHORT clip on a LONG source, not the whole source', () => {
    // The bug this fixes: a 45s clip in a 60-minute (3600s) source used to
    // render at ~1.25% of the track. The window must be small relative to
    // the full duration so the clip occupies a real, grabbable fraction.
    const bounds: TrimBounds = { start: 1800, end: 1845 } // 45s clip, mid-source
    const win = computeVisibleWindow(bounds, 3600, 1)
    const windowSpan = win.end - win.start
    expect(windowSpan).toBeLessThan(200) // nowhere near the 3600s source
    expect(win.start).toBeLessThan(bounds.start) // padding on the left…
    expect(win.end).toBeGreaterThan(bounds.end) // …and the right, to drag outward
  })

  it('gives even a very short clip a minimum floor of room, not a near-zero window', () => {
    const bounds: TrimBounds = { start: 100, end: 100.5 } // 0.5s clip
    const win = computeVisibleWindow(bounds, 3600, 1)
    expect(win.end - win.start).toBeGreaterThan(5) // the 3s-per-side floor, not span*0.75
  })

  it('zooming IN (higher zoom) shrinks the window; zooming OUT widens it', () => {
    const bounds: TrimBounds = { start: 100, end: 140 }
    const base = computeVisibleWindow(bounds, 3600, 1)
    const zoomedIn = computeVisibleWindow(bounds, 3600, 2)
    const zoomedOut = computeVisibleWindow(bounds, 3600, 0.5)
    expect(zoomedIn.end - zoomedIn.start).toBeLessThan(base.end - base.start)
    expect(zoomedOut.end - zoomedOut.start).toBeGreaterThan(base.end - base.start)
  })

  it('clamps to [0, duration] near the edges of the source', () => {
    const win = computeVisibleWindow({ start: 0, end: 5 }, 3600, 1)
    expect(win.start).toBe(0)
    const winEnd = computeVisibleWindow({ start: 3595, end: 3600 }, 3600, 1)
    expect(winEnd.end).toBe(3600)
  })

  it('falls back to the whole source for a degenerate/zero duration', () => {
    expect(computeVisibleWindow({ start: 0, end: 0 }, 0, 1)).toEqual({ start: 0, end: 0 })
  })

  it('a non-positive zoom is treated as 1x rather than dividing by zero/negative', () => {
    const bounds: TrimBounds = { start: 100, end: 140 }
    const zoomZero = computeVisibleWindow(bounds, 3600, 0)
    const zoomOne = computeVisibleWindow(bounds, 3600, 1)
    expect(zoomZero).toEqual(zoomOne)
  })
})

describe('windowToFraction', () => {
  it('maps a time within the window to 0..1, unlike timeToFraction which uses the whole source', () => {
    const win = { start: 100, end: 200 }
    expect(windowToFraction(100, win)).toBe(0)
    expect(windowToFraction(150, win)).toBe(0.5)
    expect(windowToFraction(200, win)).toBe(1)
  })
  it('clamps outside the window', () => {
    const win = { start: 100, end: 200 }
    expect(windowToFraction(50, win)).toBe(0)
    expect(windowToFraction(250, win)).toBe(1)
  })
  it('returns 0 for a degenerate window', () => {
    expect(windowToFraction(50, { start: 100, end: 100 })).toBe(0)
  })
})

describe('pxToWindowTime', () => {
  it('maps a pixel to an absolute time OFFSET by the window start', () => {
    // 200px track, a 100..160 (60s span) window → 100px = halfway = 130.
    expect(pxToWindowTime(100, 200, { start: 100, end: 160 })).toBe(130)
    expect(pxToWindowTime(0, 200, { start: 100, end: 160 })).toBe(100)
    expect(pxToWindowTime(200, 200, { start: 100, end: 160 })).toBe(160)
  })
  it('stays within the window even for an out-of-bounds pixel', () => {
    expect(pxToWindowTime(-50, 200, { start: 100, end: 160 })).toBe(100)
    expect(pxToWindowTime(500, 200, { start: 100, end: 160 })).toBe(160)
  })
})
