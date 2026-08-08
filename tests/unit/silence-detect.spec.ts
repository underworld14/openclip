/**
 * tests/unit/silence-detect.spec.ts — the silencedetect arg-builder + stderr
 * parser + the offset-to-absolute runner (Part I.4). No real ffmpeg: the spawn is
 * injected and fed canned stderr.
 */

import { describe, expect, it, vi } from 'vitest'
import { silenceDetectArgs, parseSilences, detectSilences } from '@main/services/silence-detect'

describe('silenceDetectArgs', () => {
  it('rejects a sourcePath that begins with a dash — option-injection guard (openclip-6l6)', () => {
    expect(() => silenceDetectArgs('-af', 0, 5)).toThrow(/sourcePath/)
  })

  it('seeks to the clip span and runs the silencedetect filter to a null sink', () => {
    const args = silenceDetectArgs('/src/in.mp4', 10, 20, { noiseDb: -28, minSilenceSec: 0.7 })
    expect(args).toEqual([
      '-hide_banner',
      '-nostats',
      '-ss',
      '10',
      '-i',
      '/src/in.mp4',
      '-t',
      '20',
      '-vn',
      '-af',
      'silencedetect=noise=-28dB:d=0.7',
      '-f',
      'null',
      '-'
    ])
  })

  it('defaults to -30dB / 0.5s', () => {
    const args = silenceDetectArgs('/s.mp4', 0, 5)
    expect(args).toContain('silencedetect=noise=-30dB:d=0.5')
  })

  it('disables the video stream — silencedetect is an audio-only measurement (BUG-88mac4)', () => {
    // Without -vn ffmpeg still decodes the video into a wrapped_avframe null encode
    // for a purely audio measurement. Measured cost: +1.1s per 60s 1080p clip,
    // +3.2s per 120s clip — paid on every export that removes silences.
    const args = silenceDetectArgs('/src/in.mp4', 12, 30)
    expect(args).toContain('-vn')
    // -vn is an OUTPUT option here: it must follow the input it disables.
    expect(args.indexOf('-vn')).toBeGreaterThan(args.indexOf('-i'))
  })
})

describe('parseSilences', () => {
  it('pairs silence_start/silence_end lines into 0-based ranges', () => {
    const stderr = [
      '[silencedetect @ 0x1] silence_start: 2.5',
      '[silencedetect @ 0x1] silence_end: 4.0 | silence_duration: 1.5',
      'frame= 100 ...',
      '[silencedetect @ 0x1] silence_start: 9.25',
      '[silencedetect @ 0x1] silence_end: 11.0 | silence_duration: 1.75'
    ].join('\n')
    expect(parseSilences(stderr)).toEqual([
      [2.5, 4.0],
      [9.25, 11.0]
    ])
  })

  it('closes a trailing unpaired silence_start at the fallback end (silence to EOF)', () => {
    const stderr = '[silencedetect] silence_start: 18.0'
    expect(parseSilences(stderr, 20)).toEqual([[18.0, 20]])
    expect(parseSilences(stderr)).toEqual([]) // no fallback → dropped
  })

  it('returns [] when there are no silence lines', () => {
    expect(parseSilences('frame=1\nframe=2\n')).toEqual([])
  })
})

describe('detectSilences', () => {
  it('offsets the parsed (0-based) times by startTime → absolute source ranges', async () => {
    const run = vi.fn(async () => ({
      stderr: 'silence_start: 2.0\nsilence_end: 5.0 | silence_duration: 3.0\n'
    }))
    const out = await detectSilences({
      sourcePath: '/src/in.mp4',
      startTime: 100,
      endTime: 130,
      run
    })
    expect(run).toHaveBeenCalledTimes(1)
    expect(out).toEqual([[102.0, 105.0]]) // 2.0+100, 5.0+100
  })

  it('returns [] for a non-positive span without spawning', async () => {
    const run = vi.fn()
    expect(await detectSilences({ sourcePath: '/s.mp4', startTime: 10, endTime: 10, run })).toEqual(
      []
    )
    expect(run).not.toHaveBeenCalled()
  })
})
