/**
 * tests/unit/sidecar-srt.spec.ts — every exported clip gets a `.srt` beside it
 * (FEAT-vwvgs0).
 *
 * The export already holds the words it burns into pixels, scoped and rebased to
 * the clip, so writing the subtitle file alongside costs nothing at export time
 * — and a real `.srt` beats baked-in text where the user is going: searchable,
 * translatable, toggleable, and accepted by every upload form.
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeSidecarSubtitles } from '@main/services/ffmpeg-caption'
import type { WordTimestamp } from '@shared/schema'

const words: WordTimestamp[] = [
  { word: 'Hello', start: 10.0, end: 10.4, confidence: 0.9 },
  { word: 'world', start: 10.4, end: 11.0, confidence: 0.9 },
  { word: 'again', start: 30.0, end: 30.5, confidence: 0.9 }
]

describe('writeSidecarSubtitles', () => {
  it('writes a .srt beside the mp4, replacing the extension', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openclip-srt-'))
    const out = join(dir, 'my clip.mp4')
    const path = writeSidecarSubtitles({ outputPath: out, words, clipStart: 10, clipEnd: 12 })

    expect(path).toBe(join(dir, 'my clip.srt'))
    expect(existsSync(path)).toBe(true)
  })

  it('scopes to the clip and rebases so the first cue starts at zero', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openclip-srt-'))
    const out = join(dir, 'clip.mp4')
    const srt = readFileSync(
      writeSidecarSubtitles({ outputPath: out, words, clipStart: 10, clipEnd: 12 }),
      'utf8'
    )

    expect(srt).toContain('Hello world')
    // The word at 30s is outside the clip and must not appear.
    expect(srt).not.toContain('again')
    // Rebased: the exported video's own timeline starts at t=0.
    expect(srt).toContain('00:00:00,000 -->')
  })

  it('breaks cues where the caption burner breaks lines', () => {
    // The sidecar and the burned captions must agree; two different line-layout
    // rules would drift and read as a bug in whichever the user checks second.
    const dir = mkdtempSync(join(tmpdir(), 'openclip-srt-'))
    const many: WordTimestamp[] = Array.from({ length: 16 }, (_, i) => ({
      word: `w${i}`,
      start: i * 0.4,
      end: i * 0.4 + 0.35,
      confidence: 0.9
    }))
    const srt = readFileSync(
      writeSidecarSubtitles({
        outputPath: join(dir, 'c.mp4'),
        words: many,
        clipStart: 0,
        clipEnd: 10,
        maxWordsPerLine: 7
      }),
      'utf8'
    )
    // 16 words at 7 per cue → 3 cues.
    expect(srt).toContain('\n3\n')
    expect(srt).not.toContain('\n4\n')
  })
})

describe('export runner: the sidecar is actually wired', () => {
  const baseParams = {
    projectId: 'p1',
    clipId: 'c1',
    sourcePath: '/v/in.mp4',
    startTime: 10,
    endTime: 12,
    aspectRatio: '9:16' as const,
    quality: '1080p' as const
  }
  const ctx = { jobId: 'export-1', trackPid: () => {}, untrackPid: () => {} }
  const emit = { progress: () => {}, partial: () => {}, done: () => {}, error: () => {} }

  const run = async (outputPath: string, captions?: unknown): Promise<void> => {
    const { createExportRunner } = await import('@main/services/jobs/export-runner')
    await createExportRunner({
      exportClip: async () => ({ outputPath, width: 1080, height: 1920, durationSec: 2 }),
      writeClipCaptions: () => '/tmp/x.ass',
      fontsDir: () => '/fonts',
      resolveAssPath: () => '/tmp/x.ass',
      removeJobTemp: () => {}
    } as never)({ ...baseParams, outputPath, captions } as never, emit as never, ctx as never)
  }

  it('writes the .srt when the export burned captions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openclip-runner-'))
    const out = join(dir, 'clip.mp4')
    await run(out, { words })
    expect(existsSync(join(dir, 'clip.srt'))).toBe(true)
  })

  it('writes nothing when there were no captions to write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openclip-runner-'))
    const out = join(dir, 'clip.mp4')
    await run(out, undefined)
    expect(existsSync(join(dir, 'clip.srt'))).toBe(false)
  })

  it('a failed sidecar write does NOT fail the video that already rendered', async () => {
    // The mp4 is the deliverable; losing a subtitle file must not lose the export.
    const dir = mkdtempSync(join(tmpdir(), 'openclip-runner-'))
    // A path whose parent is a FILE, so the sidecar mkdir/write throws.
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'x')
    const out = join(blocker, 'nested', 'clip.mp4')
    await expect(run(out, { words })).resolves.toBeUndefined()
  })
})
