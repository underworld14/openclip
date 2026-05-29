/**
 * import-pipeline — the pure, headless heart of the I1 vertical slice (T-Media,
 * E.3): import → audio extract → transcribe. Kept in its own module (not the
 * component file) so ImportPanel.tsx only exports a component (react-refresh
 * boundary) and so the whole slice is unit-testable against the mock bridge +
 * fake-port harness without a DOM (tests/unit/import-pipeline.spec.ts).
 */

import type { SourceVideo } from '@shared/schema'
import type { JobResult, JobPartial, WhisperModelSize, JobEventFor } from '@shared/jobs'
import { jobEvents } from '@renderer/hooks/useJob'
import { acquireJobPort } from '@renderer/hooks/jobPort'

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
  const { jobId } = await bridge.jobs.start('transcribe', { projectId, wavPath, model, language })
  const port = await acquireJobPort(jobId)
  let transcript: JobResult['transcribe'] | null = null

  for await (const ev of jobEvents<'transcribe'>(port)) {
    const e = ev as JobEventFor<'transcribe'>
    switch (e.t) {
      case 'progress':
        // Scale the transcribe stage into the 25..100 band.
        report(25 + Math.round((e.pct / 100) * 75), e.stage)
        break
      case 'partial':
        opts.onPartial?.(e.data)
        break
      case 'done':
        transcript = e.result
        opts.onTranscript?.(e.result)
        report(100, 'done')
        break
      case 'error':
        throw new Error(`transcribe failed [${e.code}]: ${e.message}`)
    }
  }

  if (!transcript) throw new Error('transcribe ended without a result')
  return { sourceVideo, wavPath, transcript }
}
