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

import { rmSync, statSync } from 'node:fs'
import type { JobResult, JobParams } from '@shared/jobs'
import type { JobRunner, JobEmitter, JobRunnerContext } from '@main/services/sidecar-manager'
import {
  exportClip as defaultExportClip,
  isHardwareEncoderFailure,
  outputDimensions,
  type ExportClipResult
} from '@main/services/ffmpeg-export'
import {
  writeClipCaptions as defaultWriteClipCaptions,
  writeSidecarSubtitles
} from '@main/services/ffmpeg-caption'
import { detectSilences as defaultDetectSilences } from '@main/services/silence-detect'
import {
  planReframe as defaultPlanReframe,
  DEFAULT_SAMPLE_FPS
} from '@main/services/reframe-detect'
import {
  reframeCacheKey,
  readReframePlan as defaultReadReframePlan,
  writeReframePlan as defaultWriteReframePlan
} from '@main/services/reframe-cache'
import { computeKeepRanges, removesAnything, type Range } from '@shared/keep-ranges'
import type { ReframePlan } from '@shared/reframe-plan'
import {
  cacheDirFor as defaultCacheDirFor,
  fontsDir as defaultFontsDir,
  jobTempDir,
  TEMP_NAMES
} from '@main/utils/paths'

export interface ExportRunnerDeps {
  /** The cut+reframe+re-encode service (injected for tests). */
  exportClip?: (opts: {
    sourcePath: string
    outputPath: string
    startTime: number
    endTime: number
    aspectRatio: JobParams['export']['aspectRatio']
    quality: JobParams['export']['quality']
    forceCpu?: boolean
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
    /** PID hooks for the face/motion ffmpeg children (FEAT-rmh08k). */
    onSpawn?: (pid: number) => void
    onExit?: (pid: number) => void
  }) => Promise<ReframePlan | null>
  /**
   * The reframe-plan cache (FEAT-rmh08k), injected so the runner's specs stay
   * off the filesystem — and so a test can assert that a HIT skips planning
   * entirely, which is the whole point of the feature.
   */
  cacheDirFor?: (projectId: string) => string
  readReframePlan?: (dir: string, key: string) => { plan: ReframePlan | null } | undefined
  writeReframePlan?: (dir: string, key: string, plan: ReframePlan | null) => void
  /**
   * Source mtime for the cache key. Injected for the same reason; the default
   * returns 0 when the file cannot be stat'd, which is a stable key rather than
   * a throw — a missing source will fail later, in the encode, with a real error.
   */
  sourceMtimeMs?: (sourcePath: string) => number
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
  // The reframe-plan cache (FEAT-rmh08k).
  const cacheDirFor = deps.cacheDirFor ?? defaultCacheDirFor
  const readPlan = deps.readReframePlan ?? defaultReadReframePlan
  const writePlan = deps.writeReframePlan ?? defaultWriteReframePlan
  const sourceMtimeMs =
    deps.sourceMtimeMs ??
    ((p: string): number => {
      try {
        return statSync(p).mtimeMs
      } catch {
        // A stable key beats a throw: a source that cannot be stat'd will fail
        // in the encode, with an error that says so.
        return 0
      }
    })
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
          // A letterbox/blur fit has no crop left to move, so the plan could only
          // be discarded (FEAT-bd87vz) — and face analysis is the slowest phase of
          // the whole export. Skip it rather than paying for an ignored result.
          if (params.fitMode && params.fitMode !== 'fill') return null
          if (!(params.reframe && params.reframe !== 'off' && params.sourceResolution)) return null

          // A MANUAL override short-circuits detection entirely (FEAT-kzej8t).
          // The user has already decided where the crop goes; running the face
          // pipeline to discard its answer would be the most expensive no-op in
          // the export. Built here rather than in the planner because it is not
          // a plan — it is the absence of one.
          if (typeof params.reframeCropX === 'number') {
            const { width, height } = outputDimensions(params.aspectRatio)
            const cropH = params.sourceResolution.height
            const cropW = Math.round((cropH * width) / height / 2) * 2
            return {
              mode: 'static',
              cropW,
              cropH,
              cropX: Math.max(
                0,
                Math.min(Math.round(params.reframeCropX), params.sourceResolution.width - cropW)
              )
            }
          }

          // The plan CACHE (FEAT-rmh08k). `docs/auto-reframe-design.md:50` asked
          // for this and nothing implemented it, so re-exporting the same clip
          // after nudging a caption colour re-ran the whole face pipeline: a 2fps
          // decode, YuNet on every sampled frame, and a second motion pass.
          //
          // `null` is cached too — "no usable face, centre-crop" costs exactly as
          // much to compute as a plan does — which is why the hit is an object
          // wrapper rather than the plan itself.
          const cache = ((): { dir: string; key: string } | null => {
            try {
              return {
                dir: cacheDirFor(params.projectId),
                key: reframeCacheKey({
                  clipId: params.clipId,
                  startTime: params.startTime,
                  endTime: params.endTime,
                  sourceMtimeMs: sourceMtimeMs(params.sourcePath),
                  sampleFps: DEFAULT_SAMPLE_FPS,
                  aspect: params.aspectRatio,
                  mode: params.reframe
                })
              }
            } catch {
              // Resolving the cache location is not allowed to break the export.
              // The whole module holds this rule; this is the one call that sits
              // outside it, because it reaches Electron's `app` for the temp root.
              return null
            }
          })()
          const hit = cache ? readPlan(cache.dir, cache.key) : undefined
          if (hit) {
            // Jump the bar past the phase we just skipped, so a cached export
            // does not look stalled at 0% before encoding starts.
            emit.progress(ANALYZE_PROGRESS_CEILING, 'analyzing')
            return hit.plan
          }

          try {
            const plan = await planReframe({
              sourcePath: params.sourcePath,
              startTime: params.startTime,
              endTime: params.endTime,
              source: params.sourceResolution,
              aspect: params.aspectRatio,
              mode: params.reframe,
              signal: ctx.signal,
              // Give the sidecar an OS-level kill backstop for the face/motion
              // ffmpeg children too (FEAT-rmh08k). They spawn directly rather
              // than through `ffmpeg-core.runFfmpeg` (they need stdout, which it
              // discards) and so were the only ffmpeg children in the app that a
              // quit or a crash could orphan.
              onSpawn: (pid) => ctx.trackPid(pid),
              onExit: (pid) => ctx.untrackPid?.(pid),
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
            if (cache) writePlan(cache.dir, cache.key, plan)
            return plan
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

      const runExport = (forceCpu: boolean): Promise<ExportClipResult> =>
        exportClip({
          sourcePath: params.sourcePath,
          outputPath: params.outputPath,
          startTime: params.startTime,
          endTime: params.endTime,
          aspectRatio: params.aspectRatio,
          // FEAT-bd87vz — absent ⇒ `fill`, the historical centre-crop.
          fitMode: params.fitMode,
          quality: params.quality,
          forceCpu,
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

      // AUTOMATIC CPU FALLBACK (FEAT-5hnsby / PRD §14 "all flows have a CPU
      // fallback so the app always works").
      //
      // `h264_videotoolbox` is LISTED by `ffmpeg -encoders` on machines that
      // cannot actually use it — a VM, a headless session, or a Mac already at
      // its encode-session limit. It then fails at open with
      // `cannot create compression session: -12903`, and the export died with a
      // SIDECAR_CRASH the user could do nothing about. Probing the encoder list
      // is not enough to predict this; only trying it is (the same lesson the CI
      // work landed on in BUG-zcqyb7), so the fallback is reactive by design.
      //
      // Retried ONCE, and only for a hardware-encoder failure — a bad path, a
      // cancelled job, or a genuinely broken source must still fail fast rather
      // than pay for a second doomed encode.
      let result: ExportClipResult
      try {
        result = await runExport(params.forceCpu === true)
      } catch (e) {
        if (params.forceCpu === true || ctx.signal?.aborted || !isHardwareEncoderFailure(e)) {
          throw e
        }
        console.warn(
          `[export] hardware encoder unavailable (${
            e instanceof Error ? e.message : String(e)
          }); retrying on libx264 (CPU).`
        )
        emit.progress(0, 'encoding')
        result = await runExport(true)
      }

      // A sidecar .srt beside every exported clip (FEAT-vwvgs0). The data was
      // already in hand — the runner scopes and rebases the same words it burns
      // into pixels — and shipping it costs nothing at export time while saving
      // the user a separate round-trip when they upload. Best-effort: a failure
      // to write the subtitle must never fail the video that already rendered.
      if (params.captions?.words?.length) {
        try {
          writeSidecarSubtitles({
            outputPath: params.outputPath,
            words: params.captions.words,
            clipStart: params.startTime,
            clipEnd: params.endTime
          })
        } catch (e) {
          console.warn(
            `[export] could not write the sidecar .srt: ${
              e instanceof Error ? e.message : String(e)
            }`
          )
        }
      }

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
