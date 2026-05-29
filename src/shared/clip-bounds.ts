/**
 * src/shared/clip-bounds.ts — the PURE clip-bounds resolver (critic fix M2).
 *
 * `resolveBounds(clip)` is the ONE place that decides the effective export span
 * of a clip: the minimal-timeline trim (`editedStart`/`editedEnd`) wins over the
 * AI-suggested span (`startTime`/`endTime`) when present (PRD §6.6 "Export
 * honors the edited bounds"; §9.3 `Clip.editedStart/editedEnd`).
 *
 * It lives in `src/shared/` — NOT in the export service or the timeline — so
 * BOTH can import it and it is testable in complete isolation, without any
 * FFmpeg, Electron, or timeline state (critic fix M2: "a PURE, standalone-tested
 * resolveBounds, testable WITHOUT the timeline"). It is a leaf module with no
 * dependencies beyond the frozen `Clip` type.
 */

import type { Clip } from './schema'

/** The effective [start,end] export span of a clip, in absolute seconds. */
export interface ClipBounds {
  /** Where the export cut begins (seconds, absolute into the source). */
  start: number
  /** Where the export cut ends (seconds, absolute into the source). */
  end: number
}

/**
 * Resolve a clip's effective export bounds.
 *
 *   start = clip.editedStart ?? clip.startTime
 *   end   = clip.editedEnd   ?? clip.endTime
 *
 * The timeline writes `editedStart/editedEnd` when the user drags the trim
 * handles (PRD §6.6); when unset, the AI-suggested span is used. The `??`
 * (nullish coalescing) is deliberate: a legitimate `0` edited bound is honoured,
 * only `undefined`/`null` falls back to the suggested span.
 */
export function resolveBounds(clip: Clip): ClipBounds {
  return {
    start: clip.editedStart ?? clip.startTime,
    end: clip.editedEnd ?? clip.endTime
  }
}

/** Duration (seconds) of a clip's effective export span. May be ≤0 if mis-trimmed. */
export function resolveDuration(clip: Clip): number {
  const { start, end } = resolveBounds(clip)
  return end - start
}
