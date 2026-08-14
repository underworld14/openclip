/**
 * tests/unit/clip-snap.spec.ts — clip boundaries land on speech boundaries
 * (BUG-yq6qbw, second half).
 *
 * `clampDetectedClips` enforced the max duration with `end = start + maxDuration`
 * — pure arithmetic with no reference to the transcript — so a model that
 * overshoots the prompt's length cap produced a clip cut at exactly that second,
 * landing mid-word essentially every time: an audible chop on the last syllable.
 * And nothing anywhere snapped a clip boundary to anything:
 * `grep -rniE "snap|sentence" src/` found only transcript grouping and the
 * unrelated silence-removal gap snapping.
 *
 * The contract these specs pin down: prefer a sentence edge, fall back to a word
 * edge, fall back to the raw value — and NEVER let a snap break the caller's
 * min/max duration, because a prettier cut that violates the user's settings is
 * not an improvement.
 */

import { describe, expect, it } from 'vitest'
import { snapClipBounds, snapOverlongEnd, DEFAULT_SNAP_TOLERANCE_SEC } from '@shared/clip-snap'
import { clampDetectedClips } from '@main/services/ai-client'
import type { TranscriptSegment, WordTimestamp } from '@shared/schema'

const seg = (id: string, start: number, end: number): TranscriptSegment => ({
  id,
  start,
  end,
  text: 't',
  confidence: 0.9
})
const word = (w: string, start: number, end: number): WordTimestamp => ({
  word: w,
  start,
  end,
  confidence: 0.9
})

/** Sentences at 0–10, 10–20, 20–30. */
const SEGMENTS = [seg('s0', 0, 10), seg('s1', 10, 20), seg('s2', 20, 30)]
/** Words inside the second sentence, on half-second edges. */
const WORDS = [word('a', 10, 10.5), word('b', 10.5, 11.2), word('c', 11.2, 12.0)]

describe('snapClipBounds: sentence first', () => {
  it('pulls both edges onto the nearest sentence boundary', () => {
    const r = snapClipBounds(
      { start: 10.4, end: 19.6, segments: SEGMENTS },
      { minDuration: 5, maxDuration: 60 }
    )
    expect(r).toEqual({ start: 10, end: 20, snapped: 'sentence' })
  })

  it('leaves a boundary alone when the nearest sentence is out of tolerance', () => {
    // 15 is 5s from either edge — well past the 1.5s tolerance.
    const r = snapClipBounds(
      { start: 15, end: 20, segments: SEGMENTS },
      { minDuration: 1, maxDuration: 60 }
    )
    expect(r.start).toBe(15)
  })

  it('falls back to a WORD edge when no sentence edge is close enough', () => {
    // 11.1 is 1.1s from sentence edge 10 — but that snap would make the clip
    // longer than max, so it is rejected and the word edge at 11.2 wins.
    const r = snapClipBounds(
      { start: 11.1, end: 12.0, segments: SEGMENTS, words: WORDS },
      { minDuration: 0.5, maxDuration: 1.5 }
    )
    expect(r.snapped).toBe('word')
    expect(r.start).toBe(11.2)
  })

  it('returns the raw values, unchanged, when there is nothing to snap to', () => {
    const r = snapClipBounds({ start: 3.7, end: 9.1 }, { minDuration: 1, maxDuration: 60 })
    expect(r).toEqual({ start: 3.7, end: 9.1, snapped: 'none' })
  })
})

describe('snapClipBounds: a snap may never break min/max', () => {
  it('refuses a boundary that would make the clip too short', () => {
    // Snapping end 10.4 → 10 would leave a 0s clip; the raw end must survive.
    const r = snapClipBounds(
      { start: 10, end: 10.4, segments: SEGMENTS },
      { minDuration: 0.3, maxDuration: 60 }
    )
    expect(r.end).toBe(10.4)
  })

  it('refuses a boundary that would make the clip too long', () => {
    const r = snapClipBounds(
      { start: 10, end: 19.2, segments: SEGMENTS },
      { minDuration: 1, maxDuration: 9.5 }
    )
    // 19.2 → 20 would be 10s, over the 9.5 cap. Left alone.
    expect(r.end).toBe(19.2)
  })

  it('honours a caller-supplied tolerance', () => {
    const tight = snapClipBounds(
      { start: 10.4, end: 20, segments: SEGMENTS },
      { minDuration: 1, maxDuration: 60, toleranceSec: 0.1 }
    )
    expect(tight.start).toBe(10.4) // 0.4s move is outside a 0.1s tolerance
    expect(DEFAULT_SNAP_TOLERANCE_SEC).toBeGreaterThan(0.1)
  })
})

describe('snapOverlongEnd: cut back to a boundary, never past the cap', () => {
  it('snaps DOWN to the last sentence end at or before the limit', () => {
    // maxDuration would cut at 22; the last sentence end at-or-before is 20.
    expect(snapOverlongEnd(0, 22, { segments: SEGMENTS }, 5)).toBe(20)
  })

  it('never returns a boundary AFTER the limit', () => {
    // 25 is past every candidate except 30, which must not be chosen.
    expect(snapOverlongEnd(0, 25, { segments: SEGMENTS }, 5)).toBe(20)
  })

  it('falls back to a word end, then to the raw arithmetic limit', () => {
    expect(snapOverlongEnd(10, 11.9, { words: WORDS }, 0.5)).toBe(11.2)
    expect(snapOverlongEnd(0, 7.3, {}, 1)).toBe(7.3)
  })

  it('will not cut below the minimum duration', () => {
    // The only boundary at-or-before 12 is 10, which would give a 0s clip.
    expect(snapOverlongEnd(10, 12, { segments: SEGMENTS }, 5)).toBe(12)
  })
})

describe('clampDetectedClips: the over-long cut', () => {
  const overlong = [
    {
      start_time: 0,
      end_time: 100,
      title: 't',
      hook: 'h',
      virality_score: 7,
      clip_type: 'hook' as const,
      keywords: [],
      suggested_caption: 'c',
      hashtags: []
    }
  ]

  it('still cuts at the arithmetic limit with no snapper — unchanged behaviour', () => {
    const out = clampDetectedClips(overlong, { duration: 200, minDuration: 5, maxDuration: 22 })
    expect(out[0].end_time).toBe(22)
  })

  it('cuts at the last sentence end when a snapper is supplied', () => {
    const out = clampDetectedClips(overlong, {
      duration: 200,
      minDuration: 5,
      maxDuration: 22,
      snapOverlongTo: (start, limit) => snapOverlongEnd(start, limit, { segments: SEGMENTS }, 5)
    })
    // 20, not 22 — the mid-word chop is what the report was about.
    expect(out[0].end_time).toBe(20)
  })
})
