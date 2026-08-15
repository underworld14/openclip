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
import { AIProvider } from '@shared/schema'

const WHISPER_MODELS = ['tiny', 'base', 'small', 'medium', 'turbo', 'large-v3'] as const
const ASPECTS = ['9:16', '1:1', '4:5', '16:9'] as const
const nonEmpty = z.string().min(1)

/**
 * A projectId becomes ONE path segment under `<temp>/openclip/` (paths.ts), so a
 * separator or `..` here escapes the temp root entirely — `'../../../../victim'`
 * resolved to a directory outside it, which the export runner then created and
 * wrote captions into (BUG-e06a9d). It was only ever checked as "non-empty
 * string", while the media path had guarded the same value from day one.
 *
 * Rejecting here turns it into the typed, non-retriable INPUT_INVALID the
 * renderer already knows how to surface; `paths.assertSafeProjectId` is the
 * belt-and-braces guard at the construction site for any caller that bypasses
 * this boundary.
 */
const safeSegment = nonEmpty.refine(
  (v) => !/[\\/]/.test(v) && v !== '.' && v !== '..' && !v.includes('\0'),
  'must be a single path segment (no "/", "\\", "." or "..")'
)

/** Per-kind params validators — strict on the sensitive fields, loose on the rest. */
const paramsByKind = {
  transcribe: z.looseObject({
    projectId: safeSegment,
    wavPath: nonEmpty,
    model: z.enum(WHISPER_MODELS),
    language: z.string().optional()
  }),
  export: z.looseObject({
    projectId: safeSegment,
    clipId: nonEmpty,
    sourcePath: nonEmpty,
    outputPath: nonEmpty,
    startTime: z.number().finite(),
    endTime: z.number().finite(),
    aspectRatio: z.enum(ASPECTS),
    // Selects the ENCODER, so it is a spawn-affecting value: validate it here
    // rather than letting looseObject wave through a non-boolean (BUG-jt3d62).
    forceCpu: z.boolean().optional(),
    // Selects the FILTERGRAPH, for the same reason (FEAT-bd87vz). An unrecognised
    // value would fall through `fitChain`'s default to `fill` and silently
    // centre-crop — a wrong export rather than a rejected request.
    fitMode: z.enum(['fill', 'letterbox', 'blur']).optional()
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
    projectId: safeSegment,
    // Reuse the schema enum rather than re-listing the providers. A hand-copied
    // list compiles fine while silently rejecting every job for a newly added
    // provider — a runtime-only failure with no test to catch it (FEAT-bysdwg).
    provider: AIProvider,
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
