/**
 * generate-clips-run — pure orchestration of a `generate-clips` job over a
 * per-job MessagePort (EPIC-zpa1nd / FEAT-c0zn3j).
 *
 * Mirrors `export-run.ts`: kept out of any component file so the orchestration
 * is unit-testable against the mock bridge + fake-port harness, with no React
 * and no store import.
 *
 * Clip detection used to be `await window.openclip.ai.generateClips(req)` — a
 * plain invoke with nothing to show and nothing to cancel. Now it is the same
 * streaming-job path every other long operation already used.
 */

import type { JobResult, JobParams } from '@shared/jobs'
import { drainJob } from '@renderer/hooks/useJob'

/** Bridge surface derived from the global `window.openclip` typing (no preload import). */
export type OpenClipBridge = typeof window.openclip

export interface RunGenerateClipsOptions {
  bridge: OpenClipBridge
  params: JobParams['generate-clips']
  /** 0..100 across the transcript's chunks, plus the stage label. */
  onProgress?: (pct: number, stage: string) => void
  /**
   * One chunk's PROVISIONAL candidates, for streaming preview only. These are
   * not de-overlapped across chunks, ranked or clamped — the resolved value is
   * the authoritative set and should REPLACE anything shown from here.
   */
  onPartial?: (data: JobPartialClips) => void
  /** The assigned jobId, right after start, so the caller can cancel it. */
  onStart?: (jobId: string) => void
}

export type JobPartialClips = {
  clips: JobResult['generate-clips']['clips']
  chunkIndex: number
  chunkCount: number
}

/**
 * Start a `generate-clips` job and consume its port to completion. Resolves
 * with the authoritative ClipSchema or throws on a terminal error event
 * (job-termination invariant, PRD §10.2).
 */
export async function runGenerateClips(
  opts: RunGenerateClipsOptions
): Promise<JobResult['generate-clips']> {
  return drainJob(opts.bridge, 'generate-clips', opts.params, {
    onStart: opts.onStart,
    onProgress: opts.onProgress,
    onPartial: (data) => opts.onPartial?.(data)
  })
}
