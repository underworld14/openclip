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

import type {
  AIProvider,
  CaptionStyle,
  ClipSchema,
  ClipStyle,
  DetectedClip,
  TargetPlatform,
  Transcript,
  TranscriptSegment,
  WordTimestamp
} from './schema'

/**
 * The clip-detection result, plus any NON-FATAL problems worth telling the user
 * about (BUG-yq6qbw).
 *
 * `warnings` deliberately lives HERE and not on `ClipSchema`: that schema is a
 * `z.strictObject` handed to the provider as its structured-output JSON Schema,
 * so adding a field would change what OpenAI/Anthropic/Ollama are asked to
 * produce. This wrapper is the app's own channel, invisible to the model.
 *
 * The case it exists for: a long podcast is analysed in chunks, one chunk is
 * refused or truncated, and the run still succeeds with fewer clips. That used
 * to be indistinguishable from "the AI found nothing there".
 */
export interface GenerateClipsResult extends ClipSchema {
  warnings?: string[]
}

// ============================================================================
// Job taxonomy
// ============================================================================

/**
 * The MVP long-job kinds (PRD §10.2). `url-download` is the additive UX-revamp
 * job (F.4): stream a remote video (YouTube/URL) to disk via the bundled yt-dlp,
 * emitting byte/percent progress; the renderer then feeds the merged file into
 * the existing import→extract→transcribe pipeline.
 */
export type JobKind =
  | 'transcribe'
  | 'export'
  | 'model-download'
  | 'url-download'
  /**
   * BYOK clip detection (EPIC-zpa1nd / FEAT-c0zn3j). This was the one long
   * operation that never made it onto the job plane: `ai:generate-clips` was a
   * plain `invoke` running one repair-laddered LLM call per transcript chunk,
   * strictly sequentially, with no progress, no cancel and no timeout. A slow
   * or wedged provider meant a frozen button for minutes with no escape but
   * quitting — reproduced against a real OpenRouter model that never returned.
   * As a job it inherits the MessagePort progress/cancel plane and the
   * "always terminates done xor error" invariant for free.
   */
  | 'generate-clips'

/** Typed terminal-error codes streamed in `{t:'error'}` (PRD §10.2). */
export type JobErrorCode =
  | 'CANCELLED'
  | 'SIDECAR_CRASH'
  | 'INPUT_INVALID'
  | 'OUT_OF_MEMORY'
  | 'API_AUTH'
  | 'API_RATE_LIMIT'
  | 'TIMEOUT'

/**
 * A CLASSIFIED job failure a runner (or the services it calls) can throw so the
 * sidecar maps the right `{code, retriable}` to the terminal `error` event instead
 * of bucketing everything as a retriable `SIDECAR_CRASH` (audit fix openclip-1ly):
 * an invalid URL or a model that can't be verified is DETERMINISTIC — retrying can't
 * help — so it should surface as a non-retriable `INPUT_INVALID`. An unexpected throw
 * (no `JobError`) stays a retriable `SIDECAR_CRASH`.
 */
export class JobError extends Error {
  constructor(
    readonly code: JobErrorCode,
    message: string,
    readonly retriable: boolean
  ) {
    super(message)
    this.name = 'JobError'
  }
}

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
    /**
     * How a source that does not match `aspectRatio` is fitted (FEAT-bd87vz):
     * `fill` centre-crops (the historical behaviour), `letterbox` pads with black
     * bars, `blur` pads with a blurred copy of the frame.
     *
     * Optional so every existing caller and the contract fixtures stay valid;
     * absent ⇒ `fill`. Only `fill` composes with a reframe plan — there is no
     * crop left to move inside a letterboxed frame.
     */
    fitMode?: 'fill' | 'letterbox' | 'blur'
    /**
     * Manual reframe override — the crop window's left edge in absolute source
     * pixels (FEAT-kzej8t). Replaces the computed plan with a static crop there
     * AND skips face detection, which is the slowest phase of an export.
     * Absent ⇒ the detector decides.
     */
    reframeCropX?: number
    /** Absolute path the user chose to write the final clip to. */
    outputPath: string
    /**
     * Encode on the CPU (libx264) instead of `h264_videotoolbox` (PRD §14).
     *
     * FROZEN-CONTRACT ADDITION (BUG-jt3d62 / FEAT-5hnsby). `Settings.forceCpu` has
     * existed since the schema was written and `codecArgs()` has always honoured
     * it, but there was no field to carry it from the renderer to the runner — so
     * the toggle was inert and a Mac without a usable VideoToolbox session had no
     * way out of a failing export. It is optional, so every existing caller and
     * the contract fixtures stay valid; absent ⇒ hardware encode, as before.
     *
     * The runner ALSO sets this itself when a hardware encode fails with a
     * VideoToolbox session error, to retry on CPU — so it is both a user
     * preference and the mechanism of the automatic fallback.
     */
    forceCpu?: boolean
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
      /**
       * Part K — words to EMPHASIZE (keyword highlight). Usually the clip's
       * `Clip.keywords`. The runner threads these to `buildAss(opts.keywords)`
       * which recolors/scales matching words; absent ⇒ no emphasis (byte-compat).
       */
      keywords?: string[]
      /**
       * Part K (emoji) — BYOK-AI emoji map (normalized word → emoji), produced by
       * ENHANCE_CAPTIONS (mode:'emoji') and threaded to `buildAss(opts.aiEmojiMap)`.
       * Used only when `style.autoEmoji === 'ai'`; absent ⇒ the local dictionary.
       */
      aiEmojiMap?: Record<string, string>
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
    /**
     * Part K (brand kit) — burn a logo overlay. `logoPath` is an absolute path to
     * a PNG-with-alpha; the runner inserts an `overlay` filter AFTER crop+scale and
     * BEFORE the caption `subtitles` burn. ALL OPTIONAL: absent `logoPath` ⇒ NO
     * overlay node and the export argv is byte-identical to today. `logoScale` is
     * the logo width as a fraction of the output width (default 0.18); `logoMargin`
     * the inset in output px (default 48); `logoPosition` default 'bottom-right'.
     */
    logoPath?: string
    logoPosition?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
    logoScale?: number
    logoMargin?: number
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
  /**
   * BYOK clip detection over the transcript (PRD §7.2/§16). SEGMENT-LEVEL TEXT
   * ONLY — the word stream never leaves the machine, and the video never does
   * either. The API key is NOT here and never crosses IPC: the runner decrypts
   * it main-side from the key vault (PRD §12.2).
   *
   * `channels.ts` aliases its `GenerateClipsRequest` to this type, so the
   * legacy invoke channel and the job cannot drift apart. It lives HERE rather
   * than there because channels.ts imports from jobs.ts and not the reverse.
   */
  'generate-clips': {
    projectId: string
    provider: AIProvider
    model: string
    /** Segment-level only — word data stays local (PRD §16). */
    segments: Transcript['segments']
    videoTitle: string
    durationSeconds: number
    clipStyle: ClipStyle
    numClips: number
    targetPlatform: TargetPlatform
    /**
     * Clip-length bounds in seconds (audit fix openclip-t0v). When present they
     * drive the prompt's "each clip must be between X and Y seconds" line AND
     * the in-code clamp; the renderer populates them from project settings so a
     * user's min/max duration is honoured instead of a hard-coded 15/90.
     */
    minDuration?: number
    maxDuration?: number
    /**
     * Analyse only this span of the source (FEAT-n762y6). The renderer slices
     * `segments` to it before sending, so this field is carried for the PROMPT
     * and the cache key — the model is told which window it is looking at, and
     * two runs over different windows of one transcript don't collide.
     *
     * Absent ⇒ the whole video. Without it a 3-hour stream had to be sent whole,
     * on a key the user pays for, to ask about ten minutes of it.
     */
    range?: { start: number; end: number }
    /**
     * Keyword targeting (FEAT-n762y6) — spans mentioning these are favoured.
     * UNTRUSTED user text: fenced in the prompt like the title and transcript.
     */
    keywords?: string[]
    /**
     * Free-text targeting ("find the parts about pricing"). Also UNTRUSTED and
     * also fenced — it is the user's own text, but the fencing that protects the
     * transcript costs nothing here and keeps one rule for all injected data.
     */
    customPrompt?: string
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
  /**
   * The AUTHORITATIVE clip set: repaired, reconciled, clamped to the source
   * duration and the user's min/max, de-overlapped and ranked to `numClips`.
   * Identical to what the `ai:generate-clips` invoke returns — the two entry
   * points share one `runGenerate` core.
   *
   * `warnings` carries NON-FATAL problems (BUG-yq6qbw): a long transcript is
   * analysed in chunks, and one chunk failing used to leave a successful-looking
   * run with fewer clips and no signal at all. It rides here rather than on
   * `ClipSchema` because that schema is the strict JSON Schema handed to the
   * provider — adding a field would change what the model is asked to produce.
   */
  'generate-clips': GenerateClipsResult
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
  /**
   * One chunk's surviving candidates, emitted as map-reduce walks the
   * transcript, so cards stream in instead of all appearing at the end.
   *
   * PROVISIONAL, and the renderer must treat them as such: these clips are
   * reconciled but NOT yet de-overlapped across chunks, ranked, or clamped to
   * `numClips` — that only happens in the reduce step. Append them for preview
   * if you like, but REPLACE the whole list with the `done` result, which is
   * the authoritative set. Accumulating partials as final would surface
   * cross-chunk duplicates.
   */
  'generate-clips': {
    clips: DetectedClip[]
    /** 0-based. */
    chunkIndex: number
    chunkCount: number
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
