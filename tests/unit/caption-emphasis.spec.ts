/**
 * tests/unit/caption-emphasis.spec.ts — PURE keyword/emoji annotation (Part K,
 * Step 1). The annotation feeds BOTH the .ass burn and the DOM preview, so its
 * determinism + the no-op (byte-compat) path are pinned here.
 */

import { describe, it, expect } from 'vitest'
import { annotateWords, lookupEmoji, normalizeWord, EMOJI_DICT } from '@shared/caption-emphasis'
import type { RebasedWord } from '@shared/caption-layout'

const words: RebasedWord[] = [
  { word: 'This', start: 0, end: 0.2 },
  { word: 'costs', start: 0.2, end: 0.4 },
  { word: 'Money,', start: 0.4, end: 0.7 },
  { word: 'fast!', start: 0.7, end: 0.9 }
]

describe('normalizeWord', () => {
  it('lowercases + strips punctuation (Unicode-aware)', () => {
    expect(normalizeWord('Money,')).toBe('money')
    expect(normalizeWord('"FAST!"')).toBe('fast')
    expect(normalizeWord('100%')).toBe('100')
    expect(normalizeWord('—')).toBe('')
  })
})

describe('lookupEmoji', () => {
  it('uses the local dict (punctuation-insensitive); AI map wins', () => {
    expect(lookupEmoji('money')).toBe(EMOJI_DICT['money'])
    expect(lookupEmoji('Money,')).toBe(EMOJI_DICT['money'])
    expect(lookupEmoji('zzz')).toBeUndefined()
    expect(lookupEmoji('money', EMOJI_DICT, { money: '🪙' })).toBe('🪙')
  })
})

describe('annotateWords', () => {
  it('is a no-op (no marks) when no keywords + emoji off — byte-compat path', () => {
    const out = annotateWords(words)
    expect(out).toEqual(words.map((w) => ({ word: w.word, start: w.start, end: w.end })))
    expect(out.every((w) => w.isKeyword === undefined && w.emoji === undefined)).toBe(true)
  })

  it('marks keyword words (case/punctuation-insensitive)', () => {
    const out = annotateWords(words, { keywords: ['money', 'fast'] })
    expect(out.map((w) => !!w.isKeyword)).toEqual([false, false, true, true])
  })

  it('attaches local emoji when autoEmoji=local', () => {
    const out = annotateWords(words, { autoEmoji: 'local' })
    expect(out[2].emoji).toBe(EMOJI_DICT['money'])
    expect(out[3].emoji).toBe(EMOJI_DICT['fast'])
    expect(out[0].emoji).toBeUndefined()
  })

  it('uses the AI map when autoEmoji=ai, falling back to the local dict per word', () => {
    const out = annotateWords(words, { autoEmoji: 'ai', aiEmojiMap: { money: '🪙' } })
    expect(out[2].emoji).toBe('🪙') // AI override
    expect(out[3].emoji).toBe(EMOJI_DICT['fast']) // not in AI map → local fallback
  })

  it('autoEmoji=off ignores any aiEmojiMap', () => {
    const out = annotateWords(words, { autoEmoji: 'off', aiEmojiMap: { money: '🪙' } })
    expect(out.every((w) => w.emoji === undefined)).toBe(true)
  })
})
