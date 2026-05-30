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

import type { JobResult, JobParams } from '@shared/jobs'
import type { JobRunner, JobEmitter, JobRunnerContext } from '@main/services/sidecar-manager'
import {
  exportClip as defaultExportClip,
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
  }) => Promise<ReframePlan | null>
  /** Resolve the per-job temp .ass path (injected for tests). */
  resolveAssPath?: (projectId: string, jobId: string, clipId: string) => string
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

  return async (
    params: JobParams['export'],
    emit: JobEmitter<'export'>,
    ctx: JobRunnerContext
  ): Promise<JobResult['export']> => {
    // Lead with a stage that matches what runs first: an 'analyzing' pass when we
    // detect silences/faces, else straight to 'encoding' (keeps progress monotonic).
    const willAnalyze = !!params.removeSilence || (!!params.reframe && params.reframe !== 'off')
    emit.progress(0, willAnalyze ? 'analyzing' : 'encoding')

    // Jump-cut (Part I.4, opt-in): detect silences in the clip span → compute the
    // spans to keep. Best-effort — a detection failure (or no removable silence)
    // falls back to the normal single cut. Done BEFORE captions so the karaoke is
    // built on the compressed timeline.
    let keepRanges: Range[] | undefined
    if (params.removeSilence) {
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
        if (removesAnything(kr, params.startTime, params.endTime)) keepRanges = kr
      } catch {
        /* silence detection failed → normal single cut (never block the export) */
      }
    }

    // Auto-reframe (Part J, opt-in): detect faces → a crop plan (static / pan /
    // split). Best-effort — any failure, no faces, or a missing source size leaves
    // the plan null ⇒ the static center-crop (export never fails because of this).
    let reframePlan: ReframePlan | null = null
    if (params.reframe && params.reframe !== 'off' && params.sourceResolution) {
      try {
        reframePlan = await planReframe({
          sourcePath: params.sourcePath,
          startTime: params.startTime,
          endTime: params.endTime,
          source: params.sourceResolution,
          aspect: params.aspectRatio,
          mode: params.reframe,
          signal: ctx.signal
        })
      } catch (e) {
        // Best-effort → static center-crop (never block the export). LOG it, though:
        // a missing/broken model is otherwise indistinguishable from "no faces found".
        console.warn(
          `[export] reframe detection failed; falling back to center-crop: ${
            e instanceof Error ? e.message : String(e)
          }`
        )
      }
    }

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
        keepRanges
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
      signal: ctx.signal
    })

    emit.progress(100, 'encoding')
    return {
      outputPath: result.outputPath,
      width: result.width,
      height: result.height,
      durationMs: result.durationMs
    }
  }
}

/** The default runner using the real export service (registered in ipc/video.ts). */
export const exportRunner: JobRunner<'export'> = createExportRunner()
