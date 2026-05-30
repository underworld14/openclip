/**
 * tests/unit/ai-emoji.spec.ts — PURE BYOK-AI emoji suggestion (Part K, emoji).
 * Injects a fake RawTransport (no SDK / no network) and asserts the prompt,
 * tolerant parsing, key-normalization, and the best-effort empty-map fallback.
 */

import { describe, expect, it, vi } from 'vitest'
import { buildEmojiPrompt, parseEmojiMap, suggestEmoji } from '@main/services/ai-emoji'
import type { RawTransport } from '@main/services/ai-client'

describe('buildEmojiPrompt', () => {
  it('dedupes words and asks for a JSON object only', () => {
    const p = buildEmojiPrompt(['money', 'money', 'fire'])
    expect(p.user).toContain('money, fire')
    expect(p.user).not.toMatch(/money,\s*money/)
    expect(p.system).toMatch(/JSON object/i)
  })
})

describe('parseEmojiMap', () => {
  it('parses a plain JSON object and normalizes keys', () => {
    expect(parseEmojiMap('{"Money":"💰","FIRE":"🔥"}')).toEqual({ money: '💰', fire: '🔥' })
  })

  it('tolerates ```json fences and surrounding prose (rung-4 extract)', () => {
    const raw = 'Sure!\n```json\n{"idea":"💡"}\n```'
    expect(parseEmojiMap(raw)).toEqual({ idea: '💡' })
  })

  it('drops empty keys/glyphs and keeps the first emoji per normalized key', () => {
    expect(parseEmojiMap('{"!!!":"🔥","win":"  ","Win":"🏆"}')).toEqual({ win: '🏆' })
  })

  it('returns {} on unparseable / non-object output', () => {
    expect(parseEmojiMap('not json at all')).toEqual({})
    expect(parseEmojiMap('[1,2,3]')).toEqual({})
  })

  it('honors the maxEntries cap', () => {
    const big = JSON.stringify({ a: '🔥', b: '💰', c: '💡' })
    expect(Object.keys(parseEmojiMap(big, 2))).toHaveLength(2)
  })
})

describe('suggestEmoji', () => {
  it('passes a deduped prompt to the transport and returns the normalized map', async () => {
    const transport = vi.fn<RawTransport>(async () => ({ rawText: '{"money":"💰"}' }))
    const map = await suggestEmoji(transport, ['Money', 'the', 'money'])
    expect(map).toEqual({ money: '💰' })
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('short-circuits to {} with no usable words (never calls the transport)', async () => {
    const transport = vi.fn<RawTransport>(async () => ({ rawText: '{}' }))
    expect(await suggestEmoji(transport, ['', '   ', '!!!'])).toEqual({})
    expect(transport).not.toHaveBeenCalled()
  })
})
