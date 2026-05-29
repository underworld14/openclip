/**
 * src/shared/jobs.ts — the streaming-job contract (PRD §10.2 + plan Part B/E).
 *
 * FROZEN as part of the OUTER contract (plan E.2, tag `contracts-outer`). The
 * `transcribe` result/partial payloads — provisional through Stage 3 — are now
 * FINALIZED against real `whisper-cli` JSON and frozen at `contracts-v1`.
 *
 * Long-running work (transcription, export, model download) runs in the
 * sidecar `utilityProcess`; control is `invoke('job:start', …)` which returns
 * `{ jobId }` ONLY, and every emitted event streams over a per-job MessagePort
 * as the `JobEvent` discriminated union below. `invoke('job:cancel', jobId)`
 * stays request/response so cancel can't be starved by a busy port.
 *
 * PORT DELIVERY (Electron 41, contextIsolation-safe — see preload/api/jobs.ts):
 * a `MessagePort` is a transferable that CANNOT be returned across
 * `contextBridge.exposeInMainWorld` (the bridge structure-clones+freezes return
 * values, yielding a dead plain Object). It also cannot ride `ipcRenderer.invoke`.
 * So the port is delivered OUT-OF-BAND: main creates a `MessageChannelMain`,
 * keeps `port1` (the emitter side fed by the sidecar runner) and TRANSFERS
 * `port2` to the renderer via `event.senderFrame.postMessage(JOB_PORT,{jobId},
 * [port2])`. The preload receives it (`ipcRenderer.on(JOB_PORT, e=>e.ports[0])`)
 * and forwards the LIVE port into the renderer's MAIN world with
 * `window.postMessage(…, [port])` (the supported isolated→main world transfer).
 * `jobs.start()` therefore resolves `{ jobId }` only; the renderer pairs the
 * incoming live port to the jobId (see renderer hooks/jobPort.ts) before driving
 * `jobEvents`.
 *
 * INVARIANT (PRD §10.2 / plan E.7 Gate C): every job ALWAYS terminates with a
 * `done` or `error` event — never a silent hang. Cooperative cancel: main
 * aborts + SIGKILLs the sidecar child, then emits {t:'error',code:'CANCELLED'}.
 * A renderer crash (port close) is treated as an implicit cancel.
 */

import type { CaptionStyle, Transcript, TranscriptSegment, WordTimestamp } from './schema'

// ============================================================================
// Job taxonomy
// ============================================================================

/**
 * The MVP long-job kinds (PRD §10.2). `url-download` is the additive UX-revamp
 * job (F.4): stream a remote video (YouTube/URL) to disk via the bundled yt-dlp,
 * emitting byte/percent progress; the renderer then feeds the merged file into
 * the existing import→extract→transcribe pipeline.
 */
export type JobKind = 'transcribe' | 'export' | 'model-download' | 'url-download'

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
    /**
     * Path to an ALREADY-generated .ass file to burn (libass). Usually left
     * undefined: the renderer cannot write files, so it passes `captions`
     * instead and the export runner GENERATES the .ass into the per-job temp dir
     * (PRD §17) before threading the resulting path here. A caller that already
     * has an .ass on disk may set this directly (it takes precedence).
     */
    assPath?: string
    /**
     * Karaoke caption inputs (PRD §6.4). When present (and `assPath` is not), the
     * export runner builds a word-level karaoke `.ass` from these and burns it in
     * the SAME re-encode (`crop,scale,subtitles=…:fontsdir=…`, fix M3). `words`
     * are the project transcript words (ABSOLUTE seconds); the runner scopes +
     * rebases them to the clip's resolved bounds.
     */
    captions?: {
      words: WordTimestamp[]
      style?: CaptionStyle
    }
    /**
     * Silence/filler jump-cuts (Part I.4, opt-in). When set, the export runner
     * detects silences in the clip span, computes the spans to keep, cuts them
     * into one continuous timeline (select+setpts), and remaps the burned
     * captions onto the compressed timeline. Absent/false ⇒ the normal single cut.
     */
    removeSilence?: boolean | { noiseDb?: number; minSilenceSec?: number; padSec?: number }
    /**
     * Auto-reframe (Part J, opt-in). 'off' (default) ⇒ static center-crop;
     * 'auto' ⇒ follow the speaker's face (static/pan, 1–2 speakers); 'split' ⇒
     * 2-speaker split-screen (falls back to 'auto' when not two faces). The runner
     * runs on-device face detection (YuNet via WASM) → a ReframePlan; any failure
     * degrades to center-crop (never blocks the export).
     */
    reframe?: 'off' | 'auto' | 'split'
    /**
     * Source video pixel size (from `Project.sourceVideo`), supplied by the renderer
     * so the reframe face-detection step needn't re-ffprobe — REQUIRED when reframe
     * != off (absent ⇒ reframe is skipped → center-crop). `fps` is informational
     * (the detector samples at its own fixed rate); kept for future tuning.
     */
    sourceResolution?: { width: number; height: number }
    fps?: number
    quality: '720p' | '1080p'
  }
  /** Stream a GGML model from HuggingFace to userData/models (PRD §13). */
  'model-download': {
    model: WhisperModelSize
  }
  /**
   * Download a remote video (YouTube/URL) to disk via the bundled yt-dlp (F.4).
   * The output dir is derived server-side from the jobId (never renderer-supplied
   * — G.2 trust boundary); the merged mp4 path is returned in the `done` result
   * for the renderer to feed into the import pipeline.
   */
  'url-download': {
    url: string
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
  'url-download': {
    /** Absolute path to the downloaded (merged) video file. */
    filePath: string
    /** Best-effort title parsed from yt-dlp metadata (may be absent). */
    title?: string
    /** Final on-disk size of the downloaded file. */
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
  /**
   * yt-dlp `--newline` progress (F.4): each `[download]  xx.x% of ~yyMiB` line
   * is parsed to a byte count + percent. `totalBytes` may be approximate (`~`)
   * while yt-dlp is still resolving the size; `pct` is 0..100.
   */
  'url-download': {
    downloadedBytes: number
    totalBytes: number
    pct: number
  }
}

// ============================================================================
// JobsAPI — the renderer-facing surface (PRD §10.2)
// ============================================================================

export interface JobsAPI {
  /**
   * Start a long job. Resolves with the assigned `jobId` ONLY. The per-job
   * `MessagePort` over which `JobEventFor<K>` events stream until a terminal
   * done|error is delivered OUT-OF-BAND (it cannot cross the contextBridge as a
   * return value — see the module header). The renderer acquires the live port
   * keyed by this `jobId` via `acquireJobPort(jobId)` (renderer hooks/jobPort.ts).
   */
  start<K extends JobKind>(kind: K, params: JobParams[K]): Promise<{ jobId: string }>
  /** Cooperatively cancel a running job; resolves once cancel is acknowledged. */
  cancel(jobId: string): Promise<void>
}
