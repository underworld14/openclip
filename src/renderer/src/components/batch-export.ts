/**
 * batch-export — PURE, bridge-injected orchestration of "Export all approved"
 * (Part K, Step 4). Mirrors `export-run.ts`: no React, no store import, so it is
 * unit-testable against the mock bridge + real MessageChannels.
 *
 * Each clip becomes one independent `runExport` (the proven streaming-job path);
 * the sidecar p-queue (cap min(2, ceil(cores/4))) throttles them — so NO new job
 * contract is needed. Per-clip failures are isolated (Promise.allSettled-style):
 * one bad clip never aborts the rest. Cancel-all is cooperative: aborting the
 * passed signal cancels every started job by id (the sidecar cancels queued AND
 * running jobs).
 *
 * Output goes to ONE user-chosen folder with collision-safe filenames derived
 * from the clip titles (`deriveBatchFileNames`).
 */

import type { Clip, Project } from '@shared/schema'
import type { JobResult } from '@shared/jobs'
import { runExport, defaultClipFileName, type OpenClipBridge } from './export-run'
import { buildExportParams } from '@renderer/stores/projectStore/exportSlice'
import { resolveEffectiveCaptionStyle } from './captionPresets'
import type { PlatformPreset } from './platformPresets'

/** Join a directory + filename with the directory's separator (default '/'). */
function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  return `${dir.replace(/[/\\]+$/, '')}${sep}${name}`
}

export interface BatchFileName {
  clipId: string
  outputPath: string
}

/**
 * Derive a UNIQUE, collision-safe `.mp4` path per clip in `dir`. Reuses the
 * single-export slug (`defaultClipFileName`) so batch + single names are
 * consistent; duplicate/empty slugs get a `-2`, `-3`, … suffix (deterministic by
 * input order). NOTE: dedup is WITHIN the batch — it does not stat the folder for
 * pre-existing files (ffmpeg `-y` overwrites those; surfaced in the UI copy).
 */
export function deriveBatchFileNames(
  clips: Array<Pick<Clip, 'id' | 'title'>>,
  dir: string
): BatchFileName[] {
  const used = new Set<string>()
  return clips.map((c) => {
    const base = defaultClipFileName(c.title) // "<slug>.mp4"
    const slug = base.replace(/\.mp4$/i, '')
    let name = base
    let n = 2
    while (used.has(name.toLowerCase())) {
      name = `${slug}-${n}.mp4`
      n += 1
    }
    used.add(name.toLowerCase())
    return { clipId: c.id, outputPath: joinPath(dir, name) }
  })
}

export type BatchClipStatus = 'running' | 'done' | 'error' | 'canceled'

export interface BatchClipResult {
  clipId: string
  outputPath: string
  status: BatchClipStatus
  result?: JobResult['export']
  error?: string
}

export interface RunBatchExportOptions {
  bridge: OpenClipBridge
  /** The composed live project (source + transcript) — clips come from `clips`. */
  project: Project
  /** The clips to export (e.g. all `approved`), in order. */
  clips: Clip[]
  /** The user-chosen output folder. */
  dir: string
  /** The platform preset (aspectRatio + quality + caption template). */
  preset: PlatformPreset
  onClipProgress?: (clipId: string, pct: number) => void
  onClipStatus?: (
    clipId: string,
    status: BatchClipStatus,
    info?: { outputPath?: string; error?: string }
  ) => void
  /** Abort to cancel-all: every started job is canceled by id. */
  signal?: AbortSignal
}

/**
 * Fan out one `export` job per clip and resolve once all settle. Returns a
 * per-clip result array (same order as `opts.clips`); never rejects on a single
 * clip's failure.
 */
export async function runBatchExport(opts: RunBatchExportOptions): Promise<BatchClipResult[]> {
  const names = deriveBatchFileNames(opts.clips, opts.dir)
  const pathFor = new Map(names.map((n) => [n.clipId, n.outputPath]))
  const jobIds = new Map<string, string>()
  const words = opts.project.transcript.words
  const captionStyle = resolveEffectiveCaptionStyle(opts.preset.captionTemplateId)

  const onAbort = (): void => {
    for (const jobId of jobIds.values()) void opts.bridge.jobs.cancel(jobId)
  }
  if (opts.signal) {
    if (opts.signal.aborted) onAbort()
    else opts.signal.addEventListener('abort', onAbort, { once: true })
  }

  const settled = await Promise.all(
    opts.clips.map(async (clip): Promise<BatchClipResult> => {
      const outputPath = pathFor.get(clip.id)!
      opts.onClipStatus?.(clip.id, 'running')
      try {
        const params = buildExportParams({
          projectId: opts.project.id,
          clip,
          source: opts.project.sourceVideo,
          settings: { aspectRatio: opts.preset.aspectRatio },
          outputPath,
          quality: opts.preset.quality,
          captionsEnabled: words.length > 0,
          words,
          captionStyle
        })
        const result = await runExport({
          bridge: opts.bridge,
          params,
          onProgress: (pct) => opts.onClipProgress?.(clip.id, pct),
          onStart: (jobId) => jobIds.set(clip.id, jobId)
        })
        opts.onClipStatus?.(clip.id, 'done', { outputPath })
        return { clipId: clip.id, outputPath, status: 'done', result }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        const status: BatchClipStatus = opts.signal?.aborted ? 'canceled' : 'error'
        opts.onClipStatus?.(clip.id, status, { error })
        return { clipId: clip.id, outputPath, status, error }
      }
    })
  )

  if (opts.signal) opts.signal.removeEventListener('abort', onAbort)
  return settled
}
