/**
 * tests/unit/whisper-parse.spec.ts — validates the pure whisper-cli JSON → contract
 * transform against the REAL whisper-cli output captured by the Stage-4 media smoke.
 *
 * Fixture provenance: `whisper-cli` (whisper.cpp 1.8.4) run on Metal over a
 * 4.6s 16kHz mono WAV (macOS `say` → ffmpeg extract) with
 * `-ml 1 --split-on-word --output-json-full --print-confidence`. The fixture is
 * verbatim its on-disk `out.json` — NOT hand-authored — so this test pins the
 * finalized `WordTimestamp`/`TranscriptSegment` shapes to ground truth.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  parseWhisperJson,
  extractWords,
  groupSegments,
  type WhisperJson
} from '@main/services/whisper-parse'
import { WordTimestamp, TranscriptSegment } from '@shared/schema'

const FIXTURE_DIR = resolve(__dirname, '../fixtures/whisper')

function loadFixture(name: string): WhisperJson {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, name), 'utf8')) as WhisperJson
}

describe('whisper-parse — real whisper-cli JSON (-ml 1 --split-on-word)', () => {
  const json = loadFixture('real-whisper-cli-tiny-ml1-sow.json')

  it('detects language from result.language', () => {
    expect(parseWhisperJson(json).language).toBe('en')
  })

  it('extracts clean whole words, dropping [_BEG_]/[_TT_*] blank entries', () => {
    const words = extractWords(json)
    // The fixture has 16 transcription[] entries; entry 0 is blank ([_BEG_]),
    // leaving 15 real words.
    expect(words.map((w) => w.word)).toEqual([
      'Hello',
      'world!',
      'This',
      'is',
      'a',
      'test',
      'of',
      'the',
      'Open',
      'Clip',
      'Transcription',
      'Pipeline',
      'running',
      'on',
      'metal.'
    ])
  })

  it('converts ms offsets to absolute seconds', () => {
    const words = extractWords(json)
    // Entry 1 "Hello": offsets 50ms -> 470ms.
    expect(words[0]).toMatchObject({ word: 'Hello', start: 0.05, end: 0.47 })
    // Last word "metal." ends at 4640ms.
    expect(words[words.length - 1].end).toBe(4.64)
  })

  it('derives word confidence as mean of non-special token probabilities (0..1)', () => {
    const words = extractWords(json)
    for (const w of words) {
      expect(w.confidence).toBeGreaterThan(0)
      expect(w.confidence).toBeLessThanOrEqual(1)
    }
    // "Hello" is a single token p=0.936351.
    expect(words[0].confidence).toBeCloseTo(0.936351, 5)
    // "world!" = mean(0.53651, 0.469958) ≈ 0.503234.
    expect(words[1].confidence).toBeCloseTo((0.53651 + 0.469958) / 2, 5)
  })

  it('groups words into sentence segments on terminal punctuation', () => {
    const { segments } = parseWhisperJson(json)
    // The fixture has two sentences: "Hello world!" then "This is …metal."
    expect(segments).toHaveLength(2)
    expect(segments.map((s) => s.id)).toEqual(['seg-0', 'seg-1'])
    expect(segments[0].text).toBe('Hello world!')
    expect(segments[1].text).toBe(
      'This is a test of the Open Clip Transcription Pipeline running on metal.'
    )
    // seg-0 spans "Hello"(50ms) → "world!"(1240ms); seg-1 → last word "metal."(4640ms).
    expect(segments[0].start).toBe(0.05)
    expect(segments[0].end).toBe(1.24)
    expect(segments[1].end).toBe(4.64)
    for (const s of segments) {
      expect(s.confidence).toBeGreaterThan(0)
      expect(s.confidence).toBeLessThanOrEqual(1)
    }
  })

  it('produces output that satisfies the frozen Zod contract shapes', () => {
    const { words, segments } = parseWhisperJson(json)
    for (const w of words) expect(() => WordTimestamp.parse(w)).not.toThrow()
    for (const s of segments) expect(() => TranscriptSegment.parse(s)).not.toThrow()
  })
})

describe('whisper-parse — segment grouping edge cases', () => {
  it('splits multiple sentences and flushes a trailing partial', () => {
    const json: WhisperJson = {
      result: { language: 'en' },
      transcription: [
        { text: ' Hi', offsets: { from: 0, to: 100 }, tokens: [{ text: ' Hi', p: 0.9 }] },
        { text: ' there.', offsets: { from: 100, to: 300 }, tokens: [{ text: ' there.', p: 0.8 }] },
        { text: ' Bye', offsets: { from: 300, to: 500 }, tokens: [{ text: ' Bye', p: 0.7 }] },
        { text: ' now', offsets: { from: 500, to: 700 }, tokens: [{ text: ' now', p: 0.6 }] }
      ]
    }
    const segments = groupSegments(extractWords(json))
    expect(segments.map((s) => s.text)).toEqual(['Hi there.', 'Bye now'])
    expect(segments[0].id).toBe('seg-0')
    expect(segments[1].id).toBe('seg-1')
    // seg-0 spans the first two words; seg-1 the trailing partial.
    expect(segments[0]).toMatchObject({ start: 0, end: 0.3 })
    expect(segments[1]).toMatchObject({ start: 0.3, end: 0.7 })
  })

  it('handles empty transcription without throwing', () => {
    const out = parseWhisperJson({ transcription: [] })
    expect(out).toEqual({ language: 'en', words: [], segments: [] })
  })
})

describe('whisper-parse — sentence-mode JSON (no -ml) still maps', () => {
  it('parses a single multi-word segment entry into words via tokens fallback', () => {
    // The no -ml fixture has one transcription[] entry whose text is the whole
    // sentence; extractWords treats that entry as a single "word" (the runner
    // uses -ml 1 in practice, but the parser must not crash on sentence JSON).
    const json = loadFixture('real-whisper-cli-tiny-sentence.json')
    const out = parseWhisperJson(json)
    expect(out.language).toBe('en')
    expect(out.words.length).toBeGreaterThanOrEqual(1)
    // Whole-sentence text is present.
    expect(out.segments.map((s) => s.text).join(' ')).toContain('Hello world')
  })
})
