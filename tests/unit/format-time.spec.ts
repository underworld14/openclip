/**
 * tests/unit/format-time.spec.ts — the single `formatSeconds` formatter that the
 * three panel helpers (formatTimecode / formatTime / formatTimestamp) now delegate
 * to (audit fix openclip-64e). Locks each mode's EXACT output so the consolidation
 * stays byte-identical to the three originals.
 */

import { describe, expect, it } from 'vitest'
import { formatSeconds } from '@renderer/components/format-time'
import { formatTimecode } from '@renderer/components/clipView'
import { formatTime } from '@renderer/components/timeline-math'
import { formatTimestamp } from '@renderer/components/transcript-format'

describe('formatSeconds — whole-seconds, no hours rollover (default = formatTimecode)', () => {
  it('M:SS with a zero-padded seconds field and clamps negatives', () => {
    expect(formatSeconds(0)).toBe('0:00')
    expect(formatSeconds(75)).toBe('1:15')
    expect(formatSeconds(-5)).toBe('0:00')
  })
  it('minutes NEVER roll into an hours field (a 65-min clip reads 65:00)', () => {
    expect(formatSeconds(3900)).toBe('65:00')
  })
  it('formatTimecode delegates with identical output', () => {
    for (const s of [0, 9, 75, 600, 3900]) expect(formatTimecode(s)).toBe(formatSeconds(s))
  })
})

describe('formatSeconds — centiseconds (precision: cs = formatTime)', () => {
  it('M:SS.cc with a centisecond field', () => {
    expect(formatSeconds(75.5, { precision: 'cs' })).toBe('1:15.50')
    expect(formatSeconds(0, { precision: 'cs' })).toBe('0:00.00')
  })
  it('carries when centiseconds round up to 100', () => {
    expect(formatSeconds(0.999, { precision: 'cs' })).toBe('0:01.00')
  })
  it('formatTime delegates with identical output', () => {
    for (const s of [0, 0.999, 75.5, 12.34]) {
      expect(formatTime(s)).toBe(formatSeconds(s, { precision: 'cs' }))
    }
  })
})

describe('formatSeconds — auto hours (hours: auto = formatTimestamp)', () => {
  it('m:ss under an hour; h:mm:ss at/over an hour', () => {
    expect(formatSeconds(300, { hours: 'auto' })).toBe('5:00')
    expect(formatSeconds(3900, { hours: 'auto' })).toBe('1:05:00') // not 65:00
    expect(formatSeconds(3661, { hours: 'auto' })).toBe('1:01:01')
  })
  it('formatTimestamp delegates with identical output', () => {
    for (const s of [0, 59, 300, 3600, 3900, 7325]) {
      expect(formatTimestamp(s)).toBe(formatSeconds(s, { hours: 'auto' }))
    }
  })
})
