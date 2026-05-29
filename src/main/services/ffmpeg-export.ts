/**
 * src/main/services/ffmpeg-export.ts — frame-accurate cut + 9:16 reframe +
 * re-encode (EXPORT spine, plan E.5 / PRD §6.5/§6.9 / Appendix A).
 *
 * Composes on the trunk's frozen `ffmpeg-core` (`runFfmpeg` + the stderr→progress
 * parser) — never re-implements spawning. Re-exported through the `ffmpeg.ts`
 * barrel so consumers `import { exportClip } from '@main/services/ffmpeg'`.
 *
 * VERIFIED command (PRD Appendix A, confirmed empirically on ffmpeg-static which
 * HAS h264_videotoolbox + libass):
 *
 *   ffmpeg -ss <start> -i src -to <relEnd> \
 *     -vf "crop=ih*9/16:ih,scale=1080:1920" \
 *     -c:v h264_videotoolbox -b:v 8M -c:a aac out.mp4
 *
 * Frame accuracy (PRD §6.6, §18): the cut is a RE-ENCODE, NOT `-c copy`. With
 * `-ss` BEFORE `-i` ffmpeg seeks then decodes from the nearest keyframe and
 * re-encodes from the exact requested time, so the output's first-frame PTS is 0
 * and its duration is the requested span within ±1 frame (verified: a 2.5s cut
 * of a 30fps source → exactly 75 frames, 1080×1920, h264, PTS 0). `-to` AFTER
 * `-i` (with `-ss` before `-i`) is a DURATION relative to the seek point — so we
 * pass `end - start`, never the absolute end (a common ffmpeg footgun).
 *
 * CAPTION-BURN SEAM (plan E.5, fix M3 — note for the caption-burn stage): the
 * caption stage inserts a `subtitles=<ass>:fontsdir=<dir>` filter at the END of
 * this filtergraph, i.e. `crop=…,scale=…,subtitles=…:fontsdir=…`. `buildVf()`
 * already accepts an optional `assPath`/`fontsDir` and appends exactly that node
 * (proven filtergraph order from the Stage-4 libass smoke). When wired, the
 * caption stage passes `assPath` through `ExportClipOptions` — no other change.
 */

import { runFfmpeg, type RunFfmpegOptions } from './ffmpeg-core'
import type { AspectRatio } from '@shared/schema'
import { keptDuration, removesAnything, type Range } from '@shared/keep-ranges'
import type { ReframePlan } from '@shared/reframe-plan'

// ============================================================================
// Pure arg building (unit-tested without a real binary — PRD §18)
// ============================================================================

/** Target output dimensions for a given aspect ratio (width × height, 1080-wide family). */
export interface OutputDimensions {
  width: number
  height: number
}

/**
 * Map an aspect ratio to its export output dimensions (PRD §6.5: 9:16 default;
 * 1:1 and 4:5 also supported in MVP; 16:9 kept for completeness).
 *   9:16 → 1080×1920 · 1:1 → 1080×1080 · 4:5 → 1080×1350 · 16:9 → 1920×1080
 */
export function outputDimensions(aspect: AspectRatio): OutputDimensions {
  switch (aspect) {
    case '9:16':
      return { width: 1080, height: 1920 }
    case '1:1':
      return { width: 1080, height: 1080 }
    case '4:5':
      return { width: 1080, height: 1350 }
    case '16:9':
      return { width: 1920, height: 1080 }
  }
}

/**
 * The center-crop expression for a target aspect ratio, cropping the SOURCE to
 * the target ratio about its center before scaling. For 9:16: `crop=ih*9/16:ih`
 * (PRD Appendix A) — crop a 9:16-wide column the full source height. Generalized
 * per ratio so 1:1 / 4:5 / 16:9 also center-crop correctly.
 */
export function cropExpr(aspect: AspectRatio): string {
  switch (aspect) {
    case '9:16':
      return 'crop=ih*9/16:ih'
    case '1:1':
      return 'crop=ih:ih'
    case '4:5':
      return 'crop=ih*4/5:ih'
    case '16:9':
      return 'crop=iw:iw*9/16'
  }
}

export interface BuildVfOptions {
  aspectRatio: AspectRatio
  /**
   * If set, a libass `.ass` file to burn — appended as the FINAL filter node so
   * captions are rendered AFTER the crop/scale (the proven order, fix M3). The
   * caption-burn stage passes this through; export alone leaves it undefined.
   */
  assPath?: string
  /** fontsdir for libass so a bundled font resolves deterministically (fix M3). */
  fontsDir?: string
  /**
   * Auto-reframe decision (Part J). When present (and NOT `split`), the
   * face-aware crop node REPLACES the center-crop `cropExpr(aspect)`:
   *  - `static` → `crop=cropW:cropH:x=cropX:y=0` (fixed face-centered column).
   *  - `pan`    → `crop=cropW:cropH:x='<xExpr>':y=0` (the expr is single-quoted so
   *    its commas read as literal to the filtergraph, not as filter separators).
   * `split` is NOT representable in a single `-vf` chain (it needs a
   * `filter_complex` vstack), so it falls back to the center-crop here and is
   * rendered by `exportClipArgsSplit`. `null`/absent ⇒ the center-crop.
   */
  reframePlan?: ReframePlan | null
}

/**
 * Build the crop node for the `-vf`/`vchain` (the node that produces the 9:16
 * column before `scale`). A `static`/`pan` `ReframePlan` yields a face-aware
 * absolute-pixel crop; everything else (no plan, or a `split` plan that the
 * single-chain path can't render) falls back to the center-crop `cropExpr`.
 *
 * The `pan` `xExpr` is single-quoted so the commas inside `min(...)`/`max(...)`
 * are literal to the filtergraph parser rather than filter-chain separators.
 */
export function reframeCropNode(aspect: AspectRatio, plan?: ReframePlan | null): string {
  if (plan && plan.mode === 'static') {
    return `crop=${plan.cropW}:${plan.cropH}:x=${plan.cropX}:y=0`
  }
  if (plan && plan.mode === 'pan') {
    return `crop=${plan.cropW}:${plan.cropH}:x='${plan.xExpr}':y=0`
  }
  return cropExpr(aspect)
}

/**
 * Build the `-vf` filtergraph string: `<crop>,scale=W:H[,subtitles=…:fontsdir=…]`.
 * The optional subtitles node is appended LAST (the caption-burn seam). Paths
 * inside the `subtitles=` filter are escaped for the filtergraph mini-language.
 *
 * When a `static`/`pan` `reframePlan` is supplied, the face-aware crop node
 * REPLACES the center-crop (`scale` + optional subtitles still follow). A
 * `split` plan (or no plan) keeps the center-crop here.
 */
export function buildVf(opts: BuildVfOptions): string {
  const { width, height } = outputDimensions(opts.aspectRatio)
  const nodes = [reframeCropNode(opts.aspectRatio, opts.reframePlan), `scale=${width}:${height}`]
  if (opts.assPath) {
    let sub = `subtitles=${escapeFilterPath(opts.assPath)}`
    if (opts.fontsDir) sub += `:fontsdir=${escapeFilterPath(opts.fontsDir)}`
    nodes.push(sub)
  }
  return nodes.join(',')
}

/**
 * Escape a filesystem path for use as a value inside an FFmpeg `-vf` filtergraph
 * (the `subtitles=` source). FFmpeg's filtergraph parser treats `:` `'` `\` `[`
 * `]` `,` `;` specially; libass burns are the only place we embed a path, so we
 * backslash-escape the characters that would otherwise break the graph.
 */
export function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

/** Video-bitrate target per quality preset (PRD §6.9 quality presets). */
export function videoBitrate(quality: '720p' | '1080p'): string {
  return quality === '720p' ? '5M' : '8M'
}

export interface ExportArgsOptions {
  sourcePath: string
  outputPath: string
  /** Absolute seconds into the source where the clip starts. */
  startTime: number
  /** Absolute seconds into the source where the clip ends. */
  endTime: number
  aspectRatio: AspectRatio
  quality: '720p' | '1080p'
  /** Optional libass `.ass` to burn (caption-burn seam, fix M3). */
  assPath?: string
  /** fontsdir for libass (caption-burn seam). */
  fontsDir?: string
  /**
   * Use the CPU encoder (libx264) instead of h264_videotoolbox (PRD §14 GPU
   * fallback / Settings "force CPU"). Default false → videotoolbox on macOS.
   */
  forceCpu?: boolean
  /**
   * Silence/filler jump-cut keep ranges (Part I.4 — ABSOLUTE source seconds). When
   * present AND they actually drop something, the export uses a multi-range
   * select+concat filtergraph instead of the single `-ss/-to` cut; the burned
   * captions must already be on the COMPRESSED timeline (export-runner remaps).
   */
  keepRanges?: Range[]
  /**
   * Auto-reframe decision (Part J). When present (and NOT `split`), the
   * face-aware crop REPLACES the center-crop in whichever path runs (single
   * `-ss/-to` cut OR the multi-range jump-cut chain). A `split` plan routes
   * `exportClip` to the dedicated `filter_complex` vstack path
   * (`exportClipArgsSplit`). Absent/`null` ⇒ the static center-crop.
   *
   * The `static`/`pan` crop reads the SOURCE timestamp `t`, so it composes both
   * with the single-cut `-ss/-to` and with `select,setpts` (the crop is placed
   * AFTER `select,setpts`, evaluated per kept frame at its source `t`).
   */
  reframePlan?: ReframePlan | null
}

/**
 * Build the verified frame-accurate cut + reframe + re-encode argv.
 *
 *   -ss <start> -i src -to <end-start> -vf "<crop>,scale=W:H[,subtitles=…]"
 *   -c:v h264_videotoolbox -b:v <q> -c:a aac -movflags +faststart out
 *
 * `-ss` is placed BEFORE `-i` (fast keyframe seek + re-encode for accuracy) and
 * `-to` AFTER `-i` is the clip DURATION relative to the seek point (NOT the
 * absolute end). `-progress pipe:2 -nostats` lets ffmpeg-core parse progress.
 * Throws if the resolved span is non-positive (caller surfaces INPUT_INVALID).
 */
export function exportClipArgs(opts: ExportArgsOptions): string[] {
  const duration = opts.endTime - opts.startTime
  if (!(duration > 0)) {
    throw new Error(
      `ffmpeg-export: non-positive clip span (start=${opts.startTime}, end=${opts.endTime})`
    )
  }
  const codecArgs = opts.forceCpu
    ? ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18']
    : ['-c:v', 'h264_videotoolbox', '-b:v', videoBitrate(opts.quality)]

  return [
    '-hide_banner',
    '-y',
    // fast keyframe seek BEFORE -i, then re-encode from the exact time:
    '-ss',
    String(opts.startTime),
    '-i',
    opts.sourcePath,
    // duration relative to the seek point (frame-accurate cut):
    '-to',
    String(duration),
    '-vf',
    buildVf({
      aspectRatio: opts.aspectRatio,
      assPath: opts.assPath,
      fontsDir: opts.fontsDir,
      reframePlan: opts.reframePlan
    }),
    ...codecArgs,
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    // streaming-friendly mp4 (moov atom up front) so the export is web-playable:
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:2',
    '-nostats',
    opts.outputPath
  ]
}

/**
 * Build the multi-range (silence-removed) cut argv (Part I.4). Instead of a
 * single `-ss/-to`, a `select`/`aselect` filtergraph keeps only the kept spans
 * and `setpts`/`asetpts` re-stamp them into one continuous timeline; the same
 * crop+scale[+subtitles] chain then runs on the compressed video. Keep ranges are
 * ABSOLUTE source seconds, so the `between(t,…)` predicates match the source `t`.
 *
 *   ffmpeg -i src -filter_complex
 *     "[0:v]select='between(t,a,b)+…',setpts=N/FRAME_RATE/TB,<crop>,scale=W:H[,subtitles=…][v];
 *      [0:a]aselect='between(t,a,b)+…',asetpts=N/SR/TB[a]"
 *     -map [v] -map [a] -c:v … -c:a aac -movflags +faststart out
 *
 * TRADE-OFFS (documented, acceptable for the opt-in feature):
 *   - No `-ss`: `between(t,…)` predicates reference absolute source `t`, so the
 *     source is decoded from 0 (the single-range path's fast keyframe seek isn't
 *     available here). Cost scales with the clip's distance into the source.
 *   - `setpts=N/FRAME_RATE/TB` re-stamps to a continuous CFR timeline; video and
 *     audio are re-stamped independently from their own selected-frame counts, so
 *     a tiny per-cut A/V skew can accumulate over MANY cuts / on VFR input. Fine
 *     for typical re-encoded short-form sources; not frame-exact across cuts.
 */
export function exportClipArgsMultiRange(opts: ExportArgsOptions): string[] {
  const keep = opts.keepRanges ?? []
  if (keep.length === 0) {
    throw new Error('ffmpeg-export: exportClipArgsMultiRange requires non-empty keepRanges')
  }
  const { width, height } = outputDimensions(opts.aspectRatio)
  // `+`-joined OR of the kept spans; single-quoted so the commas are literal to
  // the filtergraph parser (not filter separators).
  const between = keep.map(([a, b]) => `between(t,${a},${b})`).join('+')
  // The reframe crop (static/pan) goes AFTER `select,setpts`: `crop`'s `t` is the
  // SOURCE timestamp of each kept frame, so a `pan` expr in source `t` stays
  // correct even though `setpts` re-stamps the OUTPUT timeline. No plan / a
  // `split` plan ⇒ the center-crop (split is rendered by exportClipArgsSplit).
  const crop = reframeCropNode(opts.aspectRatio, opts.reframePlan)
  let vchain = `[0:v]select='${between}',setpts=N/FRAME_RATE/TB,${crop},scale=${width}:${height}`
  if (opts.assPath) {
    vchain += `,subtitles=${escapeFilterPath(opts.assPath)}`
    if (opts.fontsDir) vchain += `:fontsdir=${escapeFilterPath(opts.fontsDir)}`
  }
  vchain += '[v]'
  const achain = `[0:a]aselect='${between}',asetpts=N/SR/TB[a]`
  const codecArgs = opts.forceCpu
    ? ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18']
    : ['-c:v', 'h264_videotoolbox', '-b:v', videoBitrate(opts.quality)]
  return [
    '-hide_banner',
    '-y',
    '-i',
    opts.sourcePath,
    '-filter_complex',
    `${vchain};${achain}`,
    '-map',
    '[v]',
    '-map',
    '[a]',
    ...codecArgs,
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:2',
    '-nostats',
    opts.outputPath
  ]
}

/**
 * Build the SPLIT-screen (2-up) argv (Part J). A `split` `ReframePlan` can't be
 * rendered in a single `-vf` chain — it needs a `filter_complex` that forks the
 * (optionally jump-cut) video into two crops and `vstack`s them into one 9:16
 * frame. Each tile is a 1080×960 half; stacked → 1080×1920 (PRD §6.5 9:16).
 *
 *   ffmpeg -i src -filter_complex
 *     "[0:v][,select='…',setpts=…]split=2[l][r];
 *      [l]crop=<region0>,scale=1080:960[lv];
 *      [r]crop=<region1>,scale=1080:960[rv];
 *      [lv][rv]vstack=inputs=2[,subtitles=…:fontsdir=…][v];
 *      [0:a][aselect='…',asetpts=…][a]"
 *     -map [v] -map [a] -c:v … -c:a aac -movflags +faststart out
 *
 * When `keepRanges` actually drop something, the same `select/setpts` (video) and
 * `aselect/asetpts` (audio) jump-cut nodes run BEFORE the split (video) / on the
 * audio chain; the region crops then read each kept frame's SOURCE `t`. With no
 * removing keepRanges the video forks straight from `[0:v]` and audio maps `0:a`.
 * Subtitles (compressed-timeline `.ass`) burn AFTER the `vstack`, the proven
 * caption-burn order (fix M3). Throws if the plan is not a `split`.
 */
export function exportClipArgsSplit(opts: ExportArgsOptions): string[] {
  const plan = opts.reframePlan
  if (!plan || plan.mode !== 'split') {
    throw new Error('ffmpeg-export: exportClipArgsSplit requires a split ReframePlan')
  }
  const [r0, r1] = plan.regions
  // Each tile fills the top/bottom 1080×960 half of the 1080×1920 9:16 output.
  const TILE_W = 1080
  const TILE_H = 960

  // Jump-cut (Part I.4): only when the kept ranges actually drop something. The
  // select/setpts run BEFORE the split so the forked tiles share one compressed
  // timeline; the audio is selected in lock-step (else mapped straight from 0:a).
  const keep = opts.keepRanges ?? []
  const removing = keep.length > 0 && removesAnything(keep, opts.startTime, opts.endTime)
  const between = removing ? keep.map(([a, b]) => `between(t,${a},${b})`).join('+') : ''
  const vSelect = removing ? `select='${between}',setpts=N/FRAME_RATE/TB,` : ''

  const cropNode = (r: typeof r0): string => `crop=${r.cropW}:${r.cropH}:x=${r.cropX}:y=${r.cropY}`

  // [0:v] → (optional select) → split into two; each half crop+scale to a tile.
  let fc =
    `[0:v]${vSelect}split=2[l][r];` +
    `[l]${cropNode(r0)},scale=${TILE_W}:${TILE_H}[lv];` +
    `[r]${cropNode(r1)},scale=${TILE_W}:${TILE_H}[rv];` +
    `[lv][rv]vstack=inputs=2`
  // Burn captions AFTER the vstack (the proven order, fix M3).
  if (opts.assPath) {
    fc += `,subtitles=${escapeFilterPath(opts.assPath)}`
    if (opts.fontsDir) fc += `:fontsdir=${escapeFilterPath(opts.fontsDir)}`
  }
  fc += '[v]'
  // Audio: selected in lock-step when jump-cutting, else mapped straight.
  const aMap = removing ? '[a]' : '0:a'
  if (removing) fc += `;[0:a]aselect='${between}',asetpts=N/SR/TB[a]`

  const codecArgs = opts.forceCpu
    ? ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18']
    : ['-c:v', 'h264_videotoolbox', '-b:v', videoBitrate(opts.quality)]
  return [
    '-hide_banner',
    '-y',
    '-i',
    opts.sourcePath,
    '-filter_complex',
    fc,
    '-map',
    '[v]',
    '-map',
    aMap,
    ...codecArgs,
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:2',
    '-nostats',
    opts.outputPath
  ]
}

export interface ThumbnailArgsOptions {
  sourcePath: string
  outputPath: string
  /** Absolute seconds to grab the single frame at. */
  atTime: number
  aspectRatio: AspectRatio
}

/**
 * Build the single-frame thumbnail argv (PRD Appendix A `-vframes 1`), reframed
 * to the same aspect ratio as the export so the thumbnail matches the clip.
 *   ffmpeg -ss <t> -i src -vframes 1 -vf "<crop>,scale=W:H" thumb.jpg
 */
export function thumbnailArgs(opts: ThumbnailArgsOptions): string[] {
  return [
    '-hide_banner',
    '-y',
    '-ss',
    String(opts.atTime),
    '-i',
    opts.sourcePath,
    '-vframes',
    '1',
    '-vf',
    buildVf({ aspectRatio: opts.aspectRatio }),
    opts.outputPath
  ]
}

// ============================================================================
// Spawn-driven export (composes ffmpeg-core)
// ============================================================================

export interface ExportClipOptions extends ExportArgsOptions {
  /** Total clip duration (s) used to compute 0..100 progress (= end - start). */
  onProgress?: (pct: number) => void
  /** Cooperative cancel (SIGKILLs the ffmpeg child). */
  signal?: AbortSignal
  /** Override the ffmpeg binary (tests / smoke). */
  binPath?: string
}

export interface ExportClipResult {
  outputPath: string
  width: number
  height: number
  /** The requested span duration in milliseconds (the cut length). */
  durationMs: number
}

/**
 * Run the frame-accurate cut + 9:16 reframe + re-encode, streaming progress, and
 * resolve with the output path + dimensions + duration (the JobResult['export']
 * body). Rejects on a non-zero ffmpeg exit (the runner maps it to a typed error).
 */
export async function exportClip(opts: ExportClipOptions): Promise<ExportClipResult> {
  // Jump-cut path (Part I.4): only when keep ranges actually drop something —
  // otherwise the cheaper single `-ss/-to` cut. The output (and progress total)
  // is the COMPRESSED kept duration, not the original span.
  const jumpCut =
    !!opts.keepRanges && removesAnything(opts.keepRanges, opts.startTime, opts.endTime)
  // Path selection (Part J): a `split` plan ⇒ the dedicated 2-up `filter_complex`
  // (it folds in the jump-cut select/setpts itself); else jump-cut ⇒ the
  // multi-range select+concat chain (reframe crop composed in); else the single
  // `-ss/-to` cut (reframe crop in the single `-vf`). A `static`/`pan` plan rides
  // along whichever of the latter two runs.
  const split = opts.reframePlan?.mode === 'split'
  const args = split
    ? exportClipArgsSplit(opts)
    : jumpCut
      ? exportClipArgsMultiRange(opts)
      : exportClipArgs(opts)
  // Split always renders a 1080×1920 (9:16) 2-up frame; otherwise the aspect's
  // output size. The reported result dims drive thumbnails/UI — keep them honest.
  const { width, height } = split
    ? { width: 1080, height: 1920 }
    : outputDimensions(opts.aspectRatio)
  const durationSec = jumpCut ? keptDuration(opts.keepRanges!) : opts.endTime - opts.startTime

  const runOpts: RunFfmpegOptions = {
    args,
    totalDurationSec: durationSec,
    binPath: opts.binPath,
    signal: opts.signal,
    onProgress: (pct) => {
      if (pct !== undefined) opts.onProgress?.(pct)
    }
  }
  await runFfmpeg(runOpts)

  return {
    outputPath: opts.outputPath,
    width,
    height,
    durationMs: Math.round(durationSec * 1000)
  }
}

/**
 * Grab a single reframed thumbnail frame (PRD Appendix A). Resolves with the
 * thumbnail path on success; rejects on a non-zero ffmpeg exit.
 */
export async function generateThumbnail(
  opts: ThumbnailArgsOptions & { signal?: AbortSignal; binPath?: string }
): Promise<{ thumbnailPath: string }> {
  await runFfmpeg({
    args: thumbnailArgs(opts),
    binPath: opts.binPath,
    signal: opts.signal
  })
  return { thumbnailPath: opts.outputPath }
}
