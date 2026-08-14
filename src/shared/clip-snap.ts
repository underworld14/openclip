/**
 * src/shared/clip-snap.ts — pull clip boundaries onto natural speech boundaries
 * (BUG-yq6qbw).
 *
 * THE PROBLEM. `clampDetectedClips` enforces the max duration with
 * `end = start + maxDuration` — pure arithmetic, with no reference to the
 * transcript. When a model ignores the prompt's length cap (which it does
 * occasionally), the clip is cut at exactly that second, which lands mid-word
 * essentially every time: an audible chop on the last syllable. More broadly,
 * nothing anywhere snapped a clip boundary to anything —
 * `grep -rniE "snap|sentence" src/` found only transcript grouping and the
 * unrelated silence-removal gap snapping.
 *
 * THE RULE, in preference order:
 *   1. a SENTENCE boundary (a transcript segment edge) within tolerance — the
 *      best cut, because the clip begins and ends on a complete thought;
 *   2. failing that, a WORD gap — never mid-word, even if mid-sentence;
 *   3. failing that, the raw value, unchanged.
 *
 * A snap may never violate the caller's min/max duration: a boundary that would
 * push the clip outside those bounds is rejected in favour of the next candidate.
 * This module is PURE and framework-free so both the AI reduce step and the
 * timeline's trim handles can share exactly one definition of "a good cut".
 */

import type { TranscriptSegment, WordTimestamp } from './schema'

/** How far a boundary may move to reach a nicer cut. */
export const DEFAULT_SNAP_TOLERANCE_SEC = 1.5

export interface SnapOptions {
  minDuration: number
  maxDuration: number
  /** Max seconds a boundary may move. Default `DEFAULT_SNAP_TOLERANCE_SEC`. */
  toleranceSec?: number
}

export interface SnapInput {
  start: number
  end: number
  segments?: TranscriptSegment[]
  words?: WordTimestamp[]
}

/** Candidate cut points, deduped and sorted, that a boundary may snap to. */
function boundaryTimes(times: number[]): number[] {
  return [...new Set(times.filter((t) => Number.isFinite(t) && t >= 0))].sort((a, b) => a - b)
}

/** Sentence edges — the preferred cut points. */
export function sentenceBoundaries(segments: TranscriptSegment[] = []): number[] {
  return boundaryTimes(segments.flatMap((s) => [s.start, s.end]))
}

/**
 * Word edges — the fallback. A cut here is still mid-sentence, but it is never
 * mid-word, which is the difference between "ends early" and "sounds broken".
 */
export function wordBoundaries(words: WordTimestamp[] = []): number[] {
  return boundaryTimes(words.flatMap((w) => [w.start, w.end]))
}

/**
 * The nearest candidate to `target` within `tolerance` that `accept` allows.
 * Returns `null` when nothing qualifies, so the caller keeps the raw value
 * rather than being forced onto a worse boundary.
 */
function nearestAcceptable(
  target: number,
  candidates: number[],
  tolerance: number,
  accept: (t: number) => boolean
): number | null {
  let best: number | null = null
  let bestDistance = Infinity
  for (const c of candidates) {
    const d = Math.abs(c - target)
    if (d > tolerance || d >= bestDistance) continue
    if (!accept(c)) continue
    best = c
    bestDistance = d
  }
  return best
}

/**
 * Snap a clip's bounds to the nearest sentence (else word) boundaries, never
 * breaking the min/max duration contract.
 *
 * Start and end are snapped independently but validated against each other, so a
 * pair of individually-attractive boundaries cannot combine into a clip that is
 * too short or too long.
 */
export function snapClipBounds(
  input: SnapInput,
  opts: SnapOptions
): { start: number; end: number; snapped: 'sentence' | 'word' | 'none' } {
  const tolerance = opts.toleranceSec ?? DEFAULT_SNAP_TOLERANCE_SEC
  const sentences = sentenceBoundaries(input.segments)
  const words = wordBoundaries(input.words)

  const withinDuration = (start: number, end: number): boolean => {
    const d = end - start
    return d >= opts.minDuration && d <= opts.maxDuration
  }

  for (const [kind, candidates] of [
    ['sentence', sentences],
    ['word', words]
  ] as const) {
    if (candidates.length === 0) continue
    const start =
      nearestAcceptable(input.start, candidates, tolerance, (t) => withinDuration(t, input.end)) ??
      input.start
    const end =
      nearestAcceptable(input.end, candidates, tolerance, (t) => withinDuration(start, t)) ??
      input.end
    if ((start !== input.start || end !== input.end) && withinDuration(start, end)) {
      return { start, end, snapped: kind }
    }
  }
  return { start: input.start, end: input.end, snapped: 'none' }
}

/**
 * Where to cut a clip that runs past `maxDuration`.
 *
 * The arithmetic cut (`start + maxDuration`) is the one place this reliably
 * bites: it is chosen without looking at the transcript at all, so it lands
 * mid-word essentially always. Snap DOWN to the last sentence end at or before
 * the limit — never up, which would exceed the cap the user asked for — and fall
 * back to the last word end, then to the raw arithmetic.
 */
export function snapOverlongEnd(
  start: number,
  limit: number,
  input: { segments?: TranscriptSegment[]; words?: WordTimestamp[] },
  minDuration: number
): number {
  const atOrBefore = (candidates: number[]): number | null => {
    const usable = candidates.filter((t) => t <= limit && t - start >= minDuration)
    return usable.length > 0 ? usable[usable.length - 1] : null
  }
  return (
    atOrBefore(sentenceBoundaries(input.segments)) ??
    atOrBefore(wordBoundaries(input.words)) ??
    limit
  )
}
