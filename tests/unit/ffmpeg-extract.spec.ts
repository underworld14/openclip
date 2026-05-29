/**
 * tests/unit/ffmpeg-extract.spec.ts — unit coverage for the PURE arg/cache
 * helpers of the audio-extraction service (services/ffmpeg-extract.ts). The real
 * FFmpeg run is exercised by the @serial smoke + the integration E2E; here we
 * pin the verified 16kHz-mono argv (PRD §6.1) and the content-addressed cache
 * key (PRD §17) without spawning anything.
 */

import { describe, expect, it } from 'vitest'
import { audioExtractArgs, wavCacheKey } from '@main/services/ffmpeg-extract'

describe('ffmpeg-extract: verified 16kHz mono WAV argv (PRD §6.1)', () => {
  it('builds -vn -acodec pcm_s16le -ar 16000 -ac 1 with -progress on stderr', () => {
    const args = audioExtractArgs('/in/video.mp4', '/tmp/job/audio.16k.wav')
    expect(args).toEqual([
      '-hide_banner',
      '-y',
      '-i',
      '/in/video.mp4',
      '-vn',
      '-acodec',
      'pcm_s16le',
      '-ar',
      '16000',
      '-ac',
      '1',
      '-progress',
      'pipe:2',
      '-nostats',
      '/tmp/job/audio.16k.wav'
    ])
  })
})

describe('ffmpeg-extract: content-addressed WAV cache key (PRD §17)', () => {
  it('keys on source size + mtime so re-runs reuse the cached WAV', () => {
    const a = wavCacheKey({ size: 1234, mtimeMs: 1_716_900_000_000 })
    const b = wavCacheKey({ size: 1234, mtimeMs: 1_716_900_000_000 })
    expect(a).toBe(b)
    expect(a).toMatch(/\.16k\.wav$/)
  })
  it('changes when the source changes', () => {
    const a = wavCacheKey({ size: 1234, mtimeMs: 1 })
    const b = wavCacheKey({ size: 1235, mtimeMs: 1 })
    const c = wavCacheKey({ size: 1234, mtimeMs: 2 })
    expect(a).not.toBe(b)
    expect(a).not.toBe(c)
  })
})
