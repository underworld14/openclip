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
import { providerLabel, providerNeedsBaseUrl, providerRequiresKey } from '@shared/ai-providers'
import type { PreflightResult } from '@shared/channels'
import type { WhisperModelSize } from '@shared/jobs'

export interface ReadinessInput {
  /** null while the probe is still in flight — distinct from "probed and missing". */
  preflight: PreflightResult | null
  provider: AIProvider
  hasKey: boolean
  /** The custom provider's endpoint — its equivalent of a key (FEAT-bysdwg). */
  baseUrl?: string
  model: string
  whisperModel: WhisperModelSize
  /** null while the on-disk check is still in flight — distinct from "checked and absent". */
  whisperInstalled: boolean | null
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

// "Needs a key" / "needs an endpoint" live in `@shared/ai-providers` — the rule
// was hand-copied into three files, and a keyless custom endpoint made every
// copy wrong in a different way (FEAT-bysdwg).

export function readinessView(input: ReadinessInput): ReadinessView {
  // An unprobed engine is NOT a failure. Treating it as one would lock the user
  // out of their own app for the moment before the probe resolves.
  const engineProbed = input.preflight !== null
  const engineOk = !engineProbed || (input.preflight!.ffmpeg.ok && input.preflight!.ffprobe.ok)
  // whisper-cli belongs to TRANSCRIPTION, not the generic engine chip: without it
  // an installed GGML model is useless, and the probe reporting it was previously
  // collected and then thrown away.
  const whisperCliOk = !engineProbed || input.preflight!.whisperCli.ok
  // `null` = not probed yet. Conflating that with "absent" made every render
  // before the IPC resolved show a red chip, and pinned it there on failure.
  const whisperProbed = input.whisperInstalled !== null
  const whisperReady = !whisperProbed || (input.whisperInstalled === true && whisperCliOk)

  const keyOk = !providerRequiresKey(input.provider) || input.hasKey
  const modelOk = input.model.trim().length > 0
  // A custom endpoint with no URL is not "missing a key" — it has nowhere to
  // send anything, and saying "add an API key" sends the user hunting for one
  // their local server does not want.
  const endpointOk =
    !providerNeedsBaseUrl(input.provider) || (input.baseUrl ?? '').trim().length > 0
  const aiOk = endpointOk && keyOk && modelOk

  const chips: ReadinessChip[] = [
    {
      id: 'transcription',
      label: `Transcription: ${input.whisperModel}`,
      detail: !whisperProbed
        ? 'Checking…'
        : !whisperCliOk
          ? 'whisper-cli could not be found — transcription will fail.'
          : input.whisperInstalled
            ? 'Model installed — transcription runs on this Mac.'
            : `The ${input.whisperModel} model is not installed yet.`,
      ok: whisperReady,
      state: !whisperProbed ? 'unknown' : whisperReady ? 'ok' : 'missing',
      // A missing BINARY is not something the download dialog can fix.
      action: whisperProbed && !input.whisperInstalled && whisperCliOk ? 'download-model' : 'none'
    },
    {
      id: 'ai',
      label: aiOk ? `AI: ${input.model}` : 'AI: not configured',
      detail: !endpointOk
        ? 'No endpoint URL set for your custom provider. Add it in Settings.'
        : !keyOk
          ? `No API key saved for ${providerLabel(input.provider)}. Only text — never your video — is ever sent.`
          : !modelOk
            ? 'No model chosen yet.'
            : `${providerLabel(input.provider)} · ${input.model}`,
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

  const canTranscribe = engineOk && whisperReady
  // Clip detection consumes a TRANSCRIPT, not a transcriber: a user who opens a
  // project that already has one and then deletes the model to reclaim disk must
  // still be able to generate. Coupling these was also the only reason
  // MODEL_STATUS needed an OPENCLIP_FAKE_TRANSCRIBE special case.
  const canGenerate = engineOk && aiOk

  // One reason, chosen by what the user has to fix FIRST — a list of everything
  // wrong is harder to act on than the next step.
  let blockingReason: string | null = null
  if (!engineOk) blockingReason = 'ffmpeg could not be found — video processing will fail.'
  // The endpoint comes first: without one there is nowhere to send a key.
  else if (!endpointOk) blockingReason = 'Add your endpoint’s Base URL in Settings.'
  else if (!keyOk)
    blockingReason = `Add an API key for ${providerLabel(input.provider)} in Settings.`
  else if (!modelOk) blockingReason = 'Choose a model in Settings.'

  return { chips, canTranscribe, canGenerate, blockingReason }
}
