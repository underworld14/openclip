/**
 * tests/unit/caption-layout.spec.ts — the PURE @shared caption layout (Part K,
 * Step 1) extracted from ass-captions so the DOM preview and the .ass burn group
 * + scope words identically. groupIntoLines is now generic (preserves emphasis
 * annotations); layoutCaptionLines mirrors buildAss's scope→group pipeline.
 */

import { describe, it, expect } from 'vitest'
import {
  layoutCaptionLines,
  groupIntoLines,
  scopeWordsToClip,
  type RebasedWord
} from '@shared/caption-layout'
import type { WordTimestamp } from '@shared/schema'

const words: WordTimestamp[] = [
  { word: 'a', start: 0, end: 0.2, confidence: 1 },
  { word: 'b', start: 0.2, end: 0.4, confidence: 1 },
  { word: 'c', start: 0.4, end: 0.6, confidence: 1 },
  { word: 'd', start: 2.0, end: 2.2, confidence: 1 } // >0.8s gap ⇒ new line
]

const rebased = (): RebasedWord[] =>
  words.map((w) => ({ word: w.word, start: w.start, end: w.end }))

describe('groupIntoLines', () => {
  it('breaks on maxWordsPerLine', () => {
    expect(groupIntoLines(rebased(), 2, 999).length).toBe(2)
  })

  it('breaks on a long silence gap', () => {
    const lines = groupIntoLines(rebased(), 99, 0.8)
    expect(lines.length).toBe(2)
    expect(lines[1].map((w) => w.word)).toEqual(['d'])
  })

  it('is generic — preserves extra annotation fields on the word type', () => {
    const tagged = [{ word: 'x', start: 0, end: 0.1, isKeyword: true, emoji: '🔥' }]
    const out = groupIntoLines(tagged, 7, 0.8)
    expect(out[0][0].isKeyword).toBe(true)
    expect(out[0][0].emoji).toBe('🔥')
  })
})

describe('layoutCaptionLines', () => {
  it('scopes + groups like buildAss (7-words / 0.8s defaults)', () => {
    const lines = layoutCaptionLines(words, 0, 5)
    expect(lines.length).toBe(2)
    expect(lines[0].words.map((w) => w.word)).toEqual(['a', 'b', 'c'])
    expect(lines[0].startSec).toBeCloseTo(0, 6)
    expect(lines[0].endSec).toBeCloseTo(0.6, 6)
    expect(lines[1].words.map((w) => w.word)).toEqual(['d'])
  })

  it('flattens to exactly scopeWordsToClip output (same scope/rebase as the burn)', () => {
    const scoped = scopeWordsToClip(words, 0, 5)
    const flat = layoutCaptionLines(words, 0, 5).flatMap((l) => l.words)
    expect(flat).toEqual(scoped)
  })
})
