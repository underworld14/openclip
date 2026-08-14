/**
 * tests/unit/subtitle-export.spec.ts — the transcript is available as DATA, in
 * formats real players accept (FEAT-vwvgs0).
 *
 * PRD §6.2 lists transcript export as an acceptance criterion, and
 * `grep -rniE "srt|webvtt|\.vtt" src/` returned ZERO matches across the whole
 * tree: the app could burn captions into pixels but could not hand the user the
 * file they upload to YouTube, send to a translator, or open in a subtitle
 * editor.
 *
 * These are FILE FORMATS, so the assertions are on exact bytes. A comma where a
 * period belongs, or a missing `WEBVTT` header, produces a file that silently
 * fails to load in half the players that accept the other one.
 */

import { describe, expect, it } from 'vitest'
import {
  formatTimestamp,
  toSrt,
  toVtt,
  toPlainText,
  serializeTranscript,
  cuesFor
} from '@shared/subtitle-export'
import type { Transcript, TranscriptSegment } from '@shared/schema'

const seg = (id: string, start: number, end: number, text: string): TranscriptSegment => ({
  id,
  start,
  end,
  text,
  confidence: 0.9
})

const TRANSCRIPT: Transcript = {
  language: 'en',
  segments: [
    seg('s0', 0, 2.5, 'Hello world!'),
    seg('s1', 2.5, 5.25, 'This is a test.'),
    seg('s2', 61.001, 3725.5, 'Much later.')
  ],
  words: []
}

describe('formatTimestamp: the separator is the whole difference', () => {
  it('uses a COMMA for SRT and a PERIOD for VTT', () => {
    expect(formatTimestamp(2.5, 'srt')).toBe('00:00:02,500')
    expect(formatTimestamp(2.5, 'vtt')).toBe('00:00:02.500')
  })

  it('zero-pads hours, minutes, seconds and milliseconds', () => {
    expect(formatTimestamp(0, 'srt')).toBe('00:00:00,000')
    expect(formatTimestamp(61.001, 'srt')).toBe('00:01:01,001')
    expect(formatTimestamp(3725.5, 'srt')).toBe('01:02:05,500')
  })

  it('clamps a negative time rather than emitting a broken cue', () => {
    expect(formatTimestamp(-1, 'srt')).toBe('00:00:00,000')
  })
})

describe('toSrt', () => {
  it('emits 1-indexed cues separated by a blank line', () => {
    expect(toSrt(TRANSCRIPT)).toBe(
      [
        '1',
        '00:00:00,000 --> 00:00:02,500',
        'Hello world!',
        '',
        '2',
        '00:00:02,500 --> 00:00:05,250',
        'This is a test.',
        '',
        '3',
        '00:01:01,001 --> 01:02:05,500',
        'Much later.',
        ''
      ].join('\n')
    )
  })

  it('produces an empty string for an empty transcript, not a stray newline', () => {
    expect(toSrt({ language: 'en', segments: [], words: [] })).toBe('')
  })
})

describe('toVtt', () => {
  it('starts with the mandatory WEBVTT header and uses dot-separated times', () => {
    const vtt = toVtt(TRANSCRIPT)
    expect(vtt.startsWith('WEBVTT\n\n')).toBe(true)
    expect(vtt).toContain('00:00:00.000 --> 00:00:02.500')
    // Cue numbers are optional in VTT and omitted here; the header is not.
    expect(vtt).not.toMatch(/^\d+$/m)
  })

  it('still emits the header when there are no cues', () => {
    // A headerless file is not a VTT file, even an empty one.
    expect(toVtt({ language: 'en', segments: [], words: [] })).toBe('WEBVTT\n\n')
  })
})

describe('toPlainText', () => {
  it('drops the timings entirely — this is for prose, not players', () => {
    expect(toPlainText(TRANSCRIPT)).toBe('Hello world!\nThis is a test.\nMuch later.\n')
  })
})

describe('cuesFor: scoping and rebasing to a clip', () => {
  it('keeps only intersecting segments and rebases to t=0', () => {
    const cues = cuesFor(TRANSCRIPT.segments, { start: 2.5, end: 5.25 })
    expect(cues).toEqual([{ start: 0, end: 2.75, text: 'This is a test.' }])
  })

  it('clamps a segment that straddles the clip boundary', () => {
    const cues = cuesFor([seg('a', 0, 10, 'straddles')], { start: 4, end: 6 })
    expect(cues).toEqual([{ start: 0, end: 2, text: 'straddles' }])
  })

  it('drops empty and whitespace-only segments', () => {
    const cues = cuesFor([seg('a', 0, 1, '   '), seg('b', 1, 2, 'kept')])
    expect(cues.map((c) => c.text)).toEqual(['kept'])
  })

  it('drops a segment that merely touches the clip edge', () => {
    // end === clip.start is not an overlap; emitting a zero-length cue here
    // produces a file some players reject outright.
    expect(cuesFor([seg('a', 0, 4, 'before')], { start: 4, end: 6 })).toEqual([])
  })
})

describe('serializeTranscript: the dispatcher', () => {
  it('routes each format to its serializer', () => {
    expect(serializeTranscript(TRANSCRIPT, 'srt')).toBe(toSrt(TRANSCRIPT))
    expect(serializeTranscript(TRANSCRIPT, 'vtt')).toBe(toVtt(TRANSCRIPT))
    expect(serializeTranscript(TRANSCRIPT, 'txt')).toBe(toPlainText(TRANSCRIPT))
  })

  it('threads the clip scope through', () => {
    const scoped = serializeTranscript(TRANSCRIPT, 'srt', { start: 2.5, end: 5.25 })
    expect(scoped).toContain('This is a test.')
    expect(scoped).not.toContain('Hello world!')
    expect(scoped).toContain('00:00:00,000 -->') // rebased
  })
})
