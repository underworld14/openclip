/**
 * export-run — pure orchestration of an `export` job over a per-job MessagePort
 * (EXPORT spine, plan E.5). Kept out of the ExportPanel component file so the
 * component file only exports a component (react-refresh boundary) and so the
 * orchestration is unit-testable against the mock bridge + fake-port harness
 * (mirrors `model-download.runModelDownload`).
 *
 * Flow (the PROVEN streaming-job port path): `jobs.start('export', params)` →
 * `{ jobId }` → `acquireJobPort(jobId)` → drive `jobEvents('export')` to the
 * terminal `done` (the output path + dimensions) or throw on `error`
 * (job-termination invariant, PRD §10.2).
 */

import type { JobResult, JobParams } from '@shared/jobs'
import { drainJob } from '@renderer/hooks/useJob'

/** Bridge surface derived from the global `window.openclip` typing (no preload import). */
export type OpenClipBridge = typeof window.openclip

export interface RunExportOptions {
  bridge: OpenClipBridge
  params: JobParams['export']
  /** 0..100 encode progress callback (parsed from FFmpeg stderr in the runner). */
  onProgress?: (pct: number) => void
  /** Called with the assigned jobId right after start (batch export tracks these
   * so it can cancel-all). */
  onStart?: (jobId: string) => void
}

/**
 * Start an `export` job and consume its port to completion. Streams encode
 * progress via `onProgress`; resolves with the export result (output path +
 * dimensions + duration) or throws on a terminal error event.
 */
export async function runExport(opts: RunExportOptions): Promise<JobResult['export']> {
  return drainJob(opts.bridge, 'export', opts.params, {
    onStart: opts.onStart,
    onProgress: (pct) => opts.onProgress?.(pct)
  })
}

/**
 * Ask the user where to save, run the export, then return both the result and
 * the chosen path. Resolves `{ canceled: true }` when the save dialog is
 * dismissed (no job is started). The default filename is derived from the clip.
 */
export interface ExportToFileOptions {
  bridge: OpenClipBridge
  /** A function that, given the user-chosen output path, yields the export params. */
  buildParams: (outputPath: string) => JobParams['export']
  /** Default filename suggested in the save dialog (e.g. "the-wildest-take.mp4"). */
  defaultFileName: string
  onProgress?: (pct: number) => void
  /**
   * The assigned jobId, once the save dialog is past and the encode has actually
   * started. Exposed so a caller can offer Cancel for the running ffmpeg — the
   * job plane always supported it; nothing had ever asked for the handle
   * (EPIC-zpa1nd).
   */
  onStart?: (jobId: string) => void
}

export type ExportToFileResult =
  | { canceled: true }
  | { canceled: false; result: JobResult['export']; outputPath: string }

/**
 * The full export UX step: save dialog → export job → result. Used by the
 * ExportPanel; pure (bridge-injected) so it is unit-testable end-to-end.
 */
export async function exportToFile(opts: ExportToFileOptions): Promise<ExportToFileResult> {
  const dialog = await opts.bridge.system.saveDialog({
    defaultPath: opts.defaultFileName,
    filters: [{ name: 'MP4 Video', extensions: ['mp4'] }]
  })
  if (dialog.canceled || !dialog.filePath) return { canceled: true }

  const params = opts.buildParams(dialog.filePath)
  const result = await runExport({
    bridge: opts.bridge,
    params,
    onProgress: opts.onProgress,
    onStart: opts.onStart
  })
  return { canceled: false, result, outputPath: dialog.filePath }
}

/**
 * Reveal the exported file in the OS file manager (PRD §6.9 "open folder").
 * Hands the output FILE path; the main handler reveals it in its folder.
 */
export async function openExportFolder(bridge: OpenClipBridge, outputPath: string): Promise<void> {
  await bridge.system.openFolder({ path: outputPath })
}

/** Derive a filesystem-safe default mp4 filename from a clip title. */
export function defaultClipFileName(title: string): string {
  const slug =
    title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'clip'
  return `${slug}.mp4`
}
