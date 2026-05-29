/**
 * tests/unit/whisper-smoke.serial.spec.ts — @serial real-binary smoke for the
 * T-Media SPAWN side (`runWhisper`). Reuses the tiny model from the Stage-4
 * trunk smoke and the bundled fixture WAV, runs the REAL `whisper-cli` on Metal
 * via our `runWhisper` (the same spawn path the transcribe job uses), and
 * asserts it streams words + produces a contract-valid transcript.
 *
 * @serial — single-file (machine-global lock): real binary + the one Metal GPU
 * (plan E.7). SKIPS gracefully when the model/WAV/binary are absent (stubbed CI),
 * so the parallel mocked suite stays green. Override the model/WAV via
 * OPENCLIP_SMOKE_MODEL / OPENCLIP_SMOKE_WAV.
 */

import { existsSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runWhisper } from '@main/services/whisper-spawn'
import { WordTimestamp, TranscriptSegment } from '@shared/schema'

function whisperCli(): string | null {
  if (process.env.OPENCLIP_WHISPER_CLI) return process.env.OPENCLIP_WHISPER_CLI
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, 'whisper-cli'))) return join(dir, 'whisper-cli')
  }
  if (existsSync('/opt/homebrew/bin/whisper-cli')) return '/opt/homebrew/bin/whisper-cli'
  return null
}

/** Reuse the trunk smoke artifacts (this worktree is a sibling of the trunk). */
const TRUNK_CACHE = '/Users/izzadev/Projects/openclip/.smoke-cache'
const MODEL =
  process.env.OPENCLIP_SMOKE_MODEL ??
  [
    join(process.cwd(), '.smoke-cache/models/ggml-tiny.bin'),
    `${TRUNK_CACHE}/models/ggml-tiny.bin`
  ].find(existsSync) ??
  ''
const WAV =
  process.env.OPENCLIP_SMOKE_WAV ??
  [
    join(process.cwd(), '.smoke-cache/work/audio.16k.wav'),
    `${TRUNK_CACHE}/work/audio.16k.wav`
  ].find(existsSync) ??
  ''

const WHISPER = whisperCli()
const haveAll = !!WHISPER && !!MODEL && existsSync(MODEL) && !!WAV && existsSync(WAV)

describe('@serial whisper-spawn smoke — real whisper-cli on Metal via runWhisper', () => {
  it.skipIf(!haveAll)(
    'streams words and returns a contract-valid transcript',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'openclip-runwhisper-'))
      try {
        const streamedWords: string[] = []
        let lastPct = 0
        const parsed = await runWhisper({
          model: MODEL,
          wavPath: WAV,
          outBase: join(tmp, 'out'),
          binPath: WHISPER!,
          onWord: (w) => streamedWords.push(w.word),
          onProgress: (pct) => {
            lastPct = pct
          }
        })

        // Live stream produced words; final parse produced segments + words.
        expect(streamedWords.length).toBeGreaterThan(0)
        expect(lastPct).toBeGreaterThan(0)
        expect(parsed.language).toBe('en')
        expect(parsed.words.length).toBeGreaterThan(0)
        expect(parsed.segments.length).toBeGreaterThan(0)
        for (const w of parsed.words) expect(() => WordTimestamp.parse(w)).not.toThrow()
        for (const s of parsed.segments) expect(() => TranscriptSegment.parse(s)).not.toThrow()
        // Words are time-ordered within the ~4.6s fixture.
        expect(parsed.words[0].start).toBeGreaterThanOrEqual(0)
        expect(parsed.words[parsed.words.length - 1].end).toBeLessThanOrEqual(6)
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
    60_000
  )
})
