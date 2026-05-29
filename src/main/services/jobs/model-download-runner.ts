/**
 * src/main/services/jobs/model-download-runner.ts — the `model-download`
 * JobRunner (T-Media, E.3). Registered with the sidecar from `ipc/model.ts` so
 * MODEL_DOWNLOAD kicks off a streaming job that pulls the GGML model from HF,
 * SHA-verifies it, and streams byte-count partials + progress over the per-job
 * MessagePort (PRD §13 / §10.2).
 *
 * Thin glue between the frozen `JobRunner<'model-download'>` contract and
 * `model-manager.downloadModel`. Built via a factory with an INJECTED download
 * fn so it's unit-testable without a real HF call (PRD §18).
 */

import type { JobResult, JobParams, WhisperModelSize } from '@shared/jobs'
import type { JobRunner, JobEmitter, JobRunnerContext } from '@main/services/sidecar-manager'
import {
  downloadModel as defaultDownloadModel,
  type DownloadModelResult
} from '@main/services/model-manager'

export interface ModelDownloadRunnerDeps {
  downloadModel?: (opts: {
    model: WhisperModelSize
    signal: AbortSignal
    onProgress: (receivedBytes: number, totalBytes: number) => void
  }) => Promise<DownloadModelResult>
}

/**
 * Build the `model-download` runner. Streams `partial` byte-count events for
 * resumable progress plus a 0..100 `progress` derived from received/total, and
 * returns the downloaded model's path + size as the `done` result.
 */
export function createModelDownloadRunner(
  deps: ModelDownloadRunnerDeps = {}
): JobRunner<'model-download'> {
  const download =
    deps.downloadModel ??
    ((o) => defaultDownloadModel({ model: o.model, signal: o.signal, onProgress: o.onProgress }))

  return async (
    params: JobParams['model-download'],
    emit: JobEmitter<'model-download'>,
    ctx: JobRunnerContext
  ): Promise<JobResult['model-download']> => {
    emit.progress(0, 'downloading')

    const result = await download({
      model: params.model,
      signal: ctx.signal,
      onProgress: (receivedBytes, totalBytes) => {
        emit.partial({ receivedBytes, totalBytes })
        if (totalBytes > 0) {
          emit.progress(Math.min(100, (receivedBytes / totalBytes) * 100), 'downloading')
        }
      }
    })

    emit.progress(100, 'downloading')
    return { model: result.model, path: result.path, bytes: result.bytes }
  }
}

/** The default runner using the real download (registered in ipc/model.ts). */
export const modelDownloadRunner: JobRunner<'model-download'> = createModelDownloadRunner()
