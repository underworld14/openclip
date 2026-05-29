/**
 * tests/unit/media-smoke.serial.spec.ts — @serial real-binary media de-risk smoke.
 *
 * This is the reproducible form of the Stage-4 manual smoke (plan E.2/E.7): it
 * runs the REAL bundled binaries — `whisper-cli` on Metal and the libass-enabled
 * `ffmpeg-static` caption burn — to prove the project's #1 unknown end-to-end:
 *   1. whisper-cli transcribes a 16kHz WAV to word-level JSON on Metal, and
 *      `parseWhisperJson` maps it into the frozen contract shapes.
 *   2. ffmpeg burns a karaoke `.ass` over a 9:16-cropped frame with the bundled
 *      font via `subtitles=…:fontsdir=…`, producing a 1080×1920 H.264 clip.
 *
 * @serial — must run single-file (machine-global lock): it spawns real binaries
 * and uses the one Metal GPU (plan E.7). It SKIPS gracefully when the model /
 * fixtures are absent (e.g. a stubbed CI) so the rest of the suite stays green;
 * the human-gated Metal run is the authoritative proof (PRD §21 top risk).
 *
 * Prereqs (present after the Stage-4 trunk run): `.smoke-cache/models/ggml-tiny.bin`,
 * `.smoke-cache/work/{audio.16k.wav,src1920.mp4,clip.ass}`, `whisper-cli` on PATH,
 * and `ffmpeg-static`. Override roots via OPENCLIP_SMOKE_MODEL / _WAV / _SRC / _ASS.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { parseWhisperJson, type WhisperJson } from '@main/services/whisper-parse'
import { WordTimestamp, TranscriptSegment } from '@shared/schema'

const REPO = resolve(__dirname, '../..')
const MODEL = process.env.OPENCLIP_SMOKE_MODEL ?? join(REPO, '.smoke-cache/models/ggml-tiny.bin')
const WAV = process.env.OPENCLIP_SMOKE_WAV ?? join(REPO, '.smoke-cache/work/audio.16k.wav')
const SRC = process.env.OPENCLIP_SMOKE_SRC ?? join(REPO, '.smoke-cache/work/src1920.mp4')
const ASS = process.env.OPENCLIP_SMOKE_ASS ?? join(REPO, '.smoke-cache/work/clip.ass')
const FONTS_DIR = join(REPO, 'build/fonts')

function whisperCli(): string | null {
  if (process.env.OPENCLIP_WHISPER_CLI) return process.env.OPENCLIP_WHISPER_CLI
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, 'whisper-cli'))) return join(dir, 'whisper-cli')
  }
  if (existsSync('/opt/homebrew/bin/whisper-cli')) return '/opt/homebrew/bin/whisper-cli'
  return null
}

function ffmpegStatic(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const p = require('ffmpeg-static') as string | null
    return p && existsSync(p) ? p : null
  } catch {
    return null
  }
}

const WHISPER = whisperCli()
const FFMPEG = ffmpegStatic()
const haveWhisper = !!WHISPER && existsSync(MODEL) && existsSync(WAV)
const haveLibass = !!FFMPEG && existsSync(SRC) && existsSync(ASS) && existsSync(FONTS_DIR)

describe('@serial media smoke — real whisper-cli on Metal', () => {
  it.skipIf(!haveWhisper)('transcribes a WAV to contract-valid word/segment JSON', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'openclip-whisper-'))
    try {
      const outBase = join(tmp, 'out')
      const stderr = execFileSync(
        WHISPER!,
        [
          '-m',
          MODEL,
          '-f',
          WAV,
          '-ml',
          '1',
          '--split-on-word',
          '--output-json-full',
          '--print-confidence',
          '-of',
          outBase
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      )
      // Metal must be the active backend (PRD §21 top risk). whisper prints the
      // system_info line either to the captured stdout or stderr depending on
      // version; we assert against the JSON `systeminfo` field below regardless.
      void stderr

      const json = JSON.parse(readFileSync(`${outBase}.json`, 'utf8')) as WhisperJson & {
        systeminfo?: string
      }
      // Metal confirmation: EMBED_LIBRARY=1 means the Metal backend is compiled in.
      expect(json.systeminfo).toMatch(/MTL\s*:\s*EMBED_LIBRARY\s*=\s*1/)

      const parsed = parseWhisperJson(json)
      expect(parsed.language).toBe('en')
      expect(parsed.words.length).toBeGreaterThan(0)
      expect(parsed.segments.length).toBeGreaterThan(0)
      for (const w of parsed.words) expect(() => WordTimestamp.parse(w)).not.toThrow()
      for (const s of parsed.segments) expect(() => TranscriptSegment.parse(s)).not.toThrow()
      // Words are time-ordered and within the ~4.6s fixture.
      expect(parsed.words[0].start).toBeGreaterThanOrEqual(0)
      expect(parsed.words[parsed.words.length - 1].end).toBeLessThanOrEqual(6)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('@serial media smoke — real libass burn at 1080x1920', () => {
  it.skipIf(!haveLibass)('burns a karaoke .ass over a 9:16 crop with the bundled font', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'openclip-libass-'))
    try {
      const out = join(tmp, 'burned.mp4')
      // The proven filtergraph order: scale → crop 9:16 → subtitles w/ fontsdir.
      const filter = `scale=-2:1920,crop=1080:1920,subtitles=${ASS}:fontsdir=${FONTS_DIR}`
      const burnLog = spawnSync(
        FFMPEG!,
        [
          '-hide_banner',
          '-y',
          '-i',
          SRC,
          '-vf',
          filter,
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-crf',
          '23',
          '-pix_fmt',
          'yuv420p',
          out
        ],
        { encoding: 'utf8' }
      )
      expect(burnLog.status).toBe(0)
      // The bundled font must resolve via fontsdir (not a host-installed font).
      expect(burnLog.stderr).toMatch(/Loading font file '.*build\/fonts\/DejaVuSans\.ttf'/)
      expect(burnLog.stderr).toMatch(/fontselect:.*DejaVu Sans.*->\s*DejaVuSans/)

      // ffprobe-assert: output is 1080x1920 H.264 with burned frames.
      const FFPROBE =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        (require('ffmpeg-ffprobe-static') as { ffprobePath?: string }).ffprobePath ?? 'ffprobe'
      const probe = JSON.parse(
        execFileSync(
          FFPROBE,
          [
            '-v',
            'error',
            '-select_streams',
            'v:0',
            '-count_frames',
            '-show_entries',
            'stream=width,height,codec_name,nb_read_frames',
            '-of',
            'json',
            out
          ],
          { encoding: 'utf8' }
        )
      ) as {
        streams: { width: number; height: number; codec_name: string; nb_read_frames: string }[]
      }
      const s = probe.streams[0]
      expect(s.width).toBe(1080)
      expect(s.height).toBe(1920)
      expect(s.codec_name).toBe('h264')
      expect(Number(s.nb_read_frames)).toBeGreaterThan(0)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
