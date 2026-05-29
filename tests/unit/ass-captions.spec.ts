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

  it('Part I preset fields drive highlight/outline/shadow + no-box for a transparent bg', () => {
    // Hormozi-style: green highlight, thick black outline, shadow, NO box.
    const hormozi: CaptionStyle = {
      ...STYLE,
      fontFamily: 'Anton',
      backgroundColor: '#00000000', // fully transparent → BorderStyle 1 (no box)
      highlightColor: '#00FF00',
      strokeColor: '#000000',
      strokeWidth: 4,
      shadow: true
    }
    const line = buildStyleLine(hormozi)
    // PrimaryColour=green (&H0000FF00), BackColour=transparent black (&HFF000000),
    // BorderStyle=1, Outline=4, Shadow=2.
    expect(line).toBe(
      'Style: Karaoke,Anton,64,&H0000FF00,&H00FFFFFF,&H00000000,&HFF000000,' +
        '0,0,0,0,100,100,0,0,1,4,2,2,60,60,80,1'
    )
  })

  it('a style with NO Part I fields is byte-identical to the pre-Part-I output', () => {
    // Regression guard: optional fields absent ⇒ yellow highlight, black outline
    // width 3, no shadow, opaque-bg box (BorderStyle 3) — exactly as before.
    expect(buildStyleLine(STYLE)).toContain(',&H0000FFFF,') // default highlight (yellow)
    expect(buildStyleLine(STYLE)).toMatch(/,3,3,0,2,60,60,80,1$/) // BorderStyle 3, Outline 3, Shadow 0
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

  it('remaps words onto the compressed timeline for a jump-cut (Part I.4)', () => {
    // A 4s silence (1.0..5.0) is removed via keepRanges; words after it shift
    // earlier, a word fully inside the gap is dropped, and the karaoke stays
    // continuous on the compressed (2s) timeline.
    const jumpWords: WordTimestamp[] = [
      { word: 'one', start: 0, end: 0.5, confidence: 1 },
      { word: 'two', start: 0.5, end: 1.0, confidence: 1 },
      { word: 'gap', start: 2.0, end: 3.0, confidence: 1 }, // inside removed silence
      { word: 'three', start: 5.0, end: 5.5, confidence: 1 },
      { word: 'four', start: 5.5, end: 6.0, confidence: 1 }
    ]
    const ass = buildAss({
      words: jumpWords,
      clipStart: 0,
      clipEnd: 6,
      style: STYLE,
      keepRanges: [
        [0, 1.0],
        [5.0, 6.0]
      ]
    })
    // The dropped-silence word is gone; the surviving words are continuous and the
    // single line ends at 0:00:02.00 (2s kept), not 0:00:06.00.
    expect(ass).not.toContain('gap')
    expect(ass).toContain(
      'Dialogue: 0,0:00:00.00,0:00:02.00,Karaoke,,0,0,0,,{\\k50}one{\\k50} two{\\k50} three{\\k50} four'
    )
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

describe('Part K — keyword emphasis + per-word animation + auto-emoji (golden)', () => {
  // Contiguous words (no gaps): I 0–0.20 (20cs), love 0.20–0.50 (30cs), money 0.50–0.90 (40cs).
  const words: WordTimestamp[] = [
    { word: 'I', start: 0, end: 0.2, confidence: 1 },
    { word: 'love', start: 0.2, end: 0.5, confidence: 1 },
    { word: 'money', start: 0.5, end: 0.9, confidence: 1 }
  ]

  it('keyword word gets a SOLID color (\\1c+\\2c) + {\\r} reset; non-keywords unchanged', () => {
    const style: CaptionStyle = { ...STYLE, keywordColor: '#00FF00' } // → &H0000FF00
    const ass = buildAss({ words, clipStart: 0, clipEnd: 2, style, keywords: ['money'] })
    expect(ass).toContain('{\\k20}I{\\k30} love{\\k40}{\\1c&H0000FF00\\2c&H0000FF00} money{\\r}')
  })

  it('keyword scale + bold', () => {
    const style: CaptionStyle = { ...STYLE, keywordScale: 120, keywordBold: true }
    const ass = buildAss({ words, clipStart: 0, clipEnd: 2, style, keywords: ['money'] })
    expect(ass).toContain('{\\k40}{\\fscx120\\fscy120\\b1} money{\\r}')
  })

  it('per-word bounce wraps EVERY syllable WITHOUT changing the \\k durations', () => {
    const style: CaptionStyle = { ...STYLE, perWordAnimation: 'bounce' }
    const ass = buildAss({ words, clipStart: 0, clipEnd: 2, style })
    expect(ass).toContain('{\\k20}{\\t(0,150,\\fscx115\\fscy115)}I{\\r}')
    expect(ass).toContain('{\\k30}{\\t(0,150,\\fscx115\\fscy115)} love{\\r}')
    // The \k durations are identical to the no-animation cue.
    const plain = buildAss({ words, clipStart: 0, clipEnd: 2, style: STYLE })
    expect(plain).toContain('{\\k20}I{\\k30} love{\\k40} money')
  })

  it('auto-emoji (local) appends the dictionary emoji after the word', () => {
    const style: CaptionStyle = { ...STYLE, autoEmoji: 'local' }
    const ass = buildAss({ words, clipStart: 0, clipEnd: 2, style })
    expect(ass).toContain(' love ❤️')
    expect(ass).toContain(' money 💰')
  })

  it('emojiPosition=before puts the emoji ahead of the word', () => {
    const style: CaptionStyle = { ...STYLE, autoEmoji: 'local', emojiPosition: 'before' }
    const ass = buildAss({ words, clipStart: 0, clipEnd: 2, style })
    expect(ass).toContain('💰 money')
  })

  it('style.wordsPerLine controls line grouping', () => {
    const style: CaptionStyle = { ...STYLE, wordsPerLine: 2 }
    const ass = buildAss({ words, clipStart: 0, clipEnd: 2, style })
    const dialogues = ass.split('\n').filter((l) => l.startsWith('Dialogue:'))
    expect(dialogues).toHaveLength(2) // 3 words / 2 per line
  })

  it('keywords passed but style has NO keyword fields ⇒ byte-identical (no override)', () => {
    const ass = buildAss({ words, clipStart: 0, clipEnd: 2, style: STYLE, keywords: ['money'] })
    expect(ass).toContain('{\\k20}I{\\k30} love{\\k40} money')
    expect(ass).not.toContain('\\1c')
    expect(ass).not.toContain('{\\r}')
  })
})
