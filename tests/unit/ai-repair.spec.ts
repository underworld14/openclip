/**
 * tests/unit/ai-repair.spec.ts — the provider-agnostic repair ladder + clamp
 * logic of ai-client.ts (PRD §16 / plan Part B).
 *
 * Repair ladder rungs (each tested against canned JSON fixtures):
 *   1. structured mode (the transport already returns parsed → safeParse passes)
 *   2. safeParse of the raw text
 *   3. ONE repair round-trip echoing the Zod errors back to the model
 *   4. tolerant extraction — strip ```json fences / grab the outermost {...}
 *   5. typed {t:'error',code:'INPUT_INVALID',retriable:true}
 * Then CLAMP in code: end>start, clamp to [0,duration], drop overlaps, enforce
 * min/max duration.
 *
 * These exercise the pure functions exported by ai-client; no network, no SDK.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  extractJsonCandidate,
  parseClipSchema,
  clampDetectedClips,
  runRepairLadder,
  type RawTransport
} from '@main/services/ai-client'
import { clipSchemaFixture } from '../fixtures/contract'

// ── Rung 4: tolerant extraction ───────────────────────────────────────────────
describe('extractJsonCandidate (repair ladder rung 4)', () => {
  it('returns plain JSON unchanged', () => {
    const txt = '{"clips":[],"analysis":{}}'
    expect(extractJsonCandidate(txt)).toBe(txt)
  })

  it('strips a ```json fenced block', () => {
    const inner = '{"clips":[]}'
    const fenced = '```json\n' + inner + '\n```'
    expect(extractJsonCandidate(fenced)).toBe(inner)
  })

  it('strips a bare ``` fence', () => {
    const inner = '{"a":1}'
    expect(extractJsonCandidate('```\n' + inner + '\n```')).toBe(inner)
  })

  it('grabs the outermost {...} when prose surrounds it', () => {
    const inner = '{"clips":[{"start_time":1}]}'
    const noisy = 'Sure! Here are the clips:\n' + inner + '\nHope that helps.'
    expect(extractJsonCandidate(noisy)).toBe(inner)
  })

  it('returns the input when no brace is present', () => {
    expect(extractJsonCandidate('not json at all')).toBe('not json at all')
  })
})

// ── parseClipSchema: rung 2 safeParse ─────────────────────────────────────────
describe('parseClipSchema (rung 2 safeParse)', () => {
  it('parses a valid ClipSchema string', () => {
    const r = parseClipSchema(JSON.stringify(clipSchemaFixture))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.clips[0].title).toBe(clipSchemaFixture.clips[0].title)
  })

  it('parses valid JSON wrapped in a fence (tolerant extraction)', () => {
    const r = parseClipSchema('```json\n' + JSON.stringify(clipSchemaFixture) + '\n```')
    expect(r.ok).toBe(true)
  })

  it('fails with Zod issues on a schema-invalid object', () => {
    const bad = { clips: [{ start_time: 'nope' }], analysis: {} }
    const r = parseClipSchema(JSON.stringify(bad))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues.length).toBeGreaterThan(0)
  })

  it('fails on non-JSON text', () => {
    const r = parseClipSchema('totally not json')
    expect(r.ok).toBe(false)
  })

  it('rejects unknown keys (strict additionalProperties:false)', () => {
    const withExtra = {
      ...clipSchemaFixture,
      clips: [{ ...clipSchemaFixture.clips[0], surprise: true }]
    }
    const r = parseClipSchema(JSON.stringify(withExtra))
    expect(r.ok).toBe(false)
  })
})

// ── Rung 3: ONE repair round-trip ─────────────────────────────────────────────
describe('runRepairLadder (rungs 1-5)', () => {
  function fakeTransport(...responses: string[]): { transport: RawTransport; calls: () => number } {
    let i = 0
    const fn = vi.fn(async () => {
      const out = responses[Math.min(i, responses.length - 1)]
      i += 1
      return { rawText: out }
    })
    return { transport: fn, calls: () => fn.mock.calls.length }
  }

  it('rung 2: first response already valid → no repair call', async () => {
    const { transport, calls } = fakeTransport(JSON.stringify(clipSchemaFixture))
    const r = await runRepairLadder(transport, { system: 'S', user: 'U' })
    expect(r.ok).toBe(true)
    expect(calls()).toBe(1) // no second (repair) round-trip
  })

  it('rung 3: invalid first, valid on the ONE repair round-trip', async () => {
    const { transport, calls } = fakeTransport(
      '{"clips":"oops"}', // invalid
      JSON.stringify(clipSchemaFixture) // repaired
    )
    const r = await runRepairLadder(transport, { system: 'S', user: 'U' })
    expect(r.ok).toBe(true)
    expect(calls()).toBe(2) // exactly one repair round-trip
  })

  it('rung 3 echoes the Zod errors into the repair prompt', async () => {
    const seenPrompts: string[] = []
    const transport: RawTransport = async ({ user }) => {
      seenPrompts.push(user)
      return seenPrompts.length === 1
        ? { rawText: '{"clips":"oops"}' }
        : { rawText: JSON.stringify(clipSchemaFixture) }
    }
    const r = await runRepairLadder(transport, { system: 'S', user: 'ORIGINAL' })
    expect(r.ok).toBe(true)
    // The repair prompt must reference the validation failure (echo Zod errors).
    expect(seenPrompts[1]).not.toBe(seenPrompts[0])
    expect(seenPrompts[1].toLowerCase()).toContain('valid')
  })

  it('rung 5: still invalid after the single repair → typed INPUT_INVALID', async () => {
    const { transport, calls } = fakeTransport('garbage', 'still garbage')
    const r = await runRepairLadder(transport, { system: 'S', user: 'U' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('INPUT_INVALID')
      expect(r.error.retriable).toBe(true)
    }
    expect(calls()).toBe(2) // only ONE repair round-trip, never more
  })

  it('only ever performs ONE repair round-trip (never a loop)', async () => {
    const { transport, calls } = fakeTransport('bad1', 'bad2', 'bad3', 'bad4')
    await runRepairLadder(transport, { system: 'S', user: 'U' })
    expect(calls()).toBe(2)
  })
})

// ── Clamp / overlap / min-max ─────────────────────────────────────────────────
describe('clampDetectedClips (PRD §16 in-code clamp)', () => {
  const opts = { duration: 100, minDuration: 5, maxDuration: 60 }

  it('drops a clip with end <= start', () => {
    const out = clampDetectedClips([{ start_time: 30, end_time: 20 }], opts)
    expect(out).toHaveLength(0)
  })

  it('clamps bounds into [0, duration] (then max-duration applies)', () => {
    // start -10, end 250 → clamp to [0,100]; with maxDuration 60 it truncates to [0,60].
    const out = clampDetectedClips([{ start_time: -10, end_time: 250 }], opts)
    expect(out[0].start_time).toBe(0)
    expect(out[0].end_time).toBe(60)
  })

  it('clamps the upper bound to duration when within maxDuration', () => {
    const wide = { duration: 100, minDuration: 5, maxDuration: 200 }
    const out = clampDetectedClips([{ start_time: 50, end_time: 250 }], wide)
    expect(out[0].start_time).toBe(50)
    expect(out[0].end_time).toBe(100) // clamped to duration, under maxDuration
  })

  it('drops a clip shorter than minDuration', () => {
    const out = clampDetectedClips([{ start_time: 10, end_time: 12 }], opts)
    expect(out).toHaveLength(0)
  })

  it('truncates a clip longer than maxDuration to maxDuration', () => {
    const out = clampDetectedClips([{ start_time: 0, end_time: 90 }], opts)
    expect(out[0].end_time - out[0].start_time).toBe(60)
  })

  it('drops overlapping spans, keeping the earlier-starting one', () => {
    const out = clampDetectedClips(
      [
        { start_time: 0, end_time: 30 },
        { start_time: 20, end_time: 50 } // overlaps the first
      ],
      opts
    )
    expect(out).toHaveLength(1)
    expect(out[0].start_time).toBe(0)
  })

  it('keeps two non-overlapping in-bounds clips', () => {
    const out = clampDetectedClips(
      [
        { start_time: 0, end_time: 20 },
        { start_time: 25, end_time: 50 }
      ],
      opts
    )
    expect(out).toHaveLength(2)
  })
})
