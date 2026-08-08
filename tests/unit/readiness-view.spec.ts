/**
 * tests/unit/readiness-view.spec.ts — the pure first-run readiness view-model
 * (FEAT-c5a15c).
 *
 * Nothing told a new user that clip generation needs a BYOK key and a model id,
 * or that transcription needs a GGML download — every requirement was discovered
 * by failure, minutes into the flow. This view-model turns the three checks the
 * app already has data for into chips, and decides whether Generate can run at
 * all.
 */

import { describe, expect, it } from 'vitest'
import { readinessView, type ReadinessInput } from '@renderer/components/readinessView'

const READY: ReadinessInput = {
  preflight: {
    ffmpeg: { ok: true, path: '/bin/ffmpeg' },
    ffprobe: { ok: true, path: '/bin/ffprobe' },
    whisperCli: { ok: true, path: '/bin/whisper-cli' },
    ytDlp: { ok: true, path: '/bin/yt-dlp' }
  },
  provider: 'openai',
  hasKey: true,
  model: 'gpt-5',
  whisperModel: 'base',
  whisperInstalled: true
}

describe('readinessView', () => {
  it('is fully ready when the key, model, whisper model and binaries are all present', () => {
    const vm = readinessView(READY)
    expect(vm.canGenerate).toBe(true)
    expect(vm.canTranscribe).toBe(true)
    expect(vm.blockingReason).toBeNull()
    expect(vm.chips.every((c) => c.ok)).toBe(true)
  })

  it('blocks generate with an actionable reason when no API key is saved', () => {
    const vm = readinessView({ ...READY, hasKey: false })
    expect(vm.canGenerate).toBe(false)
    expect(vm.blockingReason).toMatch(/api key/i)
    // Transcription is local — a missing cloud key must not disable it.
    expect(vm.canTranscribe).toBe(true)
  })

  it('blocks generate when no model id is set', () => {
    const vm = readinessView({ ...READY, model: '   ' })
    expect(vm.canGenerate).toBe(false)
    expect(vm.blockingReason).toMatch(/model/i)
  })

  it('does not require a key for Ollama, which runs locally', () => {
    const vm = readinessView({ ...READY, provider: 'ollama', hasKey: false, model: 'llama3.1' })
    expect(vm.canGenerate).toBe(true)
  })

  it('blocks transcription when the whisper model is not installed', () => {
    const vm = readinessView({ ...READY, whisperInstalled: false })
    expect(vm.canTranscribe).toBe(false)
    const chip = vm.chips.find((c) => c.id === 'transcription')!
    expect(chip.ok).toBe(false)
    expect(chip.detail).toMatch(/not installed/i)
  })

  it('blocks everything when ffmpeg is missing, since nothing decodes without it', () => {
    const vm = readinessView({
      ...READY,
      preflight: { ...READY.preflight!, ffmpeg: { ok: false } }
    })
    expect(vm.canTranscribe).toBe(false)
    expect(vm.canGenerate).toBe(false)
    expect(vm.blockingReason).toMatch(/ffmpeg/i)
  })

  it('reports an unknown preflight (not yet probed) without claiming failure', () => {
    const vm = readinessView({ ...READY, preflight: null })
    const chip = vm.chips.find((c) => c.id === 'engine')!
    expect(chip.state).toBe('unknown')
    // An unprobed engine must not block the user out of their own app.
    expect(vm.canTranscribe).toBe(true)
  })

  it('folds whisper-cli into transcription readiness — a model without its binary still fails', () => {
    // The preflight probed whisperCli and then ignored it: a machine with the
    // GGML model but no whisper-cli showed three green chips and died with a raw
    // spawn error mid-import, which is what SYSTEM_PREFLIGHT exists to prevent.
    const vm = readinessView({
      ...READY,
      preflight: { ...READY.preflight!, whisperCli: { ok: false } }
    })
    expect(vm.canTranscribe).toBe(false)
    expect(vm.chips.find((c) => c.id === 'transcription')!.ok).toBe(false)
  })

  it('does NOT require a whisper model to generate clips — that needs a transcript, not a transcriber', () => {
    // A user who opens a project that already has a transcript and deletes the
    // model to reclaim 2.9 GB must still be able to generate clips.
    const vm = readinessView({ ...READY, whisperInstalled: false })
    expect(vm.canTranscribe).toBe(false)
    expect(vm.canGenerate).toBe(true)
  })

  it('treats an unprobed whisper model as unknown, not as missing', () => {
    // `false` conflated "not installed" with "not checked yet", so every render
    // before the IPC resolved showed a red chip, and a failed probe pinned it.
    const vm = readinessView({ ...READY, whisperInstalled: null })
    const chip = vm.chips.find((c) => c.id === 'transcription')!
    expect(chip.state).toBe('unknown')
    expect(vm.canTranscribe).toBe(true)
  })

  it('names the exact settings pane each chip fixes', () => {
    const vm = readinessView({ ...READY, hasKey: false, whisperInstalled: false })
    expect(vm.chips.find((c) => c.id === 'ai')!.action).toBe('settings')
    expect(vm.chips.find((c) => c.id === 'transcription')!.action).toBe('download-model')
  })
})
