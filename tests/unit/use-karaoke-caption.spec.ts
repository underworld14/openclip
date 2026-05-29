/**
 * tests/unit/use-karaoke-caption.spec.ts — the PURE active-line selection that
 * drives the WYSIWYG preview captions (Part K, Step 3).
 */

import { describe, it, expect } from 'vitest'
import { pickActiveLine, type AnnotatedLine } from '@renderer/components/useKaraokeCaption'

const lines: AnnotatedLine[] = [
  {
    startSec: 0,
    endSec: 0.9,
    words: [
      { word: 'I', start: 0, end: 0.2 },
      { word: 'love', start: 0.2, end: 0.5 },
      { word: 'money', start: 0.5, end: 0.9, isKeyword: true }
    ]
  },
  { startSec: 2.0, endSec: 2.4, words: [{ word: 'done', start: 2.0, end: 2.4 }] }
]

describe('pickActiveLine', () => {
  it('returns the active line + active word at a time inside it', () => {
    const a = pickActiveLine(lines, 0.35)!
    expect(a.words).toHaveLength(3)
    expect(a.activeIndex).toBe(1) // "love"
  })

  it('highlights a later word as the playhead advances', () => {
    expect(pickActiveLine(lines, 0.7)!.activeIndex).toBe(2) // "money"
  })

  it('returns null between lines', () => {
    expect(pickActiveLine(lines, 1.3)).toBeNull()
  })

  it('selects the second line', () => {
    expect(pickActiveLine(lines, 2.1)!.words[0].word).toBe('done')
  })

  it('activates the first word at the line start', () => {
    expect(pickActiveLine(lines, 0)!.activeIndex).toBe(0)
  })
})
