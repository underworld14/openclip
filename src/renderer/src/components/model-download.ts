/**
 * model-download — the GGML model table + pure download orchestration for
 * ModelDownloadDialog (T-Media, E.3). Kept out of the component file so it only
 * exports a component (react-refresh boundary) and so the orchestration is
 * unit-testable against the mock bridge + fake-port harness.
 */

import type { JobResult, WhisperModelSize } from '@shared/jobs'
import { drainJob } from '@renderer/hooks/useJob'
import { trackTask } from '@renderer/stores/jobsStore'

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
  /**
   * Receives the job id as soon as the job starts, so the caller can cancel it
   * (FEAT-kncqxf). Without this the dialog had no handle on the download and
   * therefore no way to offer a Cancel button.
   */
  onStart?: (jobId: string) => void
}

/**
 * Start a `model-download` job and consume its port to completion. Streams
 * byte-count partials via `onProgress`; resolves with the download result or
 * throws on a terminal error event (job-termination invariant, PRD §10.2).
 */
export async function runModelDownload(
  opts: RunModelDownloadOptions
): Promise<JobResult['model-download']> {
  return drainJob(
    opts.bridge,
    'model-download',
    { model: opts.model },
    {
      onStart: (jobId) => opts.onStart?.(jobId),
      onPartial: (data) => opts.onProgress?.(data.receivedBytes, data.totalBytes)
    }
  )
}

// ============================================================================
// startModelDownload — the ONE way any surface starts a download (BUG-45xt77)
// ============================================================================

export interface StartModelDownloadOptions {
  model: WhisperModelSize
  /** Per-surface progress (the settings row, the dialog). The status bar is automatic. */
  onProgress?: (pct: number, receivedBytes: number, totalBytes: number) => void
  onDone?: (model: WhisperModelSize) => void
  onError?: (message: string) => void
}

/**
 * Start a model download as a tracked task and return immediately-usable
 * handles.
 *
 * Extracted so the Settings row, the readiness chip and the import gate all get
 * identical behaviour: progress in the status bar, a working Cancel, and a Retry
 * on failure. Previously only the dialog could start one, which is why every
 * entry point had to route through a modal that then asked the user to pick the
 * model they had already picked.
 *
 * The returned promise settles when the download does; it never rejects (errors
 * arrive via `onError`), so callers can `void` it without an unhandled rejection.
 */
export function startModelDownload(opts: StartModelDownloadOptions): {
  cancel: () => void
  finished: Promise<boolean>
} {
  let jobId: string | null = null
  // Set before the job id arrives, so a cancel pressed in that window is not lost
  // — it used to leave an unstoppable job with a live status-bar row.
  let cancelRequested = false

  const finished = trackTask(
    {
      kind: 'model-download',
      label: opts.model,
      stages: ['downloading'],
      // Offer Retry in the status bar on failure. A download that dies at 90%
      // otherwise left a dead-end error row — the status bar already renders a
      // Retry button, downloads simply never supplied one.
      retry: async () => {
        await startModelDownload(opts).finished
      }
    },
    async (task) => {
      task.setCancel(async () => {
        cancelRequested = true
        if (jobId) await window.openclip.jobs.cancel(jobId)
      })
      await runModelDownload({
        bridge: window.openclip,
        model: opts.model,
        onStart: (id) => {
          jobId = id
          if (cancelRequested) void window.openclip.jobs.cancel(id)
        },
        onProgress: (received, total) => {
          const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0
          task.progress(pct, 'downloading', { receivedBytes: received, totalBytes: total })
          opts.onProgress?.(pct, received, total)
        }
      })
    }
  )
    .then(() => {
      opts.onDone?.(opts.model)
      return true
    })
    .catch((e: unknown) => {
      opts.onError?.(e instanceof Error ? e.message : String(e))
      return false
    })

  return {
    cancel: () => {
      cancelRequested = true
      if (jobId) void window.openclip.jobs.cancel(jobId)
    },
    finished
  }
}
