/**
 * tests/unit/ass-captions.spec.ts — GOLDEN-FILE unit tests for the pure
 * karaoke caption generator (CAPTION-BURN spine, plan E.5 / PRD §6.4 / §18
 * "assert exact strings from word arrays"). These pin the EXACT `\k` cue strings
 * and the `CaptionStyle`→ASS `Style:` mapping so any drift in the format (which
 * libass parses byte-for-byte) fails loudly.
 *
 * The fixture word array + expected strings were captured from the real module
 * output and verified against the FFmpeg ASS spec (`\k` = centiseconds; ASS
 * colors are `&HAABBGGRR` BGR; alpha 00 = opaque).
 */

import { describe, it, expect } from 'vitest'
import type { CaptionStyle, WordTimestamp } from '@shared/schema'
import {
  buildAss,
  buildKaraokeLine,
  buildStyleLine,
  scopeWordsToClip,
  toAssColor,
  toCentiseconds,
  formatAssTime,
  escapeAssText,
  isDroppableToken,
  alignmentFor,
  animationOverride,
  DEFAULT_CAPTION_STYLE,
  ASS_PLAY_RES
} from '@main/services/ass-captions'

// ── A reusable style (the bundled DejaVu Sans face, PRD §6.4) ─────────────────
const STYLE: CaptionStyle = {
  fontFamily: 'DejaVu Sans',
  fontSize: 64,
  fontColor: '#FFFFFF',
  backgroundColor: '#000000',
  position: 'bottom',
  animation: 'none',
  highlightCurrentWord: true,
  emojiEnabled: false
}

describe('toCentiseconds — the \\k karaoke unit (1cs = 10ms)', () => {
  it('rounds seconds to whole centiseconds', () => {
    expect(toCentiseconds(0.2)).toBe(20)
    expect(toCentiseconds(0.25)).toBe(25)
    expect(toCentiseconds(0.155)).toBe(16) // 15.5 → 16
    expect(toCentiseconds(0)).toBe(0)
    expect(toCentiseconds(-1)).toBe(0) // never negative
  })
})

describe('toAssColor — #RRGGBB → ASS &HAABBGGRR (BGR, alpha 00 = opaque)', () => {
  it('reverses RGB to BGR with opaque alpha', () => {
    expect(toAssColor('#FFFFFF')).toBe('&H00FFFFFF') // white
    expect(toAssColor('#000000')).toBe('&H00000000') // black
    expect(toAssColor('#FF0000')).toBe('&H000000FF') // red → BGR
    expect(toAssColor('#0000FF')).toBe('&H00FF0000') // blue → BGR
    expect(toAssColor('#00FF00')).toBe('&H0000FF00') // green
  })
  it('expands #RGB shorthand', () => {
    expect(toAssColor('#F00')).toBe('&H000000FF')
  })
  it('maps CSS alpha (FF opaque) to inverted ASS alpha (00 opaque)', () => {
    expect(toAssColor('#FF000080')).toBe('&H7F0000FF') // 0x80 css → 0x7F ass
    expect(toAssColor('#FF0000FF')).toBe('&H000000FF') // fully opaque
    expect(toAssColor('#FF000000')).toBe('&HFF0000FF') // fully transparent
  })
  it('passes through an explicit &H literal (padded)', () => {
    expect(toAssColor('&HCCFF0000')).toBe('&HCCFF0000')
    expect(toAssColor('&HFF00&')).toBe('&H0000FF00')
  })
  it('falls back to opaque white on garbage', () => {
    expect(toAssColor('not-a-color')).toBe('&H00FFFFFF')
  })
})

describe('formatAssTime — ASS H:MM:SS.cc (centisecond precision)', () => {
  it('formats clip-relative seconds', () => {
    expect(formatAssTime(0)).toBe('0:00:00.00')
    expect(formatAssTime(10)).toBe('0:00:10.00')
    expect(formatAssTime(10.4)).toBe('0:00:10.40')
    expect(formatAssTime(3661.23)).toBe('1:01:01.23')
    expect(formatAssTime(-5)).toBe('0:00:00.00') // clamps
  })
})

describe('escapeAssText — neutralize ASS override-block / escape chars', () => {
  it('escapes backslash and braces, collapses newlines', () => {
    expect(escapeAssText('a{b}c\\d')).toBe('a\\{b\\}c\\\\d')
    expect(escapeAssText('line\nbreak')).toBe('line break')
    expect(escapeAssText('plain')).toBe('plain')
  })
})

describe('isDroppableToken — drop whisper special/blank tokens', () => {
  it('drops bracket + angle special tokens and blanks; keeps real words', () => {
    expect(isDroppableToken('[_BEG_]')).toBe(true)
    expect(isDroppableToken('[_TT_700]')).toBe(true)
    expect(isDroppableToken('[_EOT_]')).toBe(true)
    expect(isDroppableToken('<|endoftext|>')).toBe(true)
    expect(isDroppableToken('<|0.00|>')).toBe(true)
    expect(isDroppableToken('   ')).toBe(true)
    expect(isDroppableToken('')).toBe(true)
    expect(isDroppableToken('Hello')).toBe(false)
    expect(isDroppableToken('friend.')).toBe(false)
  })
})

describe('alignmentFor / animationOverride', () => {
  it('maps position to the \\an numpad (center column)', () => {
    expect(alignmentFor('top')).toBe(8)
    expect(alignmentFor('middle')).toBe(5)
    expect(alignmentFor('bottom')).toBe(2)
  })
  it('maps animation to a leading override (none/typewriter → empty)', () => {
    expect(animationOverride('pop')).toBe('\\fscx60\\fscy60\\t(0,150,\\fscx100\\fscy100)')
    expect(animationOverride('fade')).toBe('\\fad(150,0)')
    expect(animationOverride('none')).toBe('')
    expect(animationOverride('typewriter')).toBe('')
  })
})

describe('scopeWordsToClip — scope + rebase to clip-relative time', () => {
  const words: WordTimestamp[] = [
    { word: 'before', start: 8.0, end: 9.0, confidence: 0.9 }, // dropped (ends before clip)
    { word: '[_BEG_]', start: 9.9, end: 9.9, confidence: 0.0 }, // special token dropped
    { word: 'Hello', start: 10.0, end: 10.4, confidence: 0.9 },
    { word: 'there', start: 10.45, end: 10.8, confidence: 0.9 },
    { word: 'friend.', start: 12.9, end: 13.5, confidence: 0.9 }, // clamps to clipEnd 13.0
    { word: 'after', start: 14.0, end: 15.0, confidence: 0.9 } // dropped (after clip)
  ]

  it('drops out-of-range + special tokens, clamps partial overlaps, rebases to t0', () => {
    const scoped = scopeWordsToClip(words, 10, 13)
    expect(scoped).toEqual([
      { word: 'Hello', start: 0, end: expect.closeTo(0.4, 6) },
      { word: 'there', start: expect.closeTo(0.45, 6), end: expect.closeTo(0.8, 6) },
      { word: 'friend.', start: expect.closeTo(2.9, 6), end: expect.closeTo(3.0, 6) }
    ])
  })

  it('returns [] when no word intersects the clip', () => {
    expect(scopeWordsToClip(words, 100, 110)).toEqual([])
  })
})

describe('buildKaraokeLine — EXACT {\\k<cs>} cue strings (golden)', () => {
  it('emits one syllable per word + a gap syllable for inter-word silence', () => {
    // Hello 10.00–10.20 (20cs), gap 10.20→10.35 (15cs), World 10.35–10.60 (25cs).
    const scoped = scopeWordsToClip(
      [
        { word: 'Hello', start: 10.0, end: 10.2, confidence: 0.9 },
        { word: 'World', start: 10.35, end: 10.6, confidence: 0.9 }
      ],
      10.0,
      11.0
    )
    const { text, startSec, endSec } = buildKaraokeLine(scoped)
    expect(text).toBe('{\\k20}Hello{\\k15}{\\k25} World')
    expect(startSec).toBeCloseTo(0, 6)
    expect(endSec).toBeCloseTo(0.6, 6)
  })

  it('no gap syllable when words are contiguous; first word has no leading space', () => {
    const scoped = scopeWordsToClip(
      [
        { word: 'one', start: 0.0, end: 0.3, confidence: 1 },
        { word: 'two', start: 0.3, end: 0.5, confidence: 1 }
      ],
      0,
      1
    )
    expect(buildKaraokeLine(scoped).text).toBe('{\\k30}one{\\k20} two')
  })

  it('escapes word text inside the cue', () => {
    const scoped = scopeWordsToClip([{ word: '{boom}', start: 0, end: 0.1, confidence: 1 }], 0, 1)
    expect(buildKaraokeLine(scoped).text).toBe('{\\k10}\\{boom\\}')
  })
})

describe('buildStyleLine — CaptionStyle → ASS V4+ Style line (golden)', () => {
  it('maps every field to the canonical V4+ Style order', () => {
    // PrimaryColour = highlight (yellow), SecondaryColour = fontColor (the
    // pre-highlight word color the karaoke fill reveals), BackColour = bg box.
    expect(buildStyleLine(STYLE)).toBe(
      'Style: Karaoke,DejaVu Sans,64,&H0000FFFF,&H00FFFFFF,&H00000000,&H00000000,' +
        '0,0,0,0,100,100,0,0,3,3,0,2,60,60,80,1'
    )
  })

  it('reflects position (Alignment) and colors', () => {
    const top: CaptionStyle = {
      ...STYLE,
      position: 'top',
      fontColor: '#FF0000',
      backgroundColor: '#0000FF'
    }
    const line = buildStyleLine(top)
    // SecondaryColour (5th field) = red → &H000000FF; BackColour (7th) = blue → &H00FF0000.
    expect(line).toBe(
      'Style: Karaoke,DejaVu Sans,64,&H0000FFFF,&H000000FF,&H00000000,&H00FF0000,' +
        '0,0,0,0,100,100,0,0,3,3,0,8,60,60,80,1'
    )
  })
})

describe('buildAss — FULL .ass golden file', () => {
  const words: WordTimestamp[] = [
    { word: 'before', start: 8.0, end: 9.0, confidence: 0.9 },
    { word: '[_BEG_]', start: 9.9, end: 9.9, confidence: 0.0 },
    { word: 'Hello', start: 10.0, end: 10.4, confidence: 0.9 },
    { word: 'there', start: 10.45, end: 10.8, confidence: 0.9 },
    { word: 'friend.', start: 12.9, end: 13.5, confidence: 0.9 },
    { word: 'after', start: 14.0, end: 15.0, confidence: 0.9 }
  ]

  it('produces the exact header + style + karaoke Dialogue lines', () => {
    const ass = buildAss({ words, clipStart: 10, clipEnd: 13, style: STYLE })
    const expected = [
      '[Script Info]',
      'ScriptType: v4.00+',
      'WrapStyle: 2',
      'ScaledBorderAndShadow: yes',
      'PlayResX: 1080',
      'PlayResY: 1920',
      '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      'Style: Karaoke,DejaVu Sans,64,&H0000FFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,3,3,0,2,60,60,80,1',
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, MarginL, MarginR, MarginV, Effect, Text',
      // "Hello there" on one line (small gap); "friend." breaks to its own line
      // (the >0.8s silence gap) and clamps to clipEnd (3.00).
      'Dialogue: 0,0:00:00.00,0:00:00.80,Karaoke,,0,0,0,,{\\k40}Hello{\\k5}{\\k35} there',
      'Dialogue: 0,0:00:02.90,0:00:03.00,Karaoke,,0,0,0,,{\\k10}friend.',
      ''
    ].join('\n')
    expect(ass).toBe(expected)
  })

  it('emits a header-only file (no Dialogue) when no word intersects the clip', () => {
    const ass = buildAss({ words, clipStart: 100, clipEnd: 110, style: STYLE })
    expect(ass).toContain('[Events]')
    expect(ass).not.toContain('Dialogue:')
  })

  it('uses the export-canvas PlayRes and the default style when none given', () => {
    const ass = buildAss({
      words: [{ word: 'Hi', start: 0, end: 0.3, confidence: 1 }],
      clipStart: 0,
      clipEnd: 1
    })
    expect(ass).toContain(`PlayResX: ${ASS_PLAY_RES.x}`)
    expect(ass).toContain(`PlayResY: ${ASS_PLAY_RES.y}`)
    expect(ass).toContain(`Style: Karaoke,${DEFAULT_CAPTION_STYLE.fontFamily},`)
    expect(ass).toContain('{\\k30}Hi')
  })

  it('applies the animation override as a leading per-line block', () => {
    const ass = buildAss({
      words: [{ word: 'Pow', start: 0, end: 0.2, confidence: 1 }],
      clipStart: 0,
      clipEnd: 1,
      style: { ...STYLE, animation: 'pop' }
    })
    expect(ass).toContain(
      'Karaoke,,0,0,0,,{\\fscx60\\fscy60\\t(0,150,\\fscx100\\fscy100)}{\\k20}Pow'
    )
  })

  it('respects maxWordsPerLine line-grouping', () => {
    const words6: WordTimestamp[] = Array.from({ length: 6 }, (_, i) => ({
      word: `w${i}`,
      start: i * 0.2,
      end: i * 0.2 + 0.15,
      confidence: 1
    }))
    const ass = buildAss({ words: words6, clipStart: 0, clipEnd: 10, maxWordsPerLine: 3 })
    const dialogues = ass.split('\n').filter((l) => l.startsWith('Dialogue:'))
    expect(dialogues).toHaveLength(2) // 6 words / 3 per line
  })
})
