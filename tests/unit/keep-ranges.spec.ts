/**
 * tests/unit/keep-ranges.spec.ts — the PURE jump-cut math (Part I.4): turning a
 * clip span + detected silences into keep ranges, and mapping absolute times onto
 * the compressed (silence-removed) timeline.
 */

import { describe, expect, it } from 'vitest'
import {
  computeKeepRanges,
  compressTime,
  compressTimeClamped,
  keptDuration,
  removesAnything,
  type Range
} from '@shared/keep-ranges'

describe('computeKeepRanges', () => {
  it('removes a long mid-clip silence (with padding) and keeps the speech around it', () => {
    // Clip 0..30; silence 10..14 (4s). minSilence 0.6, pad 0.05 → remove [10.05,13.95].
    const keep = computeKeepRanges(0, 30, [[10, 14]], { minSilenceSec: 0.6, padSec: 0.05 })
    expect(keep).toEqual([
      [0, 10.05],
      [13.95, 30]
    ])
  })

  it('ignores silences shorter than minSilenceSec', () => {
    const keep = computeKeepRanges(0, 30, [[10, 10.3]], { minSilenceSec: 0.6 })
    expect(keep).toEqual([[0, 30]]) // nothing removed
  })

  it('merges overlapping removed intervals into one gap', () => {
    // Two overlapping silences → one removed gap [10.05, 16.95].
    const keep = computeKeepRanges(
      0,
      40,
      [
        [10, 14], // remove [10.05, 13.95]
        [13, 17] // overlaps prev → merges
      ],
      { minSilenceSec: 0.6, padSec: 0.05 }
    )
    expect(keep).toEqual([
      [0, 10.05],
      [16.95, 40]
    ])
  })

  it('clamps a silence that extends past the clip end to the clip bound', () => {
    // Silence 36..50 clamped to [36,40] (4s) → remove [36.05, 39.95] (pad both sides).
    const keep = computeKeepRanges(5, 40, [[36, 50]], { minSilenceSec: 0.6, padSec: 0.05 })
    expect(keep).toEqual([
      [5, 36.05],
      [39.95, 40]
    ])
  })

  it('falls back to the whole clip when nothing qualifies / no silences', () => {
    expect(computeKeepRanges(0, 30, [])).toEqual([[0, 30]])
    expect(computeKeepRanges(0, 0, [[1, 2]])).toEqual([[0, 0]]) // non-positive span guard
  })
})

describe('keptDuration / removesAnything', () => {
  const keep: Range[] = [
    [0, 10],
    [14, 30]
  ]
  it('keptDuration sums the kept spans', () => {
    expect(keptDuration(keep)).toBe(26) // 10 + 16
  })
  it('removesAnything is true for a gapped keep set, false for a single full-span', () => {
    expect(removesAnything(keep, 0, 30)).toBe(true)
    expect(removesAnything([[0, 30]], 0, 30)).toBe(false)
    expect(removesAnything([[2, 30]], 0, 30)).toBe(true) // trimmed front
  })
})

describe('compressTime (nullable in a removed gap)', () => {
  const keep: Range[] = [
    [0, 10],
    [14, 30]
  ]
  it('maps kept times onto the compressed timeline, first kept sample → 0', () => {
    expect(compressTime(0, keep)).toBe(0)
    expect(compressTime(5, keep)).toBe(5)
    expect(compressTime(10, keep)).toBe(10) // end of first range
    expect(compressTime(14, keep)).toBe(10) // start of second range (gap collapsed)
    expect(compressTime(20, keep)).toBe(16) // 10 + (20-14)
    expect(compressTime(30, keep)).toBe(26)
  })
  it('returns null inside a removed gap and past the end', () => {
    expect(compressTime(12, keep)).toBeNull()
    expect(compressTime(31, keep)).toBeNull()
  })
})

describe('compressTimeClamped (never null — snaps gaps to the cut point)', () => {
  const keep: Range[] = [
    [0, 10],
    [14, 30]
  ]
  it('snaps a removed-gap time to the cumulative kept duration up to that gap', () => {
    expect(compressTimeClamped(12, keep)).toBe(10) // gap 10..14 → snaps to 10
    expect(compressTimeClamped(20, keep)).toBe(16)
    expect(compressTimeClamped(40, keep)).toBe(26) // past end → total kept
  })
  it('collapses a word fully inside a gap to zero length (so the caption drops it)', () => {
    const s = compressTimeClamped(11, keep)
    const e = compressTimeClamped(13, keep)
    expect(e - s).toBe(0)
  })
})
