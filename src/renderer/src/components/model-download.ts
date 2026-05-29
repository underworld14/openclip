/**
 * model-download — the GGML model table + pure download orchestration for
 * ModelDownloadDialog (T-Media, E.3). Kept out of the component file so it only
 * exports a component (react-refresh boundary) and so the orchestration is
 * unit-testable against the mock bridge + fake-port harness.
 */

import type { JobResult, WhisperModelSize, JobEventFor } from '@shared/jobs'
import { jobEvents, type MessagePortLike } from '@renderer/hooks/useJob'

// ============================================================================
// Model table (PRD §6.2 GGML model selection + §13 download UX)
// ============================================================================

export interface WhisperModelRow {
  model: WhisperModelSize
  sizeLabel: string
  speed: string
  accuracy: string
  default?: boolean
}

export const WHISPER_MODEL_TABLE: WhisperModelRow[] = [
  { model: 'tiny', sizeLabel: '~75 MB', speed: '~10x', accuracy: 'Low' },
  { model: 'base', sizeLabel: '~140 MB', speed: '~7x', accuracy: 'Fair', default: true },
  { model: 'small', sizeLabel: '~460 MB', speed: '~4x', accuracy: 'Good' },
  { model: 'medium', sizeLabel: '~1.5 GB', speed: '~2x', accuracy: 'Better' },
  { model: 'turbo', sizeLabel: '~1.5 GB', speed: '~6x', accuracy: 'Near-large' },
  { model: 'large-v3', sizeLabel: '~2.9 GB', speed: '1x', accuracy: 'Best' }
]

/** The default whisper model (the MVP default — PRD §6.2). */
export const DEFAULT_WHISPER_MODEL: WhisperModelSize =
  WHISPER_MODEL_TABLE.find((m) => m.default)?.model ?? 'base'

// ============================================================================
// runModelDownload — pure orchestration of a model-download job over a port
// ============================================================================

/** Bridge surface derived from the global `window.openclip` typing (no preload import). */
export type OpenClipBridge = typeof window.openclip

export interface RunModelDownloadOptions {
  bridge: OpenClipBridge
  model: WhisperModelSize
  onProgress?: (receivedBytes: number, totalBytes: number) => void
}

/**
 * Start a `model-download` job and consume its port to completion. Streams
 * byte-count partials via `onProgress`; resolves with the download result or
 * throws on a terminal error event (job-termination invariant, PRD §10.2).
 */
export async function runModelDownload(
  opts: RunModelDownloadOptions
): Promise<JobResult['model-download']> {
  const { port } = await opts.bridge.jobs.start('model-download', { model: opts.model })
  let result: JobResult['model-download'] | null = null

  for await (const ev of jobEvents<'model-download'>(port as unknown as MessagePortLike)) {
    const e = ev as JobEventFor<'model-download'>
    switch (e.t) {
      case 'partial':
        opts.onProgress?.(e.data.receivedBytes, e.data.totalBytes)
        break
      case 'done':
        result = e.result
        break
      case 'error':
        throw new Error(`model download failed [${e.code}]: ${e.message}`)
    }
  }
  if (!result) throw new Error('model download ended without a result')
  return result
}
