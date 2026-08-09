/**
 * src/main/ipc/job-start-validation.ts — validate the inbound JOB_START payload at the
 * main-process trust boundary (audit fix openclip-qki).
 *
 * JOB_START is the most exposed control-plane entry: `payload.kind` + `payload.params`
 * were cast to a TS type and forwarded straight into `sidecar.startJob`, which spawns
 * ffmpeg / whisper / yt-dlp and touches the filesystem. A compromised or buggy renderer
 * could send wrong-typed / missing / hostile values. We parse the payload here and reject
 * it with a typed INPUT_INVALID before it reaches a runner.
 *
 * Scope: validate `kind` and the SECURITY-SENSITIVE params (paths, ids, url, model,
 * aspect, times) — the values that reach spawn()/fs. Non-sensitive payload data (caption
 * words/style) is allowed through (`looseObject`); it's escaped/handled downstream and
 * carrying a full schema for it here would duplicate schema.ts. The leading-`-` option
 * injection on paths is additionally guarded at the spawn boundary (openclip-6l6).
 */

import { z } from 'zod'
import { JobError, type JobKind, type JobParams } from '@shared/jobs'

const WHISPER_MODELS = ['tiny', 'base', 'small', 'medium', 'turbo', 'large-v3'] as const
const ASPECTS = ['9:16', '1:1', '4:5', '16:9'] as const
const AI_PROVIDERS = ['openai', 'anthropic', 'google', 'ollama', 'openrouter'] as const
const nonEmpty = z.string().min(1)

/** Per-kind params validators — strict on the sensitive fields, loose on the rest. */
const paramsByKind = {
  transcribe: z.looseObject({
    projectId: nonEmpty,
    wavPath: nonEmpty,
    model: z.enum(WHISPER_MODELS),
    language: z.string().optional()
  }),
  export: z.looseObject({
    projectId: nonEmpty,
    clipId: nonEmpty,
    sourcePath: nonEmpty,
    outputPath: nonEmpty,
    startTime: z.number().finite(),
    endTime: z.number().finite(),
    aspectRatio: z.enum(ASPECTS)
  }),
  'model-download': z.looseObject({ model: z.enum(WHISPER_MODELS) }),
  'url-download': z.looseObject({
    url: z.string().regex(/^https?:\/\//i, 'must be an http(s) URL')
  }),
  // Nothing here reaches spawn() or the filesystem — the sensitive values are
  // the ones that pick a PROVIDER and spend the user's BYOK budget. `numClips`
  // is additionally clamped to 1..50 in the runner (audit fix openclip-9hc):
  // an unbounded value inflates the prompt and risks output truncation.
  'generate-clips': z.looseObject({
    projectId: nonEmpty,
    provider: z.enum(AI_PROVIDERS),
    model: nonEmpty,
    segments: z.array(z.unknown()),
    numClips: z.number().finite(),
    durationSeconds: z.number().finite()
  })
} as const

const KIND = z.enum(['transcribe', 'export', 'model-download', 'url-download', 'generate-clips'])
const ENVELOPE = z.object({ kind: KIND, params: z.unknown() })

/**
 * Parse an inbound JOB_START payload. Returns the validated `{ kind, params }` ready to
 * hand to `sidecar.startJob`, or throws `JobError('INPUT_INVALID', …, false)` (a
 * non-retriable typed error) when the kind is unknown or a sensitive param is malformed.
 */
export function validateJobStart(payload: unknown): {
  kind: JobKind
  params: JobParams[JobKind]
} {
  const envelope = ENVELOPE.safeParse(payload)
  if (!envelope.success) {
    // The code is repeated in the message so it survives IPC error serialization, where
    // the JobError.code field may be dropped.
    throw new JobError('INPUT_INVALID', `INPUT_INVALID JOB_START: ${envelope.error.message}`, false)
  }
  const kind = envelope.data.kind
  const parsed = paramsByKind[kind].safeParse(envelope.data.params)
  if (!parsed.success) {
    throw new JobError(
      'INPUT_INVALID',
      `INPUT_INVALID JOB_START ${kind} params: ${parsed.error.message}`,
      false
    )
  }
  return { kind, params: parsed.data as JobParams[JobKind] }
}
