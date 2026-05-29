/**
 * tests/unit/clip-bounds.spec.ts — the PURE `resolveBounds` resolver
 * (critic fix M2: testable WITHOUT the timeline / FFmpeg / Electron).
 *
 * `resolveBounds(clip) = { start: editedStart ?? startTime, end: editedEnd ??
 * endTime }` — the single source of truth shared by the export service and the
 * timeline (PRD §6.6 "Export honors the edited bounds").
 */

import { describe, expect, it } from 'vitest'
import { resolveBounds, resolveDuration } from '@shared/clip-bounds'
import type { Clip } from '@shared/schema'

function makeClip(over: Partial<Clip>): Clip {
  return {
    id: 'c1',
    startTime: 10,
    endTime: 40,
    title: 't',
    hook: 'h',
    viralityScore: 8,
    clipType: 'hook',
    keywords: [],
    status: 'suggested',
    ...over
  }
}

describe('resolveBounds', () => {
  it('uses the AI-suggested span when no edits are present', () => {
    expect(resolveBounds(makeClip({}))).toEqual({ start: 10, end: 40 })
  })

  it('prefers editedStart/editedEnd over startTime/endTime', () => {
    const clip = makeClip({ editedStart: 12.5, editedEnd: 35.25 })
    expect(resolveBounds(clip)).toEqual({ start: 12.5, end: 35.25 })
  })

  it('falls back per-bound independently (only one edited)', () => {
    expect(resolveBounds(makeClip({ editedStart: 11 }))).toEqual({ start: 11, end: 40 })
    expect(resolveBounds(makeClip({ editedEnd: 30 }))).toEqual({ start: 10, end: 30 })
  })

  it('honours a legitimate edited 0 (nullish, not falsy, fallback)', () => {
    // editedStart === 0 must NOT fall back to startTime (would be a `||` bug).
    expect(resolveBounds(makeClip({ editedStart: 0, editedEnd: 5 }))).toEqual({ start: 0, end: 5 })
  })

  it('treats undefined edits as absent (does not coerce)', () => {
    expect(resolveBounds(makeClip({ editedStart: undefined, editedEnd: undefined }))).toEqual({
      start: 10,
      end: 40
    })
  })
})

describe('resolveDuration', () => {
  it('is end - start of the resolved span', () => {
    expect(resolveDuration(makeClip({}))).toBe(30)
    expect(resolveDuration(makeClip({ editedStart: 12, editedEnd: 20 }))).toBe(8)
  })

  it('can be ≤ 0 for a mis-trimmed clip (caller validates)', () => {
    expect(resolveDuration(makeClip({ editedStart: 40, editedEnd: 10 }))).toBeLessThan(0)
  })
})
