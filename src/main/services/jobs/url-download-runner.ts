/**
 * src/main/services/jobs/url-download-runner.ts — the `url-download` JobRunner
 * (F.4). Registered with the sidecar from `ipc/video.ts` so the renderer can
 * `jobs.start('url-download', { url })` and stream download progress over the
 * per-job MessagePort, then feed the resulting file into the import pipeline.
 *
 * Thin glue between the frozen `JobRunner<'url-download'>` contract and
 * `url-download.downloadUrl`. Built via a factory with an INJECTED download fn
 * so it's unit-testable without spawning a real yt-dlp (mirrors
 * `model-download-runner.ts`; PRD §18).
 */

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { JobResult, JobParams } from '@shared/jobs'
import type { JobRunner, JobEmitter, JobRunnerContext } from '@main/services/sidecar-manager'
import {
  downloadUrl as defaultDownloadUrl,
  type UrlDownloadOptions,
  type UrlDownloadResult
} from '@main/services/url-download'
import { openclipTempRoot } from '@main/utils/paths'

export interface UrlDownloadRunnerDeps {
  downloadUrl?: (opts: UrlDownloadOptions) => Promise<UrlDownloadResult>
  /** Resolve the default per-job download dir (injectable for tests). */
  resolveOutDir?: (jobId: string) => string
  /**
   * Remove the per-job download scratch dir on error/cancel (audit fix
   * openclip-2j3 — injectable for tests). Default: best-effort `rmSync(outDir,
   * {recursive, force})`. NOT called on success: the downloaded file still lives
   * in `outDir` until the import pipeline ADOPTS it out (move into media/<id>/),
   * so removing it on success would delete the file before adoption.
   */
  removeOutDir?: (outDir: string) => void
}

/** Best-effort removal of a download scratch dir — never throws (audit fix openclip-2j3). */
function defaultRemoveOutDir(outDir: string): void {
  try {
    rmSync(outDir, { recursive: true, force: true })
  } catch {
    /* never let temp cleanup fail the job — the launch sweep is the backstop */
  }
}

/** Default per-job download dir under the OpenClip temp root, created on demand. */
function defaultResolveOutDir(jobId: string): string {
  const dir = join(openclipTempRoot(), 'downloads', jobId)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Build the `url-download` runner. Emits `progress(0,'downloading')` up front,
 * streams `{ downloadedBytes, totalBytes, pct }` partials + a 0..100 progress as
 * yt-dlp reports, and returns `{ filePath, title?, bytes }` as the `done` result.
 * `ctx.signal` cancels the download; `ctx.trackPid` registers the yt-dlp pid so
 * the sidecar escalates SIGTERM→SIGKILL on quit/cancel (PRD §17).
 */
export function createUrlDownloadRunner(
  deps: UrlDownloadRunnerDeps = {}
): JobRunner<'url-download'> {
  const download = deps.downloadUrl ?? defaultDownloadUrl
  const resolveOutDir = deps.resolveOutDir ?? defaultResolveOutDir
  const removeOutDir = deps.removeOutDir ?? defaultRemoveOutDir

  return async (
    params: JobParams['url-download'],
    emit: JobEmitter<'url-download'>,
    ctx: JobRunnerContext
  ): Promise<JobResult['url-download']> => {
    emit.progress(0, 'downloading')

    // Always derive the output dir server-side from the jobId — never trust a
    // renderer-supplied path (G.2 trust boundary: a renderer outDir would be an
    // arbitrary-file-write primitive). The URL itself is validated in downloadUrl.
    const outDir = resolveOutDir(ctx.jobId)

    let result: UrlDownloadResult
    try {
      result = await download({
        url: params.url,
        outDir,
        signal: ctx.signal,
        onPid: (pid) => ctx.trackPid(pid),
        onExit: (pid) => ctx.untrackPid?.(pid),
        onProgress: ({ downloadedBytes, totalBytes, pct }) => {
          emit.partial({ downloadedBytes, totalBytes, pct })
          emit.progress(Math.min(100, Math.max(0, pct)), 'downloading')
        }
      })
    } catch (err) {
      // Audit fix openclip-2j3: on error/cancel the partial download is dead —
      // reclaim its scratch dir (<temp>/openclip/downloads/<jobId>) so a failed
      // import never leaks a `.part`/orphan dir. Best-effort; rethrow the error so
      // the manager still maps it to a terminal `error` (no swallow). On SUCCESS
      // we DON'T rm: the file lives here until the import pipeline adopts it out.
      removeOutDir(outDir)
      throw err
    }

    emit.progress(100, 'downloading')
    return { filePath: result.filePath, title: result.title, bytes: result.bytes }
  }
}

/** The default runner using the real yt-dlp download (registered in ipc/video.ts). */
export const urlDownloadRunner: JobRunner<'url-download'> = createUrlDownloadRunner()
