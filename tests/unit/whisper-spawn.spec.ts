/**
 * tests/unit/whisper-spawn.spec.ts — unit coverage for the T-Media whisper SPAWN
 * side (services/whisper-spawn.ts). The PURE parts are tested without a real
 * binary:
 *   - `parseWhisperProgress` reads `whisper_print_progress_callback: progress = N%`
 *     stderr lines (the `-pp` stream) → 0..100 pct.
 *   - `parseWhisperWordLine` reads a `[hh:mm:ss.mmm --> hh:mm:ss.mmm]  word`
 *     stdout line (the `-ml 1 --split-on-word` stream) → a partial WordTimestamp.
 *   - `whisperArgs` builds EXACTLY the Gate-A-verified invocation.
 *
 * The full spawn → JSON parse path is exercised end-to-end against the REAL
 * binary in `whisper-smoke.serial.spec.ts` (@serial). Here we only pin the pure
 * stream/arg helpers (PRD §18 "mock at the boundary").
 */

import { describe, expect, it } from 'vitest'
import {
  parseWhisperProgress,
  parseWhisperWordLine,
  whisperArgs,
  stripAnsi
} from '@main/services/whisper-spawn'

describe('whisper-spawn: argument construction (Gate-A exact invocation)', () => {
  it('builds the verified -ml 1 --split-on-word --output-json-full flags', () => {
    const args = whisperArgs({
      model: '/models/ggml-base.bin',
      wavPath: '/tmp/audio.16k.wav',
      outBase: '/tmp/job/out'
    })
    expect(args).toEqual([
      '-m',
      '/models/ggml-base.bin',
      '-f',
      '/tmp/audio.16k.wav',
      '-ml',
      '1',
      '--split-on-word',
      '--output-json-full',
      '--print-confidence',
      '-pp',
      '-of',
      '/tmp/job/out'
    ])
  })

  it('passes -l <language> only when a language is given (else auto-detect)', () => {
    const auto = whisperArgs({ model: 'm', wavPath: 'w', outBase: 'o' })
    expect(auto).not.toContain('-l')
    const fixed = whisperArgs({ model: 'm', wavPath: 'w', outBase: 'o', language: 'es' })
    expect(fixed.slice(-2)).toEqual(['-of', 'o']) // -of stays last
    expect(fixed).toContain('-l')
    expect(fixed[fixed.indexOf('-l') + 1]).toBe('es')
  })
})

describe('whisper-spawn: stderr progress parsing (-pp stream)', () => {
  it('reads the whisper progress callback percentage', () => {
    expect(parseWhisperProgress('whisper_print_progress_callback: progress = 40%')).toBe(40)
    expect(parseWhisperProgress('whisper_print_progress_callback: progress = 100%')).toBe(100)
  })

  it('returns undefined for non-progress lines', () => {
    expect(parseWhisperProgress('whisper_print_timings: load time = 45 ms')).toBeUndefined()
    expect(parseWhisperProgress('main: processing ... 4.6 sec')).toBeUndefined()
  })

  it('finds the LAST progress value in a multi-line chunk', () => {
    const chunk = [
      'whisper_print_progress_callback: progress = 20%',
      'some noise',
      'whisper_print_progress_callback: progress = 55%'
    ].join('\n')
    expect(parseWhisperProgress(chunk)).toBe(55)
  })
})

describe('whisper-spawn: stdout word-line parsing (-ml 1 --split-on-word stream)', () => {
  it('strips ANSI confidence colors whisper emits with --print-confidence', () => {
    expect(stripAnsi('[2m Hello[0m')).toBe(' Hello')
  })

  it('parses a [from --> to] word line into an absolute-seconds WordTimestamp', () => {
    const w = parseWhisperWordLine('[00:00:00.050 --> 00:00:00.470]   Hello')
    expect(w).toEqual({ word: 'Hello', start: 0.05, end: 0.47, confidence: 0 })
  })

  it('parses minute/second spans and trims punctuation-bearing words', () => {
    const w = parseWhisperWordLine('[00:01:02.120 --> 00:01:02.640]   metal.')
    expect(w).toMatchObject({ word: 'metal.', start: 62.12, end: 62.64 })
  })

  it('handles the ANSI-colored confidence form whisper prints', () => {
    const line = '[00:00:00.470 --> 00:00:01.240]  [4m world[0m[4m![0m'
    expect(parseWhisperWordLine(line)).toMatchObject({ word: 'world!', start: 0.47, end: 1.24 })
  })

  it('returns null for blank / non-word lines (the [_BEG_] empty entry)', () => {
    expect(parseWhisperWordLine('[00:00:00.000 --> 00:00:00.050]  ')).toBeNull()
    expect(parseWhisperWordLine('main: processing ...')).toBeNull()
    expect(parseWhisperWordLine('')).toBeNull()
  })
})
