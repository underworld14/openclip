/**
 * timeline-math — the PURE coordinate↔time + trim-resolution helpers for the
 * minimal timeline (TIMELINE spine, plan E.5 / PRD §6.6). Kept out of
 * `Timeline.tsx` so the component file only exports a component (react-refresh
 * boundary) AND so all the trim arithmetic is unit-testable without a DOM, a
 * store, or FFmpeg (mirrors `export-run.ts` / `transcript-format.ts`).
 *
 * The minimal timeline shows the SELECTED clip on a single track spanning the
 * full source duration. Two drag handles (in / out) edit the clip's effective
 * bounds; the handles write `editedStart` / `editedEnd` onto the clip
 * (`timelineSlice.setClipBounds` → `updateClip`), which `resolveBounds`
 * (the shared source of truth) then honours on export (PRD §6.6
 * "Export honors the edited bounds").
 *
 * Invariants enforced here (so the UI + store can't produce a bad span):
 *   • bounds stay within `[0, duration]`,
 *   • `start < end` always (a handle can't cross the other; a `minGap` keeps a
 *     minimum positive span so the export never gets a non-positive duration),
 *   • a fractional clamp avoids floating-point drift past the edges.
 */

// Single canonical numeric clamp lives in @shared/reframe-plan (audit fix
// openclip-szp): import it for this module's internal use AND re-export it so the
// existing `import { clamp } from '@renderer/components/timeline-math'` consumers
// (timelineSlice, Timeline) keep working — one definition, no local copy.
import { clamp } from '@shared/reframe-plan'

export { clamp }

/** Which trim handle is being dragged. */
export type TrimHandle = 'in' | 'out'

/**
 * Map a pixel X (relative to the track's left edge) to an absolute time in the
 * source, given the track's rendered width and the source duration. Clamped to
 * `[0, duration]`. A zero/negative width yields 0 (degenerate layout).
 */
export function pxToTime(px: number, trackWidthPx: number, duration: number): number {
  if (!(trackWidthPx > 0) || !(duration > 0)) return 0
  return clamp((px / trackWidthPx) * duration, 0, duration)
}

/**
 * Map an absolute time to a 0..1 fraction of the track (for positioning the
 * clip region + handles via `left`/`width` percentages). Clamped to `[0, 1]`.
 */
export function timeToFraction(time: number, duration: number): number {
  if (!(duration > 0)) return 0
  return clamp(time / duration, 0, 1)
}

/** A clip's effective trim bounds (post-edit) — what the handles render + edit. */
export interface TrimBounds {
  start: number
  end: number
}

/**
 * The minimum positive span (seconds) a clip may be trimmed to — keeps the
 * handles from crossing and guarantees `end > start` so export never receives a
 * non-positive duration (matches the `buildExportParams` guard).
 */
export const MIN_TRIM_GAP = 0.1

/**
 * Apply a drag of one handle to the current bounds, returning the new
 * `{ start, end }`. The dragged handle moves to `time` (already clamped to the
 * track by `pxToTime`); the OTHER handle is the fixed pivot. The moving handle
 * is additionally clamped so it stays at least `minGap` from the pivot and
 * within `[0, duration]`.
 *
 *   - dragging 'in'  → new start = clamp(time, 0, end - minGap)
 *   - dragging 'out' → new end   = clamp(time, start + minGap, duration)
 */
export function applyHandleDrag(args: {
  handle: TrimHandle
  time: number
  bounds: TrimBounds
  duration: number
  minGap?: number
}): TrimBounds {
  const { handle, time, bounds, duration } = args
  const minGap = args.minGap ?? MIN_TRIM_GAP
  if (handle === 'in') {
    const start = clamp(time, 0, bounds.end - minGap)
    return { start, end: bounds.end }
  }
  const end = clamp(time, bounds.start + minGap, duration)
  return { start: bounds.start, end }
}

/**
 * Compute the new bounds for a keyboard "mark in" (I) at the playhead: set the
 * IN point to the current playhead, clamped so it stays below the OUT point.
 */
export function markInAt(playhead: number, bounds: TrimBounds, minGap = MIN_TRIM_GAP): TrimBounds {
  return { start: clamp(playhead, 0, bounds.end - minGap), end: bounds.end }
}

/**
 * Compute the new bounds for a keyboard "mark out" (O) at the playhead: set the
 * OUT point to the current playhead, clamped so it stays above the IN point and
 * within the source duration.
 */
export function markOutAt(
  playhead: number,
  bounds: TrimBounds,
  duration: number,
  minGap = MIN_TRIM_GAP
): TrimBounds {
  return { start: bounds.start, end: clamp(playhead, bounds.start + minGap, duration) }
}

/** Format a time (seconds) as `m:ss.cs` for the timeline/preview readout. */
export function formatTime(seconds: number): string {
  const s = Math.max(0, seconds)
  const m = Math.floor(s / 60)
  const rem = s - m * 60
  const whole = Math.floor(rem)
  const cs = Math.round((rem - whole) * 100)
  // carry if centiseconds rounded up to 100
  const ss = cs === 100 ? whole + 1 : whole
  const csOut = cs === 100 ? 0 : cs
  return `${m}:${String(ss).padStart(2, '0')}.${String(csOut).padStart(2, '0')}`
}
