/**
 * import-pipeline — the pure, headless heart of the I1 vertical slice (T-Media,
 * E.3): import → audio extract → transcribe. Kept in its own module (not the
 * component file) so ImportPanel.tsx only exports a component (react-refresh
 * boundary) and so the whole slice is unit-testable against the mock bridge +
 * fake-port harness without a DOM (tests/unit/import-pipeline.spec.ts).
 */

import type { SourceVideo } from '@shared/schema'
import type { JobResult, JobPartial, WhisperModelSize } from '@shared/jobs'
import { drainJob } from '@renderer/hooks/useJob'

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
  onProgress?: (pct: number, stage: string) => void
  /** Live transcript partials as whisper decodes (PRD §6.2 sidebar). */
  onPartial?: (partial: JobPartial['transcribe']) => void
  /** The finalized transcript (the transcribe `done` result). */
  onTranscript?: (transcript: JobResult['transcribe']) => void
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
  const report = (pct: number, stage: string): void => opts.onProgress?.(pct, stage)

  // 1) Import / probe → SourceVideo metadata (PRD §6.1).
  report(2, 'probing')
  const { sourceVideo } = await bridge.video.import({ filePath })
  report(10, 'probing')

  // 2) Extract 16kHz mono WAV (PRD §6.1).
  report(12, 'extracting')
  const { wavPath } = await bridge.audio.extract({ projectId, sourcePath: filePath })
  report(25, 'extracting')

  // 3) Transcribe — streaming job over a per-job MessagePort (PRD §6.2/§10.2).
  // start() resolves { jobId }; the live port is acquired out-of-band by jobId.
  const transcript = await drainJob(
    bridge,
    'transcribe',
    { projectId, wavPath, model, language },
    {
      // Scale the transcribe stage into the 25..100 progress band.
      onProgress: (pct, stage) => report(25 + Math.round((pct / 100) * 75), stage),
      onPartial: (data) => opts.onPartial?.(data)
    }
  )
  opts.onTranscript?.(transcript)
  report(100, 'done')
  return { sourceVideo, wavPath, transcript }
}

/** True for an http(s) URL (used by the unified smart-import field, F.4). */
export function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim())
}

export interface UrlDownloadOptions {
  bridge: OpenClipBridge
  url: string
  /** 0..100 download progress + stage label. */
  onProgress?: (pct: number, stage: string) => void
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
      onProgress: (pct, stage) => opts.onProgress?.(pct, stage),
      onPartial: (data) => opts.onProgress?.(data.pct, 'downloading')
    }
  )
  opts.onProgress?.(100, 'downloaded')
  return result
}
