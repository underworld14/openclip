/**
 * tests/unit/ffmpeg-extract.spec.ts — unit coverage for the PURE arg/cache
 * helpers of the audio-extraction service (services/ffmpeg-extract.ts). The real
 * FFmpeg run is exercised by the @serial smoke + the integration E2E; here we
 * pin the verified 16kHz-mono argv (PRD §6.1) and the content-addressed cache
 * key (PRD §17) without spawning anything.
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { audioExtractArgs, wavCacheKey, extractAudio } from '@main/services/ffmpeg-extract'

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

describe('ffmpeg-extract: atomic WAV cache (audit fix openclip-2bg)', () => {
  it('a killed extraction does not poison the content-addressed cache', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-extract-'))
    const src = join(dir, 'src.mp4')
    writeFileSync(src, 'video-bytes')
    try {
      // 1) extraction is killed AFTER ffmpeg wrote a partial file to its output arg.
      let killedOut = ''
      const killed = async (o: { args: string[] }): Promise<void> => {
        killedOut = o.args[o.args.length - 1]
        writeFileSync(killedOut, 'PARTIAL')
        throw new Error('killed')
      }
      await expect(
        extractAudio({ projectId: 'p1', sourcePath: src, baseTemp: dir, runFfmpeg: killed })
      ).rejects.toThrow(/killed/)
      // The partial must NOT survive at the final cache path (it went to a temp name).
      expect(killedOut).toMatch(/\.tmp$|\.partial$/)

      // 2) the next extraction must RE-RUN (not serve the partial as a cache hit).
      let ran = false
      const ok = async (o: { args: string[] }): Promise<void> => {
        ran = true
        writeFileSync(o.args[o.args.length - 1], 'COMPLETE')
      }
      const res = await extractAudio({
        projectId: 'p1',
        sourcePath: src,
        baseTemp: dir,
        runFfmpeg: ok
      })
      expect(ran).toBe(true)
      expect(res.cached).toBe(false)
      expect(readFileSync(res.wavPath, 'utf8')).toBe('COMPLETE')
      expect(res.wavPath).toMatch(/\.16k\.wav$/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a successful extraction is reused as a cache hit on the next call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-extract-'))
    const src = join(dir, 'src.mp4')
    writeFileSync(src, 'video-bytes')
    try {
      const ok = async (o: { args: string[] }): Promise<void> => {
        writeFileSync(o.args[o.args.length - 1], 'WAV')
      }
      const first = await extractAudio({
        projectId: 'p1',
        sourcePath: src,
        baseTemp: dir,
        runFfmpeg: ok
      })
      expect(first.cached).toBe(false)
      expect(existsSync(first.wavPath)).toBe(true)
      // second call: runFfmpeg must NOT be invoked (cache hit on the complete file).
      const second = await extractAudio({
        projectId: 'p1',
        sourcePath: src,
        baseTemp: dir,
        runFfmpeg: async () => {
          throw new Error('should not re-extract a cached WAV')
        }
      })
      expect(second.cached).toBe(true)
      expect(second.wavPath).toBe(first.wavPath)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
