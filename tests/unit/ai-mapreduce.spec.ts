/**
 * tests/unit/ai-mapreduce.spec.ts — token-budget chunking + map-reduce
 * (PRD §16 / plan Part B).
 *
 * Window SEGMENT-level transcript into ~8-12k-token chunks with ~10s overlap →
 * map (candidates per chunk, ABSOLUTE times) → reduce (dedupe overlaps, rank to
 * maxClips). Cache by (transcriptHash, promptVersion, model, style).
 */

import { describe, expect, it, vi } from 'vitest'
import {
  estimateTokens,
  chunkSegments,
  dedupeAndRank,
  transcriptHash,
  mapReduceGenerate,
  type RawTransport
} from '@main/services/ai-client'
import type { TranscriptSegment, DetectedClip } from '@shared/schema'

function makeSegments(n: number, wordsPerSeg = 8): TranscriptSegment[] {
  const segs: TranscriptSegment[] = []
  let t = 0
  for (let i = 0; i < n; i++) {
    const text = Array.from({ length: wordsPerSeg }, (_, w) => `word${w}`).join(' ')
    segs.push({ id: `seg-${i}`, start: t, end: t + 5, text, confidence: 0.95 })
    t += 5
  }
  return segs
}

describe('estimateTokens', () => {
  it('approximates ~1 token per 4 chars (>0 for non-empty)', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBeGreaterThanOrEqual(1)
    const long = 'x'.repeat(4000)
    expect(estimateTokens(long)).toBeGreaterThan(900)
    expect(estimateTokens(long)).toBeLessThan(1100)
  })
})

describe('chunkSegments (windowing with overlap)', () => {
  it('returns a single chunk when under the token budget', () => {
    const chunks = chunkSegments(makeSegments(5), { maxTokens: 10_000, overlapSeconds: 10 })
    expect(chunks).toHaveLength(1)
    expect(chunks[0].segments).toHaveLength(5)
  })

  it('splits into multiple chunks when over budget', () => {
    // tiny budget forces many chunks
    const segs = makeSegments(40)
    const chunks = chunkSegments(segs, { maxTokens: 80, overlapSeconds: 10 })
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('every chunk stays within (or is a single oversized segment at) the budget', () => {
    const segs = makeSegments(40)
    const budget = 120
    const chunks = chunkSegments(segs, { maxTokens: budget, overlapSeconds: 10 })
    for (const c of chunks) {
      const tokens = estimateTokens(c.segments.map((s) => s.text).join(' '))
      // a chunk may exceed budget only if it is a single (indivisible) segment
      expect(tokens <= budget || c.segments.length === 1).toBe(true)
    }
  })

  it('chunks carry overlap: a later chunk re-includes segments within overlapSeconds', () => {
    const segs = makeSegments(40)
    const chunks = chunkSegments(segs, { maxTokens: 120, overlapSeconds: 10 })
    // consecutive chunks should share at least one segment id (the overlap)
    const firstIds = new Set(chunks[0].segments.map((s) => s.id))
    const secondIds = chunks[1].segments.map((s) => s.id)
    expect(secondIds.some((id) => firstIds.has(id))).toBe(true)
  })

  it('preserves absolute times (never rebases to chunk-local)', () => {
    const segs = makeSegments(40)
    const chunks = chunkSegments(segs, { maxTokens: 120, overlapSeconds: 10 })
    const last = chunks[chunks.length - 1]
    expect(last.segments[last.segments.length - 1].start).toBe(segs[segs.length - 1].start)
  })
})

describe('dedupeAndRank (reduce step)', () => {
  const mk = (start: number, end: number, score: number): DetectedClip => ({
    start_time: start,
    end_time: end,
    title: `t${start}`,
    hook: 'h',
    virality_score: score,
    clip_type: 'hook',
    keywords: [],
    suggested_caption: 'c',
    hashtags: []
  })

  it('dedupes overlapping candidates, keeping the higher score', () => {
    const out = dedupeAndRank([mk(0, 30, 5), mk(10, 40, 9)], 10)
    expect(out).toHaveLength(1)
    expect(out[0].virality_score).toBe(9)
  })

  it('ranks by virality_score descending', () => {
    const out = dedupeAndRank([mk(0, 20, 3), mk(30, 50, 9), mk(60, 80, 6)], 10)
    expect(out.map((c) => c.virality_score)).toEqual([9, 6, 3])
  })

  it('truncates to maxClips', () => {
    const out = dedupeAndRank([mk(0, 20, 3), mk(30, 50, 9), mk(60, 80, 6)], 2)
    expect(out).toHaveLength(2)
    expect(out.map((c) => c.virality_score)).toEqual([9, 6])
  })
})

describe('transcriptHash (cache key component)', () => {
  it('is stable for identical segments', () => {
    const a = transcriptHash(makeSegments(5))
    const b = transcriptHash(makeSegments(5))
    expect(a).toBe(b)
  })
  it('changes when segment text changes', () => {
    const a = transcriptHash(makeSegments(5))
    const b = transcriptHash(makeSegments(6))
    expect(a).not.toBe(b)
  })
})

describe('mapReduceGenerate (chunk → map → reduce, with caching)', () => {
  it('maps each chunk and reduces to <= maxClips, with absolute times', async () => {
    // Two chunks, each returns one candidate at distinct absolute times.
    let call = 0
    const transport: RawTransport = async () => {
      call += 1
      const start = call === 1 ? 5 : 120
      return {
        rawText: JSON.stringify({
          clips: [
            {
              start_time: start,
              end_time: start + 20,
              title: `clip ${call}`,
              hook: 'h',
              virality_score: call === 1 ? 7 : 9,
              clip_type: 'hook',
              keywords: [],
              suggested_caption: 'c',
              hashtags: []
            }
          ],
          analysis: {
            total_duration: 200,
            clips_found: 1,
            best_clip_index: 0,
            overall_virality_potential: 'high'
          }
        })
      }
    }

    const segs = makeSegments(40)
    const r = await mapReduceGenerate(transport, {
      segments: segs,
      system: 'S',
      buildUserPrompt: (chunkSegs) => 'analyze ' + chunkSegs.length,
      chunkOptions: { maxTokens: 120, overlapSeconds: 10 },
      duration: 200,
      minDuration: 5,
      maxDuration: 60,
      maxClips: 5
    })

    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.clips.length).toBeGreaterThanOrEqual(1)
      expect(r.value.clips.length).toBeLessThanOrEqual(5)
      // highest score first (rank), absolute times preserved
      expect(r.value.clips[0].virality_score).toBe(9)
      expect(r.value.clips[0].start_time).toBe(120)
    }
  })

  it('a single chunk that fails both rungs surfaces INPUT_INVALID', async () => {
    const transport: RawTransport = async () => ({ rawText: 'garbage' })
    const r = await mapReduceGenerate(transport, {
      segments: makeSegments(3),
      system: 'S',
      buildUserPrompt: () => 'analyze',
      chunkOptions: { maxTokens: 10_000, overlapSeconds: 10 },
      duration: 100,
      minDuration: 5,
      maxDuration: 60,
      maxClips: 5
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('INPUT_INVALID')
  })

  it('uses the cache: identical request does not re-call the transport', async () => {
    const transport = vi.fn<RawTransport>(async () => ({
      rawText: JSON.stringify({
        clips: [],
        analysis: {
          total_duration: 100,
          clips_found: 0,
          best_clip_index: 0,
          overall_virality_potential: 'low'
        }
      })
    }))
    const cache = new Map<string, unknown>()
    const req = {
      segments: makeSegments(3),
      system: 'S',
      buildUserPrompt: () => 'analyze',
      chunkOptions: { maxTokens: 10_000, overlapSeconds: 10 },
      duration: 100,
      minDuration: 5,
      maxDuration: 60,
      maxClips: 5,
      cache,
      cacheKey: 'k1'
    }
    await mapReduceGenerate(transport, req)
    const callsAfterFirst = transport.mock.calls.length
    await mapReduceGenerate(transport, req)
    expect(transport.mock.calls.length).toBe(callsAfterFirst) // served from cache
  })
})
