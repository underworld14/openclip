/**
 * src/shared/channels.ts — the IPC control-plane contract (PRD §10.1).
 *
 * FROZEN as part of the OUTER contract (plan E.2, tag `contracts-outer`).
 *
 * `IPCChannels` is the exhaustive MVP channel enum from PRD §10.1. `ChannelMap`
 * associates every channel with its request/response TS types so the preload
 * bridge (`OpenClipBridge`) can be DERIVED — never hand-duplicated — via mapped
 * types over this map (see `src/preload/index.ts`).
 *
 * Semantics: these are all request/response (`ipcRenderer.invoke`). Long,
 * streaming work (transcribe/export/model-download) does NOT stream here — it
 * goes through `JOB_START`/`JOB_CANCEL` (see `jobs.ts`). `JOB_START` is now a
 * plain `invoke` returning `{ jobId }`; the per-job transferable `MessagePort`
 * is delivered OUT-OF-BAND over `JOB_PORT` (`event.senderFrame.postMessage`),
 * because a `MessagePort` can neither ride `invoke` nor survive being returned
 * across the contextBridge. `JobsAPI` (jobs.ts) models the renderer surface and
 * is exposed under `window.openclip.jobs`.
 */

import type {
  Project,
  Settings,
  AIProvider,
  ClipSchema,
  SourceVideo,
  BrandTemplate,
  // AI title/caption outputs — inferred from their z.strictObject schemas (openclip-xgk).
  GenerateTitlesResult,
  EnhanceCaptionsResult
} from './schema'

// Re-export the AI title/caption output types (openclip-xgk) so existing consumers that
// import them from '@shared/channels' keep working now that they're defined (with their
// Zod schemas) in schema.ts.
export type {
  TitleOption,
  GenerateTitlesResult,
  EnhancedCaption,
  EnhanceCaptionsResult
} from './schema'
import type { WhisperModelSize, JobKind, JobParams } from './jobs'

// ============================================================================
// IPCChannels — verbatim from PRD §10.1
// ============================================================================

export enum IPCChannels {
  IMPORT_VIDEO = 'video:import',
  // NOTE: URL/YouTube import is NOT a request/response channel — it's the
  // streaming `url-download` job (jobs.start('url-download', …), see jobs.ts).
  // The old `video:import:url` channel was never handled; removed in G.7.
  AUDIO_EXTRACT = 'audio:extract',
  GENERATE_CLIPS = 'ai:generate-clips',
  GENERATE_TITLES = 'ai:generate-titles',
  ENHANCE_CAPTIONS = 'ai:enhance-captions',
  /** List a provider's available models (OpenRouter, Part H) → `ai.listModels`. */
  AI_LIST_MODELS = 'ai:list-models',
  /**
   * One cheap real round-trip against the configured provider+model+key, so a
   * misconfiguration is caught in Settings rather than after the user has waited
   * through a full transcription (EPIC-xzzpty / FEAT-6v92dk).
   */
  AI_TEST_CONNECTION = 'ai:test-connection',
  EXPORT_CLIP = 'video:export',
  // Media: adopt a downloaded source file into <userData>/media/<projectId>/ so it
  // persists with the project + is deleted with it (Part H) → `media.adoptSource`.
  MEDIA_ADOPT_SOURCE = 'media:adopt-source',
  // Reclaim (delete) a project's adopted media dir immediately — used when an app-owned
  // import fails after adopt but before any .ocproj was saved (openclip-e5s) →
  // `media.reclaim`.
  MEDIA_RECLAIM = 'media:reclaim',
  // Brand kit (Part K) — the APP-LEVEL brand library persisted main-side under
  // <userData>/brands/<id>/ (mirrors media-store). list/save/delete + adopt a PNG
  // logo into the brand dir → `brand.list|save|delete|setLogo`.
  BRAND_LIST = 'brand:list',
  BRAND_SAVE = 'brand:save',
  BRAND_DELETE = 'brand:delete',
  BRAND_SET_LOGO = 'brand:set-logo',
  // Project
  SAVE_PROJECT = 'project:save',
  LOAD_PROJECT = 'project:load',
  LIST_PROJECTS = 'project:list',
  DELETE_PROJECT = 'project:delete',
  // Settings (raw API key value is NEVER returned to the renderer)
  GET_SETTINGS = 'settings:get',
  SET_SETTINGS = 'settings:set',
  GET_API_KEY_STATUS = 'settings:api-key-status',
  SET_API_KEY = 'settings:set-api-key',
  // Models
  MODEL_STATUS = 'model:status',
  MODEL_DOWNLOAD = 'model:download',
  /**
   * Delete an installed GGML model to reclaim disk (EPIC-xzzpty / FEAT-1k76hk).
   * Models are 75MB–2.9GB and were previously write-only: the app could download
   * them but never remove them, and never showed what they cost.
   */
  MODEL_DELETE = 'model:delete',
  // Long jobs: start (invoke) returns { jobId }; the per-job MessagePort is
  // transferred out-of-band over JOB_PORT (main → renderer). Cancel by id.
  JOB_START = 'job:start',
  JOB_CANCEL = 'job:cancel',
  /** Out-of-band per-job MessagePort delivery channel (main → renderer). */
  JOB_PORT = 'job:port',
  // System
  OPEN_FOLDER = 'system:open-folder',
  SHOW_SAVE_DIALOG = 'system:save-dialog',
  SHOW_OPEN_DIALOG = 'system:open-dialog',
  // Part K — pick an output FOLDER for batch export (Step 4) and a PNG logo for
  // the brand kit (Step 5). Both hard-scoped server-side (least-privilege, G.7):
  // directory picker / single-PNG picker; the renderer cannot widen them.
  SHOW_DIRECTORY_DIALOG = 'system:directory-dialog',
  SHOW_IMAGE_DIALOG = 'system:image-dialog',
  CHECK_UPDATE = 'system:check-update',
  /**
   * Native completion notification + dock badge (EPIC-zpa1nd / FEAT-ckxz8d).
   *
   * A transcription or a batch export runs for minutes; the desktop-native
   * equivalent of OpusClip's "we'll email you" is telling the OS. Suppressed
   * MAIN-SIDE when the window is already focused — notifying someone who is
   * watching the progress bar is just noise.
   */
  SYSTEM_NOTIFY = 'system:notify',
  /**
   * Report which sidecar binaries actually resolved (EPIC-xzzpty / FEAT-c5a15c).
   * `utils/paths.ts` has always resolved ffmpeg/ffprobe/whisper-cli/yt-dlp — it
   * just never told the renderer, so a missing binary surfaced as a raw spawn
   * error mid-import instead of a red chip before the user started.
   */
  SYSTEM_PREFLIGHT = 'system:preflight',
  // Quit-time autosave durability (openclip-49y). FLUSH_BEFORE_QUIT is a ONE-WAY
  // main→renderer signal (forwarded as a window message like JOB_PORT, NOT in ChannelMap)
  // sent from `before-quit`. It uses the `lifecycle:` prefix DELIBERATELY (not `system:`)
  // so `buildNamespace('system')` — which derives a bridge method per matching enum value —
  // does NOT auto-expose it as an invoke (it isn't one). The renderer flushes its pending
  // debounced save and then calls `system.autosaveFlushed()` (the AUTOSAVE_FLUSHED invoke
  // below) so main can quit as soon as the save lands instead of racing renderer teardown.
  FLUSH_BEFORE_QUIT = 'lifecycle:flush-before-quit',
  AUTOSAVE_FLUSHED = 'system:autosave-flushed'
}

// ============================================================================
// Supporting request/response payload shapes (control-plane only)
// ============================================================================

/** Imported-video result: probed metadata used to seed a Project (PRD §6.1). */
export interface ImportVideoResult {
  sourceVideo: SourceVideo
}

/** AI clip-generation request: segment-level transcript + style knobs (PRD §6.3/§16). */
/**
 * Clip-detection request. DEFINED IN `jobs.ts` and aliased here (EPIC-zpa1nd):
 * clip generation now also runs as the `generate-clips` streaming job, so this
 * channel and that job carry the SAME payload by construction rather than by
 * two hand-maintained copies that would drift on the next field.
 *
 * The direction is forced: `channels.ts` already imports from `jobs.ts`, so the
 * shared shape has to live there to avoid a cycle.
 */
export type GenerateClipsRequest = JobParams['generate-clips']

/** AI title/hook generation (PRD §7.4). */
export interface GenerateTitlesRequest {
  provider: AIProvider
  model: string
  clipTranscript: string
}
// TitleOption + GenerateTitlesResult are inferred from their z.strictObject schemas in
// schema.ts (openclip-xgk) and imported above.

/** AI caption enhancement (PRD §7.5). */
export interface EnhanceCaptionsRequest {
  provider: AIProvider
  model: string
  transcript: string
  /**
   * Part K (emoji) — selects the enhancement. Absent/'rewrite' ⇒ the original
   * caption-rewrite behavior; 'emoji' ⇒ suggest a per-word emoji map from `words`.
   */
  mode?: 'rewrite' | 'emoji'
  /** Part K (emoji) — distinct caption words to suggest emoji for (mode:'emoji'). */
  words?: string[]
}
// EnhancedCaption + EnhanceCaptionsResult are inferred from their z.strictObject schemas
// in schema.ts (openclip-xgk; emoji_map is the Part K word→emoji dictionary) and imported
// above.

/** Per-provider key status — value never crosses IPC (plan Part B / PRD §12.2). */
export interface ApiKeyStatus {
  provider: AIProvider
  hasKey: boolean
  last4?: string
}

/** Request a provider's model list (Part H — OpenRouter). */
export interface ListModelsRequest {
  provider: AIProvider
  /** Bypass the in-memory TTL cache and re-fetch. */
  refresh?: boolean
}

/** One model option surfaced in the picker (Part H). */
export interface ModelInfo {
  id: string
  name: string
  contextLength?: number
  /** USD per 1M prompt / completion tokens (omitted when unknown/free). */
  pricePerMTokIn?: number
  pricePerMTokOut?: number
  /** Supports strict JSON (structured_outputs / response_format) — clip detection needs this. */
  supportsStructured: boolean
  /** In the curated recommended shortlist (pinned to the top of the list). */
  recommended: boolean
  description?: string
}

/** Provider model list, already ordered recommended-first (Part H). */
export interface ListModelsResult {
  provider: AIProvider
  models: ModelInfo[]
  fetchedAt: number // epoch ms
  fromCache: boolean
}

/** Result of deleting an installed GGML model (FEAT-1k76hk). */
export interface ModelDeleteResult {
  model: WhisperModelSize
  /** False when the model was not installed — deleting is idempotent, not an error. */
  deleted: boolean
  /** Bytes reclaimed (0 when it was not installed). */
  freedBytes: number
}

/** One cheap live round-trip against the configured provider (FEAT-6v92dk). */
export interface TestConnectionRequest {
  provider: AIProvider
  model: string
}

export interface TestConnectionResult {
  ok: boolean
  /** Human-readable, already mapped from the provider's raw error. */
  message: string
  latencyMs?: number
}

/** One resolved sidecar dependency (FEAT-c5a15c). */
export interface PreflightTool {
  ok: boolean
  /** Absolute path when resolved; omitted when missing. */
  path?: string
}

/**
 * Which sidecar binaries actually resolved. `utils/paths.ts` already resolves all
 * of these — this channel is purely about TELLING the renderer, so a missing
 * binary becomes a red chip before the user starts rather than a spawn error
 * mid-import.
 */
export interface PreflightResult {
  ffmpeg: PreflightTool
  ffprobe: PreflightTool
  whisperCli: PreflightTool
  ytDlp: PreflightTool
}

/** Whisper model presence on disk (PRD §13 / §10.1 model:status). */
export interface ModelStatus {
  model: WhisperModelSize
  installed: boolean
  path?: string
  bytes?: number
}

/** Update-check result (electron-updater, wired in v1.0 polish — PRD §4.1). */
export interface UpdateStatus {
  updateAvailable: boolean
  version?: string
}

/**
 * Result of starting a long job (mirrors `JobsAPI.start`). Carries the `jobId`
 * ONLY — the per-job `MessagePort` is delivered out-of-band over `JOB_PORT`
 * (it cannot ride `invoke` nor survive the contextBridge return path).
 */
export interface JobStartResult {
  jobId: string
}

// ============================================================================
// ChannelMap — each channel ↦ { req; res }
// ============================================================================

export interface ChannelPayload<Req, Res> {
  req: Req
  res: Res
}

export interface ChannelMap {
  // --- Video / media ---
  [IPCChannels.IMPORT_VIDEO]: ChannelPayload<{ filePath: string }, ImportVideoResult>
  [IPCChannels.AUDIO_EXTRACT]: ChannelPayload<
    { projectId: string; sourcePath: string },
    { wavPath: string }
  >
  [IPCChannels.EXPORT_CLIP]: ChannelPayload<
    { projectId: string; clipId: string; outputPath: string },
    { outputPath: string }
  >

  // --- AI (BYOK) ---
  [IPCChannels.GENERATE_CLIPS]: ChannelPayload<GenerateClipsRequest, ClipSchema>
  [IPCChannels.GENERATE_TITLES]: ChannelPayload<GenerateTitlesRequest, GenerateTitlesResult>
  [IPCChannels.ENHANCE_CAPTIONS]: ChannelPayload<EnhanceCaptionsRequest, EnhanceCaptionsResult>
  [IPCChannels.AI_LIST_MODELS]: ChannelPayload<ListModelsRequest, ListModelsResult>
  [IPCChannels.AI_TEST_CONNECTION]: ChannelPayload<TestConnectionRequest, TestConnectionResult>

  // --- Media ---
  [IPCChannels.MEDIA_ADOPT_SOURCE]: ChannelPayload<
    { projectId: string; filePath: string },
    { path: string }
  >
  [IPCChannels.MEDIA_RECLAIM]: ChannelPayload<{ projectId: string }, { reclaimed: boolean }>

  // --- Brand kit (Part K) — app-level brand library, persisted main-side ---
  [IPCChannels.BRAND_LIST]: ChannelPayload<void, BrandTemplate[]>
  [IPCChannels.BRAND_SAVE]: ChannelPayload<{ brand: BrandTemplate }, BrandTemplate>
  [IPCChannels.BRAND_DELETE]: ChannelPayload<{ id: string }, { deleted: boolean }>
  // Adopt a PNG logo into the brand's dir; returns the adopted in-library path.
  [IPCChannels.BRAND_SET_LOGO]: ChannelPayload<
    { id: string; srcPath: string },
    { logoPath: string }
  >

  // --- Project ---
  [IPCChannels.SAVE_PROJECT]: ChannelPayload<{ project: Project }, { path: string }>
  [IPCChannels.LOAD_PROJECT]: ChannelPayload<{ id: string }, Project>
  [IPCChannels.LIST_PROJECTS]: ChannelPayload<
    void,
    Array<{ id: string; name: string; updatedAt: number; path: string }>
  >
  [IPCChannels.DELETE_PROJECT]: ChannelPayload<{ id: string }, { deleted: boolean }>

  // --- Settings (raw key never returned) ---
  [IPCChannels.GET_SETTINGS]: ChannelPayload<void, Settings>
  [IPCChannels.SET_SETTINGS]: ChannelPayload<{ settings: Partial<Settings> }, Settings>
  [IPCChannels.GET_API_KEY_STATUS]: ChannelPayload<{ provider: AIProvider }, ApiKeyStatus>
  [IPCChannels.SET_API_KEY]: ChannelPayload<{ provider: AIProvider; key: string }, ApiKeyStatus>

  // --- Models ---
  [IPCChannels.MODEL_STATUS]: ChannelPayload<{ model?: WhisperModelSize }, ModelStatus[]>
  // MODEL_DOWNLOAD kicks off a streaming job; returns a job handle (port streams progress).
  [IPCChannels.MODEL_DOWNLOAD]: ChannelPayload<{ model: WhisperModelSize }, JobStartResult>
  [IPCChannels.MODEL_DELETE]: ChannelPayload<{ model: WhisperModelSize }, ModelDeleteResult>

  // --- Long jobs ---
  // start: invoke({kind,params}) → { jobId }. The per-job MessagePort streams
  // out-of-band over JOB_PORT (not modeled here — it carries a transferable).
  [IPCChannels.JOB_START]: ChannelPayload<
    { kind: JobKind; params: JobParams[JobKind] },
    JobStartResult
  >
  [IPCChannels.JOB_CANCEL]: ChannelPayload<{ jobId: string }, void>

  // --- System ---
  [IPCChannels.OPEN_FOLDER]: ChannelPayload<{ path: string }, void>
  [IPCChannels.SHOW_SAVE_DIALOG]: ChannelPayload<
    { defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> },
    { canceled: boolean; filePath?: string }
  >
  // Native open-file picker for the unified import (F.3). Mirrors SHOW_SAVE_DIALOG;
  // auto-creates `window.openclip.system.openDialog`. Takes NO inputs: the picker
  // is hard-scoped server-side to a single video file (G.7 least-privilege), so
  // the renderer cannot widen it (e.g. to a directory / all files).
  [IPCChannels.SHOW_OPEN_DIALOG]: ChannelPayload<
    Record<string, never>,
    { canceled: boolean; filePaths: string[] }
  >
  // Batch export (Step 4): choose ONE output folder; hard-scoped to a directory.
  [IPCChannels.SHOW_DIRECTORY_DIALOG]: ChannelPayload<
    Record<string, never>,
    { canceled: boolean; dirPath?: string }
  >
  // Brand kit (Step 5): pick a single PNG logo; hard-scoped to a PNG file.
  [IPCChannels.SHOW_IMAGE_DIALOG]: ChannelPayload<
    Record<string, never>,
    { canceled: boolean; filePaths: string[] }
  >
  [IPCChannels.CHECK_UPDATE]: ChannelPayload<void, UpdateStatus>
  // Fire-and-forget: `delivered` reports whether the OS was actually told, so a
  // caller can tell "suppressed because you're looking at it" from "sent".
  [IPCChannels.SYSTEM_NOTIFY]: ChannelPayload<
    { title: string; body: string },
    { delivered: boolean }
  >
  [IPCChannels.SYSTEM_PREFLIGHT]: ChannelPayload<void, PreflightResult>
  // Renderer→main ACK that the pending autosave was flushed at quit (openclip-49y) →
  // `system.autosaveFlushed()`. main resolves its before-quit wait and proceeds.
  [IPCChannels.AUTOSAVE_FLUSHED]: ChannelPayload<void, { ok: boolean }>
}

// ============================================================================
// Convenience extractors (used by the derived preload bridge type)
// ============================================================================

/** Channels modeled in ChannelMap as plain request/response invoke calls. */
export type InvokeChannel = keyof ChannelMap

export type ChannelReq<C extends InvokeChannel> = ChannelMap[C]['req']
export type ChannelRes<C extends InvokeChannel> = ChannelMap[C]['res']
