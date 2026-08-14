/**
 * src/main/services/jobs/export-runner.ts — the `export` JobRunner (EXPORT
 * spine, plan E.5). Registered with the sidecar via `registerRunner('export',
 * …)` from `ipc/video.ts` so `JOB_START('export', …)` runs the frame-accurate
 * cut + 9:16 reframe + re-encode and streams FFmpeg progress over the per-job
 * MessagePort, terminating with the output path + dimensions as `done`
 * (PRD §6.5/§6.9 / §10.2).
 *
 * Thin glue between the frozen `JobRunner<'export'>` contract and the
 * `exportClip` service (`ffmpeg-export`). Built via a factory with an INJECTED
 * `exportClip` so it is unit-testable without the real binary (PRD §18);
 * `createExportRunner()` with no args uses the real service.
 *
 * Bounds note (critic fix M2): `JobParams['export'].startTime/endTime` are the
 * ALREADY-RESOLVED effective bounds (the renderer applies `resolveBounds(clip)`
 * before starting the job — see exportSlice). The runner just cuts that span; it
 * does not re-derive edited bounds, keeping the resolver a single pure source of
 * truth shared by export + timeline.
 *
 * Caption-burn seam (fix M3): `params.assPath` is threaded straight into
 * `exportClip` so when the caption-burn stage generates an `.ass` it lands in
 * the SAME re-encode (one pass: `crop,scale,subtitles=…:fontsdir=…`) — no second
 * runner. The fontsdir comes from trunk-frozen `paths.fontsDir()`.
 */

import { rmSync } from 'node:fs'
import type { JobResult, JobParams } from '@shared/jobs'
import type { JobRunner, JobEmitter, JobRunnerContext } from '@main/services/sidecar-manager'
import {
  exportClip as defaultExportClip,
  outputDimensions,
  type ExportClipResult
} from '@main/services/ffmpeg-export'
import { writeClipCaptions as defaultWriteClipCaptions } from '@main/services/ffmpeg-caption'
import { detectSilences as defaultDetectSilences } from '@main/services/silence-detect'
import { planReframe as defaultPlanReframe } from '@main/services/reframe-detect'
import { computeKeepRanges, removesAnything, type Range } from '@shared/keep-ranges'
import type { ReframePlan } from '@shared/reframe-plan'
import { fontsDir as defaultFontsDir, jobTempDir, TEMP_NAMES } from '@main/utils/paths'

export interface ExportRunnerDeps {
  /** The cut+reframe+re-encode service (injected for tests). */
  exportClip?: (opts: {
    sourcePath: string
    outputPath: string
    startTime: number
    endTime: number
    aspectRatio: JobParams['export']['aspectRatio']
    quality: JobParams['export']['quality']
    assPath?: string
    fontsDir?: string
    keepRanges?: Range[]
    reframePlan?: ReframePlan | null
    logoPath?: JobParams['export']['logoPath']
    logoPosition?: JobParams['export']['logoPosition']
    logoScale?: JobParams['export']['logoScale']
    logoMargin?: JobParams['export']['logoMargin']
    onProgress?: (pct: number) => void
    onSpawn?: (pid: number) => void
    onExit?: (pid: number) => void
    signal?: AbortSignal
  }) => Promise<ExportClipResult>
  /** Resolve the libass fontsdir (injected for tests). */
  fontsDir?: () => string
  /** Generate + write the karaoke .ass and return its path (injected for tests). */
  writeClipCaptions?: (opts: {
    words: NonNullable<JobParams['export']['captions']>['words']
    clipStart: number
    clipEnd: number
    style?: NonNullable<JobParams['export']['captions']>['style']
    keywords?: string[]
    aiEmojiMap?: Record<string, string>
    assPath: string
    keepRanges?: Range[]
    canvas?: { width: number; height: number }
  }) => string
  /** Detect silences for jump-cuts (Part I.4 — injected for tests). */
  detectSilences?: (opts: {
    sourcePath: string
    startTime: number
    endTime: number
    noiseDb?: number
    minSilenceSec?: number
    signal?: AbortSignal
  }) => Promise<Range[]>
  /** Plan auto-reframe (detect faces → crop plan, Part J — injected for tests). */
  planReframe?: (opts: {
    sourcePath: string
    startTime: number
    endTime: number
    source: { width: number; height: number }
    aspect: JobParams['export']['aspectRatio']
    mode: 'auto' | 'split'
    signal?: AbortSignal
    onFrame?: (framesDone: number, frameBudget: number) => void
  }) => Promise<ReframePlan | null>
  /** Resolve the per-job temp .ass path (injected for tests). */
  resolveAssPath?: (projectId: string, jobId: string, clipId: string) => string
  /**
   * Remove the per-job temp scratch dir (audit fix openclip-2j3 — injected for
   * tests). Default: best-effort `rmSync(jobTempDir(projectId, jobId), {recursive,
   * force})` so the dir is reclaimed whether the export succeeds, throws, or is
   * cancelled. Removes ONLY `<temp>/openclip/<projectId>/<jobId>`, never the
   * sibling content-addressed `cache/`.
   */
  removeJobTemp?: (projectId: string, jobId: string) => void
}

/**
 * How much of the bar the 'analyzing' phase owns before encoding begins.
 *
 * Kept small and honest: face sampling is slow but it is not most of the work,
 * and a bar that reaches 60% before the encode starts only to crawl afterwards
 * is a worse lie than one that moves a little. Encoding reports its own 0..100
 * and takes over from here.
 */
export const ANALYZE_PROGRESS_CEILING = 15

/**
 * Best-effort removal of a job's temp scratch dir (audit fix openclip-2j3).
 * Wrapped in try/catch so cleanup NEVER throws (mirrors `faststartRemux`); a
 * leftover dir is reclaimed by the launch-time temp sweep as a backstop. Only
 * ever touches `<temp>/openclip/<projectId>/<jobId>`, never the sibling `cache/`.
 */
function defaultRemoveJobTemp(projectId: string, jobId: string): void {
  try {
    rmSync(jobTempDir(projectId, jobId), { recursive: true, force: true })
  } catch {
    /* never let temp cleanup fail the job — the launch sweep is the backstop */
  }
}

/**
 * Build the `export` runner. Streams 0..100 `progress` parsed from FFmpeg's
 * stderr and returns `{ outputPath, width, height, durationMs }` as the `done`
 * result. A non-positive span / ffmpeg failure throws (the manager maps it to a
 * typed error — never a hang, PRD §10.2 invariant).
 */
export function createExportRunner(deps: ExportRunnerDeps = {}): JobRunner<'export'> {
  const exportClip = deps.exportClip ?? defaultExportClip
  const resolveFontsDir = deps.fontsDir ?? defaultFontsDir
  const writeClipCaptions = deps.writeClipCaptions ?? defaultWriteClipCaptions
  const detectSilences = deps.detectSilences ?? defaultDetectSilences
  const planReframe = deps.planReframe ?? defaultPlanReframe
  const resolveAssPath =
    deps.resolveAssPath ??
    ((projectId, jobId, clipId) =>
      `${jobTempDir(projectId, jobId)}/${TEMP_NAMES.captionsAss(clipId)}`)
  const removeJobTemp = deps.removeJobTemp ?? defaultRemoveJobTemp

  return async (
    params: JobParams['export'],
    emit: JobEmitter<'export'>,
    ctx: JobRunnerContext
  ): Promise<JobResult['export']> => {
    // Audit fix openclip-2j3: ALWAYS reclaim the per-job temp scratch dir
    // (<temp>/openclip/<projectId>/<jobId>) on the way out — whether the export
    // succeeds, throws, or is cancelled. The `finally` removes ONLY that job dir,
    // never the sibling content-addressed `cache/`. (Single bracketing hunk.)
    try {
      // Lead with a stage that matches what runs first: an 'analyzing' pass when we
      // detect silences/faces, else straight to 'encoding' (keeps progress monotonic).
      const willAnalyze = !!params.removeSilence || (!!params.reframe && params.reframe !== 'off')
      emit.progress(0, willAnalyze ? 'analyzing' : 'encoding')

      // The silence-detect and reframe analysis passes EACH decode the same source span,
      // but they're independent (silence → keepRanges, reframe → cropPlan; neither feeds
      // the other), so run them CONCURRENTLY rather than awaiting serially (audit fix
      // openclip-lri): the analysis latency was doubled for no reason. The p-queue still
      // bounds total ffmpeg concurrency, and each pass stays best-effort (its own
      // try/catch returns a fallback so a failure never blocks the export). Silence is
      // still resolved BEFORE captions are built below, so the karaoke rides the
      // compressed (jump-cut) timeline.
      const [keepRanges, reframePlan] = await Promise.all([
        // Jump-cut (Part I.4, opt-in): detect silences → keep-ranges, or undefined.
        (async (): Promise<Range[] | undefined> => {
          if (!params.removeSilence) return undefined
          const tuning = typeof params.removeSilence === 'object' ? params.removeSilence : {}
          const minSilenceSec = tuning.minSilenceSec ?? 0.6
          try {
            const silences = await detectSilences({
              sourcePath: params.sourcePath,
              startTime: params.startTime,
              endTime: params.endTime,
              noiseDb: tuning.noiseDb,
              minSilenceSec,
              signal: ctx.signal
            })
            const kr = computeKeepRanges(params.startTime, params.endTime, silences, {
              minSilenceSec,
              padSec: tuning.padSec
            })
            return removesAnything(kr, params.startTime, params.endTime) ? kr : undefined
          } catch {
            /* silence detection failed → normal single cut (never block the export) */
            return undefined
          }
        })(),
        // Auto-reframe (Part J, opt-in): detect faces → a crop plan, or null ⇒ center-crop.
        (async (): Promise<ReframePlan | null> => {
          if (!(params.reframe && params.reframe !== 'off' && params.sourceResolution)) return null
          try {
            return await planReframe({
              sourcePath: params.sourcePath,
              startTime: params.startTime,
              endTime: params.endTime,
              source: params.sourceResolution,
              aspect: params.aspectRatio,
              mode: params.reframe,
              signal: ctx.signal,
              // Face sampling is the long pole of 'analyzing'. Map it into the
              // 0..ANALYZE_PROGRESS_CEILING band so the bar visibly moves
              // instead of sitting at 0 for the slowest phase (FEAT-8559h1);
              // encoding then takes over the rest of the bar.
              onFrame: (framesDone, frameBudget) =>
                emit.progress(
                  Math.min(
                    ANALYZE_PROGRESS_CEILING,
                    Math.round((framesDone / frameBudget) * ANALYZE_PROGRESS_CEILING)
                  ),
                  'analyzing'
                )
            })
          } catch (e) {
            // Best-effort → static center-crop (never block the export). LOG it, though:
            // a missing/broken model is otherwise indistinguishable from "no faces found".
            console.warn(
              `[export] reframe detection failed; falling back to center-crop: ${
                e instanceof Error ? e.message : String(e)
              }`
            )
            return null
          }
        })()
      ])

      // Resolve the .ass to burn: an explicitly-supplied `assPath` wins; otherwise,
      // if karaoke caption inputs are present, GENERATE the .ass into the per-job
      // temp dir (PRD §17) from the clip's word timestamps + style, scoped+rebased
      // to the clip's resolved bounds (or remapped onto the compressed timeline when
      // jump-cutting). No captions → no subtitles filter (fix M3).
      let assPath = params.assPath
      if (!assPath && params.captions) {
        assPath = writeClipCaptions({
          words: params.captions.words,
          clipStart: params.startTime,
          clipEnd: params.endTime,
          style: params.captions.style,
          keywords: params.captions.keywords,
          aiEmojiMap: params.captions.aiEmojiMap,
          assPath: resolveAssPath(params.projectId, ctx.jobId, params.clipId),
          keepRanges,
          // The canvas the burn lands on. Without it the .ass declared a 1080×1920
          // script for every aspect, so libass shrank captions on any non-9:16
          // export (BUG-y6y5mf).
          canvas: outputDimensions(params.aspectRatio)
        })
      }

      const result = await exportClip({
        sourcePath: params.sourcePath,
        outputPath: params.outputPath,
        startTime: params.startTime,
        endTime: params.endTime,
        aspectRatio: params.aspectRatio,
        quality: params.quality,
        assPath,
        // Only needed when captions are burned; harmless otherwise.
        fontsDir: assPath ? resolveFontsDir() : undefined,
        keepRanges,
        reframePlan,
        // Brand-kit logo overlay (Part K) — absent ⇒ no overlay (argv unchanged).
        logoPath: params.logoPath,
        logoPosition: params.logoPosition,
        logoScale: params.logoScale,
        logoMargin: params.logoMargin,
        onProgress: (pct) => emit.progress(pct, 'encoding'),
        // Register the encode child's PID for the sidecar kill-on-quit backstop
        // (audit fix openclip-a00 — export previously tracked no PID), and untrack it on
        // exit so a later quit can't SIGKILL a recycled PID (audit fix openclip-yul).
        onSpawn: (pid) => ctx.trackPid(pid),
        onExit: (pid) => ctx.untrackPid?.(pid),
        signal: ctx.signal
      })

      emit.progress(100, 'encoding')
      return {
        outputPath: result.outputPath,
        width: result.width,
        height: result.height,
        durationMs: result.durationMs
      }
    } finally {
      // Reclaim the per-job temp scratch (best-effort; never throws). Removes
      // ONLY <temp>/openclip/<projectId>/<jobId>, never the sibling cache/.
      removeJobTemp(params.projectId, ctx.jobId)
    }
  }
}

/** The default runner using the real export service (registered in ipc/video.ts). */
export const exportRunner: JobRunner<'export'> = createExportRunner()
