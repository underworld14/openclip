/**
 * import-pipeline — the pure, headless heart of the I1 vertical slice (T-Media,
 * E.3): import → audio extract → transcribe. Kept in its own module (not the
 * component file) so ImportPanel.tsx only exports a component (react-refresh
 * boundary) and so the whole slice is unit-testable against the mock bridge +
 * fake-port harness without a DOM (tests/unit/import-pipeline.spec.ts).
 */

import type { SourceVideo } from '@shared/schema'
import type { JobResult, JobPartial, WhisperModelSize } from '@shared/jobs'
import type { TaskDetail } from '@renderer/components/jobStatus'
import { drainJob } from '@renderer/hooks/useJob'

/**
 * Extra numbers a stage can report alongside its percentage — bytes for a
 * download, and so on. Threaded through rather than discarded (FEAT-8559h1):
 * `runUrlDownload` used to collapse a `{downloadedBytes,totalBytes,pct}` partial
 * down to the percent alone, so the UI could never say "12 MB of 140 MB" about a
 * download whose byte counts it already had.
 */
export type ProgressDetail = TaskDetail

/**
 * The frozen bridge surface, derived from the global `window.openclip` typing
 * (preload/index.d.ts) — so the renderer never imports preload internals (the
 * `import/no-restricted-paths` boundary, E.7).
 */
export type OpenClipBridge = typeof window.openclip

export interface ImportPipelineOptions {
  bridge: OpenClipBridge
  filePath: string
  projectId: string
  model: WhisperModelSize
  language?: string
  /** 0..100 progress across the whole pipeline + the current stage label. */
  onProgress?: (pct: number, stage: string, detail?: ProgressDetail) => void
  /**
   * The probed source video, as soon as ffprobe returns and BEFORE the
   * minutes-long extract + transcribe (FEAT-ky1jfw). AWAITED, so a caller can
   * commit the project — and flush-save the outgoing one — before this pipeline
   * starts writing transcript partials into the store.
   *
   * This callback is why the editor can appear a second into an import instead
   * of at the end of it: the app has everything it needs to show the video the
   * moment the probe lands, and used to sit on it until transcription finished.
   */
  onProbed?: (sourceVideo: SourceVideo) => void | Promise<void>
  /** Live transcript partials as whisper decodes (PRD §6.2 sidebar). */
  onPartial?: (partial: JobPartial['transcribe']) => void
  /** The finalized transcript (the transcribe `done` result). */
  onTranscript?: (transcript: JobResult['transcribe']) => void
  /** The transcribe jobId, right after start, so the caller can cancel it (openclip-2bm). */
  onStart?: (jobId: string) => void
  /**
   * The extract-audio jobId, right after start (EPIC-k83ghw / BUG-sg6kqg) — so
   * Cancel works during "Extracting audio" too, not just "Transcribing".
   */
  onExtractStart?: (jobId: string) => void
}

export interface ImportPipelineResult {
  sourceVideo: SourceVideo
  wavPath: string
  transcript: JobResult['transcribe']
}

/**
 * Run the I1 slice. Throws on a terminal `error` job event (never hangs: every
 * job ends done|error by contract). Progress is reported across three coarse
 * stages — probe (→10%), extract (→25%), transcribe (25→100%, scaled).
 */
export async function runImportPipeline(
  opts: ImportPipelineOptions
): Promise<ImportPipelineResult> {
  const { bridge, filePath, projectId, model, language } = opts
  const report = (pct: number, stage: string, detail?: ProgressDetail): void =>
    opts.onProgress?.(pct, stage, detail)

  // 1) Import / probe → SourceVideo metadata (PRD §6.1).
  report(2, 'probing')
  const { sourceVideo } = await bridge.video.import({ filePath })
  report(10, 'probing')
  // Hand the probe to the caller and WAIT: it commits the project here, so the
  // transcript partials below stream into a project the user can already see.
  await opts.onProbed?.(sourceVideo)

  // 2) Extract 16kHz mono WAV (PRD §6.1) — a streaming job (EPIC-k83ghw /
  // BUG-sg6kqg), not a plain invoke: real ffmpeg progress and a jobId Cancel
  // can actually reach, instead of a frozen bar and a silent-no-op Cancel on
  // a multi-hour source.
  report(12, 'extracting')
  const { wavPath } = await drainJob(
    bridge,
    'extract-audio',
    { projectId, sourcePath: filePath },
    {
      onStart: opts.onExtractStart,
      // Scale the extraction stage into the 12..25 progress band.
      onProgress: (pct, stage) => report(12 + Math.round((pct / 100) * 13), stage)
    }
  )
  report(25, 'extracting')

  // 3) Transcribe — streaming job over a per-job MessagePort (PRD §6.2/§10.2).
  // start() resolves { jobId }; the live port is acquired out-of-band by jobId.
  const transcript = await drainJob(
    bridge,
    'transcribe',
    { projectId, wavPath, model, language },
    {
      onStart: opts.onStart,
      // Scale the transcribe stage into the 25..100 progress band.
      onProgress: (pct, stage) => report(25 + Math.round((pct / 100) * 75), stage),
      onPartial: (data) => opts.onPartial?.(data)
    }
  )
  opts.onTranscript?.(transcript)
  report(100, 'done')
  return { sourceVideo, wavPath, transcript }
}

/**
 * A pasted bare domain, no scheme — e.g. "youtube.com/watch?v=…" (EPIC-k83ghw /
 * BUG-aryvgg). Requires an explicit "dotted-hostname/path" shape: a bare
 * filename like "my.video.mp4" has no trailing "/…" and correctly fails this;
 * a filesystem path starts with "/" (macOS/Linux) or a drive letter + ":"
 * (Windows), neither of which matches a leading hostname. The rare false
 * positive this admits — a RELATIVE local path whose first segment happens to
 * contain a dot, e.g. "my.folder/video.mp4" — is not a realistic paste target
 * for this field (real local paths from Finder/Explorer are always absolute).
 */
const BARE_DOMAIN_URL = /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/\S+$/i

/**
 * True for an http(s) URL, OR a bare domain that is unambiguously a URL (see
 * `BARE_DOMAIN_URL`) — used by the unified smart-import field (F.4) to decide
 * the "Download" vs "Import" label and route to `importUrl`/`importFile`.
 */
export function isUrl(value: string): boolean {
  const v = value.trim()
  return /^https?:\/\//i.test(v) || BARE_DOMAIN_URL.test(v)
}

/**
 * Add a scheme to a bare-domain URL so it reaches yt-dlp / the main-process
 * job validator in a shape they accept (both require `http(s)://`, BUG-aryvgg)
 * — `isUrl` above ALREADY decided this is a URL; this only fills in the part
 * the user didn't type. A value that already has a scheme, or isn't a URL at
 * all, passes through unchanged.
 */
export function normalizeUrlInput(value: string): string {
  const v = value.trim()
  if (/^https?:\/\//i.test(v)) return v
  return BARE_DOMAIN_URL.test(v) ? `https://${v}` : v
}

/** Soft extension check for a dropped file — advisory only; ffprobe is the real authority. */
const DROPPABLE_VIDEO_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v']

export interface DroppedFileResolution {
  /** Absolute path, or null when the dropped item has no file on disk. */
  path: string | null
  /** Set for a soft, non-blocking concern — surface it, but still import. */
  warning?: string
}

/**
 * Resolve a dropped `File` to an absolute path (EPIC-k83ghw / BUG-aryvgg).
 * Shared between `ImportPanel`'s own drop zone and the window-wide drop target
 * in `App.tsx` so the two surfaces cannot drift on what counts as "looks like a
 * video" or how a path-less drop (e.g. dragged web content) is worded.
 *
 * Electron removed `File.path`; `getPathForFile` is the preload `files.getPathForFile`.
 */
export function resolveDroppedFile(
  file: File,
  getPathForFile: (file: File) => string
): DroppedFileResolution {
  const path = getPathForFile(file)
  if (!path) {
    return { path: null, warning: 'That item has no file on disk — try the file picker instead.' }
  }
  const lower = path.toLowerCase()
  if (!DROPPABLE_VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    // A soft warning, not a hard block: ffprobe is the real authority on what
    // is decodable, and this list can only ever be an approximation.
    return { path, warning: `“${file.name}” doesn't look like a video file. Importing anyway…` }
  }
  return { path }
}

export interface UrlDownloadOptions {
  bridge: OpenClipBridge
  url: string
  /** 0..100 download progress, the stage label, and the byte counts. */
  onProgress?: (pct: number, stage: string, detail?: ProgressDetail) => void
  /** The url-download jobId, right after start, so the caller can cancel it (openclip-2bm). */
  onStart?: (jobId: string) => void
}

/**
 * Download a remote/YouTube URL via the `url-download` streaming job (yt-dlp in
 * the main process), reusing the proven per-job MessagePort path (F.4). Resolves
 * the local file path of the downloaded+merged mp4. Throws on a terminal error
 * (never hangs) so the caller can surface a retriable toast.
 */
export async function runUrlDownload(opts: UrlDownloadOptions): Promise<JobResult['url-download']> {
  const result = await drainJob(
    opts.bridge,
    'url-download',
    { url: opts.url },
    {
      onStart: opts.onStart,
      onProgress: (pct, stage) => opts.onProgress?.(pct, stage),
      // Forward the byte counts instead of dropping them on the floor: yt-dlp
      // reports them, the runner parses them, and the UI wants to show
      // "12 MB of 140 MB · 2.1 MB/s" (FEAT-8559h1).
      onPartial: (data) =>
        opts.onProgress?.(data.pct, 'downloading', {
          receivedBytes: data.downloadedBytes,
          totalBytes: data.totalBytes
        })
    }
  )
  opts.onProgress?.(100, 'downloaded')
  return result
}
