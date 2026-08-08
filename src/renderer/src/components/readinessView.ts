/**
 * readinessView.ts — the pure first-run readiness view-model (FEAT-c5a15c).
 *
 * A brand-new user was never told that clip generation needs a BYOK key and a
 * model id, or that transcription needs a 75MB–2.9GB GGML download. Every
 * requirement was discovered by failure, and the failure arrived minutes in —
 * after an import and a full transcription. Every input below already existed in
 * the app; nothing reported it.
 *
 * Pure so it can be unit-tested without a DOM, matching `Dashboard.view` /
 * `settingsView` / `clipView`.
 */

import type { AIProvider } from '@shared/schema'
import type { PreflightResult } from '@shared/channels'
import type { WhisperModelSize } from '@shared/jobs'

export interface ReadinessInput {
  /** null while the probe is still in flight — distinct from "probed and missing". */
  preflight: PreflightResult | null
  provider: AIProvider
  hasKey: boolean
  model: string
  whisperModel: WhisperModelSize
  whisperInstalled: boolean
}

/** What clicking a chip should open. */
export type ReadinessAction = 'settings' | 'download-model' | 'none'

export interface ReadinessChip {
  id: 'transcription' | 'ai' | 'engine'
  label: string
  detail: string
  ok: boolean
  /** `unknown` = not probed yet; render neutral, never as a failure. */
  state: 'ok' | 'missing' | 'unknown'
  action: ReadinessAction
}

export interface ReadinessView {
  chips: ReadinessChip[]
  /** Import + transcription are local; they need ffmpeg and a whisper model. */
  canTranscribe: boolean
  /** Clip detection additionally needs a reachable provider + model id. */
  canGenerate: boolean
  /** The single most useful thing to tell the user, or null when ready. */
  blockingReason: string | null
}

/** Ollama runs on this machine and needs no BYOK key. */
function needsKey(provider: AIProvider): boolean {
  return provider !== 'ollama'
}

export function readinessView(input: ReadinessInput): ReadinessView {
  // An unprobed engine is NOT a failure. Treating it as one would lock the user
  // out of their own app for the moment before the probe resolves.
  const engineProbed = input.preflight !== null
  const engineOk = !engineProbed || (input.preflight!.ffmpeg.ok && input.preflight!.ffprobe.ok)

  const keyOk = !needsKey(input.provider) || input.hasKey
  const modelOk = input.model.trim().length > 0
  const aiOk = keyOk && modelOk

  const chips: ReadinessChip[] = [
    {
      id: 'transcription',
      label: `Transcription: ${input.whisperModel}`,
      detail: input.whisperInstalled
        ? 'Model installed — transcription runs on this Mac.'
        : `The ${input.whisperModel} model is not installed yet.`,
      ok: input.whisperInstalled,
      state: input.whisperInstalled ? 'ok' : 'missing',
      action: input.whisperInstalled ? 'none' : 'download-model'
    },
    {
      id: 'ai',
      label: aiOk ? `AI: ${input.model}` : 'AI: not configured',
      detail: !keyOk
        ? `No API key saved for ${input.provider}. Only transcript text is ever sent.`
        : !modelOk
          ? 'No model chosen yet.'
          : `${input.provider} · ${input.model}`,
      ok: aiOk,
      state: aiOk ? 'ok' : 'missing',
      action: aiOk ? 'none' : 'settings'
    },
    {
      id: 'engine',
      label: 'Video engine',
      detail: !engineProbed
        ? 'Checking…'
        : engineOk
          ? 'ffmpeg ready.'
          : 'ffmpeg could not be found — video processing will fail.',
      ok: engineOk,
      state: !engineProbed ? 'unknown' : engineOk ? 'ok' : 'missing',
      action: 'none'
    }
  ]

  const canTranscribe = engineOk && input.whisperInstalled
  const canGenerate = canTranscribe && aiOk

  // One reason, chosen by what the user has to fix FIRST — a list of everything
  // wrong is harder to act on than the next step.
  let blockingReason: string | null = null
  if (!engineOk) blockingReason = 'ffmpeg could not be found — video processing will fail.'
  else if (!input.whisperInstalled)
    blockingReason = `Download the ${input.whisperModel} transcription model first.`
  else if (!keyOk) blockingReason = `Add an API key for ${input.provider} in Settings.`
  else if (!modelOk) blockingReason = 'Choose a model in Settings.'

  return { chips, canTranscribe, canGenerate, blockingReason }
}
