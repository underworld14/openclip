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
  ClipStyle,
  ClipSchema,
  SourceVideo,
  Transcript
} from './schema'
import type { WhisperModelSize, JobKind, JobParams } from './jobs'

// ============================================================================
// IPCChannels — verbatim from PRD §10.1
// ============================================================================

export enum IPCChannels {
  IMPORT_VIDEO = 'video:import',
  IMPORT_FROM_URL = 'video:import:url',
  AUDIO_EXTRACT = 'audio:extract',
  GENERATE_CLIPS = 'ai:generate-clips',
  GENERATE_TITLES = 'ai:generate-titles',
  ENHANCE_CAPTIONS = 'ai:enhance-captions',
  EXPORT_CLIP = 'video:export',
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
  CHECK_UPDATE = 'system:check-update'
}

// ============================================================================
// Supporting request/response payload shapes (control-plane only)
// ============================================================================

/** Imported-video result: probed metadata used to seed a Project (PRD §6.1). */
export interface ImportVideoResult {
  sourceVideo: SourceVideo
}

/** AI clip-generation request: segment-level transcript + style knobs (PRD §6.3/§16). */
export interface GenerateClipsRequest {
  projectId: string
  provider: AIProvider
  model: string
  segments: Transcript['segments'] // segment-level only (word data stays local)
  videoTitle: string
  durationSeconds: number
  clipStyle: ClipStyle
  numClips: number
  targetPlatform: 'tiktok' | 'youtube' | 'instagram' | 'all'
}

/** AI title/hook generation (PRD §7.4). */
export interface GenerateTitlesRequest {
  provider: AIProvider
  model: string
  clipTranscript: string
}
export interface TitleOption {
  title: string
  hook: string
  psychology: string
}
export interface GenerateTitlesResult {
  options: TitleOption[]
}

/** AI caption enhancement (PRD §7.5). */
export interface EnhanceCaptionsRequest {
  provider: AIProvider
  model: string
  transcript: string
}
export interface EnhancedCaption {
  start_time: number
  end_time: number
  text: string
}
export interface EnhanceCaptionsResult {
  enhanced_captions: EnhancedCaption[]
}

/** Per-provider key status — value never crosses IPC (plan Part B / PRD §12.2). */
export interface ApiKeyStatus {
  provider: AIProvider
  hasKey: boolean
  last4?: string
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
  [IPCChannels.IMPORT_FROM_URL]: ChannelPayload<
    { url: string; consentAccepted: boolean },
    ImportVideoResult
  >
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
  // auto-creates `window.openclip.system.openDialog`. `properties` is a string
  // union (kept free of `Electron.*` types so the SHARED tsconfig stays Electron-
  // agnostic); it maps 1:1 onto Electron's OpenDialogOptions.properties.
  [IPCChannels.SHOW_OPEN_DIALOG]: ChannelPayload<
    {
      filters?: Array<{ name: string; extensions: string[] }>
      properties?: Array<'openFile' | 'openDirectory' | 'multiSelections'>
    },
    { canceled: boolean; filePaths: string[] }
  >
  [IPCChannels.CHECK_UPDATE]: ChannelPayload<void, UpdateStatus>
}

// ============================================================================
// Convenience extractors (used by the derived preload bridge type)
// ============================================================================

/** Channels modeled in ChannelMap as plain request/response invoke calls. */
export type InvokeChannel = keyof ChannelMap

export type ChannelReq<C extends InvokeChannel> = ChannelMap[C]['req']
export type ChannelRes<C extends InvokeChannel> = ChannelMap[C]['res']
