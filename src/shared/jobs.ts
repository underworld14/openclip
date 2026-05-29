/**
 * src/shared/jobs.ts — the streaming-job contract (PRD §10.2 + plan Part B/E).
 *
 * FROZEN as part of the OUTER contract (plan E.2, tag `contracts-outer`). The
 * `transcribe` result/partial payloads — provisional through Stage 3 — are now
 * FINALIZED against real `whisper-cli` JSON and frozen at `contracts-v1`.
 *
 * Long-running work (transcription, export, model download) runs in the
 * sidecar `utilityProcess`; control is `invoke('job:start', …)` which returns
 * `{ jobId, port }`, and every emitted event streams over that per-job
 * MessagePort as the `JobEvent` discriminated union below. `invoke('job:cancel',
 * jobId)` stays request/response so cancel can't be starved by a busy port.
 *
 * INVARIANT (PRD §10.2 / plan E.7 Gate C): every job ALWAYS terminates with a
 * `done` or `error` event — never a silent hang. Cooperative cancel: main
 * aborts + SIGKILLs the sidecar child, then emits {t:'error',code:'CANCELLED'}.
 * A renderer crash (port close) is treated as an implicit cancel.
 */

import type { Transcript, TranscriptSegment, WordTimestamp } from './schema'

// ============================================================================
// Job taxonomy
// ============================================================================

/** The three MVP long-job kinds (PRD §10.2). */
export type JobKind = 'transcribe' | 'export' | 'model-download'

/** Typed terminal-error codes streamed in `{t:'error'}` (PRD §10.2). */
export type JobErrorCode =
  | 'CANCELLED'
  | 'SIDECAR_CRASH'
  | 'INPUT_INVALID'
  | 'OUT_OF_MEMORY'
  | 'API_AUTH'
  | 'API_RATE_LIMIT'
  | 'TIMEOUT'

// ============================================================================
// JobEvent<R> — one discriminated union streamed over the per-job MessagePort
// (PRD §10.2). `R` is the per-kind result type; `P` the per-kind partial type.
// ============================================================================

export type JobEvent<R = unknown, P = unknown> =
  | { t: 'progress'; pct: number; stage: string; etaMs?: number }
  | { t: 'partial'; data: P } // e.g. streamed transcript segments
  | { t: 'done'; result: R }
  | { t: 'error'; code: JobErrorCode; message: string; retriable: boolean }

/** The fully-typed event union for a specific job kind `K`. */
export type JobEventFor<K extends JobKind> = JobEvent<JobResult[K], JobPartial[K]>

// ============================================================================
// Per-kind START PARAMS — JobParams[K] (control-plane request payloads)
// ============================================================================

export type WhisperModelSize = 'tiny' | 'base' | 'small' | 'medium' | 'turbo' | 'large-v3'

export interface JobParams {
  /** Spawn whisper-cli over an extracted 16kHz WAV (PRD §6.2). */
  transcribe: {
    projectId: string
    /** Absolute path to the 16kHz mono WAV produced by audio extraction. */
    wavPath: string
    model: WhisperModelSize
    /** undefined => whisper auto-detect (PRD §6.2 multi-language). */
    language?: string
  }
  /** Frame-accurate cut + 9:16 reframe + (optional) caption burn (PRD §6.5/§6.9). */
  export: {
    projectId: string
    clipId: string
    sourcePath: string
    /** Effective bounds (post-trim) in absolute seconds. */
    startTime: number
    endTime: number
    aspectRatio: '9:16' | '1:1' | '4:5' | '16:9'
    /** Absolute path the user chose to write the final clip to. */
    outputPath: string
    /** Path to a generated .ass file to burn (libass), if captions are on. */
    assPath?: string
    quality: '720p' | '1080p'
  }
  /** Stream a GGML model from HuggingFace to userData/models (PRD §13). */
  'model-download': {
    model: WhisperModelSize
  }
}

// ============================================================================
// Per-kind RESULT — JobResult[K] (payload of the terminal `done` event)
// ============================================================================

export interface JobResult {
  // FINALIZED at `contracts-v1` (Stage-4 media smoke). The terminal transcript:
  // `language` from whisper `result.language`; `segments` grouped from the word
  // stream (LLM-facing, PRD §16); `words` kept local for karaoke captions. This
  // is exactly the `Transcript` body sans the v0.4 `speakers` field — so it
  // drops straight into `Project.transcript` (PRD §9.3).
  transcribe: Pick<Transcript, 'language' | 'segments' | 'words'>

  export: {
    outputPath: string
    width: number
    height: number
    durationMs: number
  }
  'model-download': {
    model: WhisperModelSize
    /** Absolute path to the downloaded ggml-<model>.bin. */
    path: string
    bytes: number
  }
}

// ============================================================================
// Per-kind PARTIAL — JobPartial[K] (payload of intermediate `partial` events)
// (critic fix B2: partials are per-kind typed, not a bare `unknown`.)
// ============================================================================

export interface JobPartial {
  // FINALIZED at `contracts-v1` (Stage-4 media smoke). whisper-cli prints each
  // word as it is decoded (one stderr line per `transcription[]` entry under
  // `-ml 1 --split-on-word`); the runner maps those to `words` and emits any
  // sentence that just CLOSED on terminal punctuation as `segments`. Both arrays
  // carry only what is NEW since the previous `partial` (absolute timestamps);
  // `segments` may be empty on word-only emits. The renderer appends them to
  // build a live transcript while progress streams (PRD §6.2 searchable sidebar).
  transcribe: {
    /** Words decoded since the previous partial (absolute timestamps). */
    words: WordTimestamp[]
    /** Sentences that closed since the previous partial (may be empty). */
    segments: TranscriptSegment[]
  }
  /** Export has no meaningful partial payload (progress-only). */
  export: never
  /** Download streams byte-count partials for resumable progress (PRD §13). */
  'model-download': {
    receivedBytes: number
    totalBytes: number
  }
}

// ============================================================================
// JobsAPI — the renderer-facing surface (PRD §10.2)
// ============================================================================

export interface JobsAPI {
  /**
   * Start a long job. Resolves with the job id and the per-job MessagePort
   * over which `JobEventFor<K>` events stream until a terminal done|error.
   */
  start<K extends JobKind>(
    kind: K,
    params: JobParams[K]
  ): Promise<{ jobId: string; port: MessagePort }>
  /** Cooperatively cancel a running job; resolves once cancel is acknowledged. */
  cancel(jobId: string): Promise<void>
}
