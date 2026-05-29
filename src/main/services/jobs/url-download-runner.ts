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

import { mkdirSync } from 'node:fs'
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

  return async (
    params: JobParams['url-download'],
    emit: JobEmitter<'url-download'>,
    ctx: JobRunnerContext
  ): Promise<JobResult['url-download']> => {
    emit.progress(0, 'downloading')

    const outDir = params.outDir ?? resolveOutDir(ctx.jobId)

    const result = await download({
      url: params.url,
      outDir,
      signal: ctx.signal,
      onPid: (pid) => ctx.trackPid(pid),
      onProgress: ({ downloadedBytes, totalBytes, pct }) => {
        emit.partial({ downloadedBytes, totalBytes, pct })
        emit.progress(Math.min(100, Math.max(0, pct)), 'downloading')
      }
    })

    emit.progress(100, 'downloading')
    return { filePath: result.filePath, title: result.title, bytes: result.bytes }
  }
}

/** The default runner using the real yt-dlp download (registered in ipc/video.ts). */
export const urlDownloadRunner: JobRunner<'url-download'> = createUrlDownloadRunner()
