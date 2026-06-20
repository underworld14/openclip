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

import { rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, basename, join } from 'node:path'
import { runFfmpeg as defaultRunFfmpeg, type RunFfmpegOptions } from './ffmpeg-core'
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
 * Escape a filesystem path for use as a value inside an FFmpeg `-vf`/
 * `filter_complex` filtergraph (the `subtitles=`/`fontsdir=` source). Embedding a
 * path in a filtergraph crosses TWO escaping levels (FFmpeg "Quoting and escaping":
 * filter-option-value `\` `:` `'`, AND the filtergraph level where `,` `;` `[` `]`
 * separate filters/chains/labels), so we backslash-escape the FULL set — an ordinary
 * macOS path like `/Users/x/My [Clips]/a, b/clip.ass` would otherwise split the graph
 * and break the burn (audit fix openclip-5ir/uas). `\` is escaped FIRST so the
 * backslashes we add aren't themselves re-escaped.
 */
export function escapeFilterPath(p: string): string {
  return p
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
}

/** Video-bitrate target per quality preset (PRD §6.9 quality presets). */
export function videoBitrate(quality: '720p' | '1080p'): string {
  return quality === '720p' ? '5M' : '8M'
}

/**
 * libx264 CRF per quality preset (lower = higher quality). The CPU fallback path
 * must honour the chosen quality (audit fix openclip-ixa) — it previously pinned
 * CRF 18 for every export, so a 720p "force CPU" clip came out near-1080p sized.
 * Tuned to roughly track the videotoolbox bitrate targets: 720p→23, 1080p→18.
 */
export function x264Crf(quality: '720p' | '1080p'): string {
  return quality === '720p' ? '23' : '18'
}

/**
 * The `-c:v …`/bitrate args for the chosen encoder, shared by all three argv
 * builders (audit fix openclip-6fz, previously copy-pasted 3×). Both branches now
 * pin `-pix_fmt yuv420p` (audit fix openclip-ucs): a 10-bit / 4:2:2 source would
 * otherwise re-encode into a clip that QuickTime/Safari and Instagram/TikTok upload
 * paths refuse or mis-render. It's a no-op for already-8-bit-4:2:0 sources.
 */
export function codecArgs(opts: Pick<ExportArgsOptions, 'forceCpu' | 'quality'>): string[] {
  return opts.forceCpu
    ? ['-c:v', 'libx264', '-preset', 'medium', '-crf', x264Crf(opts.quality), '-pix_fmt', 'yuv420p']
    : ['-c:v', 'h264_videotoolbox', '-b:v', videoBitrate(opts.quality), '-pix_fmt', 'yuv420p']
}

/**
 * The shared audio + container + progress tail ending in the output path (audit fix
 * openclip-6fz — previously repeated verbatim in all three builders): AAC 192k, a
 * faststart mp4 (moov atom up front, web-playable), and `-progress pipe:2 -nostats`
 * so ffmpeg-core's stderr parser can stream progress.
 */
export function outputTailArgs(outputPath: string): string[] {
  return [
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:2',
    '-nostats',
    outputPath
  ]
}

// ============================================================================
// Logo overlay (Part K — brand kit). The logo is a 2nd input (`[1:v]`) scaled to
// `logoScale * outputWidth` and composited by an `overlay` node placed AFTER the
// crop/scale (or vstack) and BEFORE the caption `subtitles` burn (PRD §6.5).
// EVERYTHING is gated behind `logoPath`: with no logo the export argv is
// BYTE-IDENTICAL to today (no 2nd `-i`, no `filter_complex` for the single cut).
// ============================================================================

export type LogoPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

/** Brand-kit logo defaults (mirror `brandLogoParams` in the renderer). */
export const DEFAULT_LOGO_POSITION: LogoPosition = 'bottom-right'
export const DEFAULT_LOGO_SCALE = 0.18
export const DEFAULT_LOGO_MARGIN = 48

export interface LogoOverlayOptions {
  /** Absolute path to a PNG-with-alpha. Absent ⇒ no overlay (argv unchanged). */
  logoPath?: string
  /** Corner to pin the logo to (default `bottom-right`). */
  logoPosition?: LogoPosition
  /** Logo width as a fraction of the output width (default 0.18). */
  logoScale?: number
  /** Inset from the chosen corner in output pixels (default 48). */
  logoMargin?: number
}

/**
 * The `overlay=x:y` expression for a corner, using the overlay filter's built-in
 * dims (`W`/`H` = main video, `w`/`h` = the scaled logo) so we never need the
 * logo's intrinsic pixel size:
 *   top-left → M:M · top-right → W-w-M:M · bottom-left → M:H-h-M · bottom-right → W-w-M:H-h-M
 */
function overlayXY(position: LogoPosition, margin: number): string {
  switch (position) {
    case 'top-left':
      return `${margin}:${margin}`
    case 'top-right':
      return `W-w-${margin}:${margin}`
    case 'bottom-left':
      return `${margin}:H-h-${margin}`
    case 'bottom-right':
      return `W-w-${margin}:H-h-${margin}`
  }
}

interface ResolvedLogo {
  /** Extra ffmpeg input args (`['-i', logoPath]`), inserted right after the source. */
  input: string[]
  /** The scale node producing `[logo]`, e.g. `[1:v]scale=194:-1[logo]`. */
  scaleNode: string
  /** The `overlay=` x:y expression for the chosen corner. */
  xy: string
}

/**
 * Resolve the logo overlay pieces for a `filter_complex`, or `null` when no logo.
 * `outW` is the final output width (logo width = round(outW * logoScale)).
 * `inputIndex` is the ffmpeg input index of the logo (always 1 — the single
 * source video is input 0). The logo path rides as a plain argv token (NOT a
 * filtergraph value), so it is NOT filter-escaped.
 */
export function resolveLogo(
  opts: LogoOverlayOptions,
  outW: number,
  inputIndex = 1
): ResolvedLogo | null {
  if (!opts.logoPath) return null
  const scale = opts.logoScale ?? DEFAULT_LOGO_SCALE
  const margin = opts.logoMargin ?? DEFAULT_LOGO_MARGIN
  const position = opts.logoPosition ?? DEFAULT_LOGO_POSITION
  const logoW = Math.max(1, Math.round(outW * scale))
  return {
    input: ['-i', opts.logoPath],
    scaleNode: `[${inputIndex}:v]scale=${logoW}:-1[logo]`,
    xy: overlayXY(position, margin)
  }
}

/**
 * Compose the trailing `overlay` + `subtitles` nodes onto a base video chain to
 * produce the full `filter_complex` video graph (ending in the `[v]` output) plus
 * any extra input args the overlay needs.
 *
 * `baseChain` is a filtergraph fragment ending in the pre-overlay video WITHOUT
 * its output label (e.g. `[0:v]crop,scale=W:H` or `…vstack=inputs=2`).
 *
 * Invariant: when `logo` is null this reproduces the SAME single comma-chain the
 * builders emitted before (subtitles appended inline, then `[v]`), so a no-logo
 * graph is byte-identical and `extraInputs` is empty.
 */
function composeVideoGraph(
  baseChain: string,
  logo: ResolvedLogo | null,
  assPath: string | undefined,
  fontsDir: string | undefined
): { graph: string; extraInputs: string[] } {
  const subtitlesNode = (inLabel: string): string => {
    let s = `[${inLabel}]subtitles=${escapeFilterPath(assPath!)}`
    if (fontsDir) s += `:fontsdir=${escapeFilterPath(fontsDir)}`
    return s + '[v]'
  }
  if (!logo) {
    // No logo: the proven single comma-chain (subtitles appended inline) → [v].
    let chain = baseChain
    if (assPath) {
      chain += `,subtitles=${escapeFilterPath(assPath)}`
      if (fontsDir) chain += `:fontsdir=${escapeFilterPath(fontsDir)}`
    }
    return { graph: `${chain}[v]`, extraInputs: [] }
  }
  // Logo: label the base, scale the logo, overlay AFTER crop/scale (or vstack),
  // THEN the optional subtitles burn — preserving the proven node order.
  const nodes = [`${baseChain}[vbase]`, logo.scaleNode]
  if (assPath) {
    nodes.push(`[vbase][logo]overlay=${logo.xy}[vov]`)
    nodes.push(subtitlesNode('vov'))
  } else {
    nodes.push(`[vbase][logo]overlay=${logo.xy}[v]`)
  }
  return { graph: nodes.join(';'), extraInputs: logo.input }
}

export interface ExportArgsOptions extends LogoOverlayOptions {
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
  // Brand-kit logo (Part K): an overlay needs the logo as a 2nd input, which a
  // simple `-vf` chain can't express — so a logo SWITCHES this path to a
  // `filter_complex` (+ explicit `-map [v] -map 0:a`). With NO logo we keep the
  // exact `-vf` argv (byte-identical to today; the golden test guards it).
  const { width, height } = outputDimensions(opts.aspectRatio)
  const logo = resolveLogo(opts, width)
  if (logo) {
    const baseChain = `[0:v]${reframeCropNode(opts.aspectRatio, opts.reframePlan)},scale=${width}:${height}`
    const { graph, extraInputs } = composeVideoGraph(baseChain, logo, opts.assPath, opts.fontsDir)
    return [
      '-hide_banner',
      '-y',
      '-ss',
      String(opts.startTime),
      '-i',
      opts.sourcePath,
      // 2nd input: the logo PNG (not seeked — the -ss above binds to the source).
      ...extraInputs,
      '-to',
      String(duration),
      '-filter_complex',
      graph,
      '-map',
      '[v]',
      '-map',
      '0:a',
      ...codecArgs(opts),
      ...outputTailArgs(opts.outputPath)
    ]
  }

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
    ...codecArgs(opts),
    ...outputTailArgs(opts.outputPath)
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
  const duration = opts.endTime - opts.startTime
  // `-ss` BEFORE `-i` rebases the decoded timeline to 0-based CLIP-RELATIVE time
  // (like the single-cut path), so the keep ranges become clip-relative AND the
  // reframe crop runs in the same time base the planner authored. `+`-joined OR of
  // the kept spans; single-quoted so the commas stay literal to the filtergraph.
  const rel = (n: number): number => Math.round((n - opts.startTime) * 1000) / 1000
  const between = keep.map(([a, b]) => `between(t,${rel(a)},${rel(b)})`).join('+')
  // INVARIANT (audit fix openclip-dwu — do NOT reorder): the reframe crop MUST
  // precede `select` so a `pan` xExpr is evaluated against the UNcompressed
  // clip-relative source `t` the planner authored. Moving the crop AFTER select (to
  // match the silence-removal mental model) would feed the xExpr the compressed
  // timeline and mis-time every pan keyframe — a silent correctness regression.
  // `select` then drops the silence frames and `setpts` re-stamps the survivors to
  // a compressed 0-based output (audio `aselect`'d in lock-step). static/center
  // crops are constant, so the ordering is harmless for them.
  const crop = reframeCropNode(opts.aspectRatio, opts.reframePlan)
  const baseChain = `[0:v]${crop},select='${between}',setpts=N/FRAME_RATE/TB,scale=${width}:${height}`
  // Brand-kit logo (Part K): overlay AFTER scale, BEFORE subtitles. No logo ⇒ the
  // graph is the same single comma-chain as before (and no 2nd `-i`).
  const logo = resolveLogo(opts, width)
  const { graph: vchain, extraInputs } = composeVideoGraph(
    baseChain,
    logo,
    opts.assPath,
    opts.fontsDir
  )
  const achain = `[0:a]aselect='${between}',asetpts=N/SR/TB[a]`
  return [
    '-hide_banner',
    '-y',
    '-ss',
    String(opts.startTime),
    '-i',
    opts.sourcePath,
    ...extraInputs,
    '-t',
    String(duration),
    '-filter_complex',
    `${vchain};${achain}`,
    '-map',
    '[v]',
    '-map',
    '[a]',
    ...codecArgs(opts),
    ...outputTailArgs(opts.outputPath)
  ]
}

/**
 * Build the SPLIT-screen (2-up) argv (Part J). A `split` `ReframePlan` can't be
 * rendered in a single `-vf` chain — it needs a `filter_complex` that forks the
 * (optionally jump-cut) video into two crops and `vstack`s them into one frame of
 * the CHOSEN aspect. Each tile is a full-width × half-height half of
 * `outputDimensions(aspect)`; stacked → that aspect's output size (audit fix
 * openclip-omd; default 9:16 → two 1080×960 tiles → 1080×1920).
 *
 *   ffmpeg -ss <start> -i src -t <dur> -filter_complex
 *     "[0:v][,select='…',setpts=…]split=2[l][r];
 *      [l]crop=<region0>,scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960[lv];
 *      [r]crop=<region1>,scale=1080:960:…,crop=1080:960[rv];
 *      [lv][rv]vstack=inputs=2[,subtitles=…:fontsdir=…][v];
 *      [0:a][aselect='…',asetpts=…][a]"
 *     -map [v] -map [a] -c:v … -c:a aac -movflags +faststart out
 *
 * `-ss`/`-t` BOUND the encode to the clip span (without them the split re-encoded
 * the WHOLE source) and rebase the timeline to 0-based CLIP-RELATIVE. When
 * `keepRanges` drop something, `select/setpts` (video) + `aselect/asetpts` (audio)
 * jump-cut nodes run on that clip-relative timeline (start-subtracted ranges); with
 * no removing keepRanges the video forks straight from `[0:v]` and audio maps `0:a`.
 * Each tile cover-fits its half (scale-up-then-center-crop) so an off-ratio cluster
 * box isn't distorted. Subtitles (compressed `.ass`) burn AFTER the `vstack` (fix
 * M3). Throws if the plan is not a `split`.
 */
export function exportClipArgsSplit(opts: ExportArgsOptions): string[] {
  const plan = opts.reframePlan
  if (!plan || plan.mode !== 'split') {
    throw new Error('ffmpeg-export: exportClipArgsSplit requires a split ReframePlan')
  }
  const [r0, r1] = plan.regions
  // Each tile fills the top/bottom half of the CHOSEN aspect's output (audit fix
  // openclip-omd): full output width × half its height, vstacked → the full output
  // size. Previously hard-coded 1080×960 (9:16) so a 4:5/1:1/16:9 split silently
  // produced a 9:16 file with wrong reported dims. Every output height is even, so
  // TILE_H = height/2 is integral and 2× sums back to the exact output height; the
  // ENCODED vstack frame is even on both axes (required by yuv420p) even where a
  // tile is odd (4:5 → 1080×675 tiles → an even 1080×1350) — intermediate filter
  // tiles aren't encoded, so their odd height is harmless.
  const { width: TILE_W, height: outH } = outputDimensions(opts.aspectRatio)
  const TILE_H = outH / 2
  const duration = opts.endTime - opts.startTime

  // Jump-cut (Part I.4): only when the kept ranges actually drop something. The
  // select/setpts run BEFORE the split so the forked tiles share one compressed
  // timeline; the audio is selected in lock-step (else mapped straight from 0:a).
  // `-ss`/`-t` (below) bound the encode to the clip span and rebase the decoded
  // timeline to 0-based CLIP-RELATIVE time, so the keep ranges are start-subtracted.
  const keep = opts.keepRanges ?? []
  const removing = keep.length > 0 && removesAnything(keep, opts.startTime, opts.endTime)
  const rel = (n: number): number => Math.round((n - opts.startTime) * 1000) / 1000
  const between = removing ? keep.map(([a, b]) => `between(t,${rel(a)},${rel(b)})`).join('+') : ''
  const vSelect = removing ? `select='${between}',setpts=N/FRAME_RATE/TB,` : ''

  // Crop the cluster region, then COVER-fit the tile (scale up preserving aspect →
  // center-crop to exactly the tile) so an off-ratio cluster box isn't distorted.
  const cropNode = (r: typeof r0): string =>
    `crop=${r.cropW}:${r.cropH}:x=${r.cropX}:y=${r.cropY},` +
    `scale=${TILE_W}:${TILE_H}:force_original_aspect_ratio=increase,crop=${TILE_W}:${TILE_H}`

  // [0:v] → (optional select) → split into two; each half crop+cover-fit to a tile.
  const baseChain =
    `[0:v]${vSelect}split=2[l][r];` +
    `[l]${cropNode(r0)}[lv];` +
    `[r]${cropNode(r1)}[rv];` +
    `[lv][rv]vstack=inputs=2`
  // Brand-kit logo (Part K): overlay AFTER the vstack, BEFORE the subtitles burn.
  // The stacked frame is always 1080 wide, so scale the logo against TILE_W. No
  // logo ⇒ captions append inline to the vstack exactly as before (byte-identical).
  const logo = resolveLogo(opts, TILE_W)
  const { graph: vgraph, extraInputs } = composeVideoGraph(
    baseChain,
    logo,
    opts.assPath,
    opts.fontsDir
  )
  let fc = vgraph
  // Audio: selected in lock-step when jump-cutting, else mapped straight.
  const aMap = removing ? '[a]' : '0:a'
  if (removing) fc += `;[0:a]aselect='${between}',asetpts=N/SR/TB[a]`

  return [
    '-hide_banner',
    '-y',
    // Bound the encode to the clip span (was MISSING → encoded the whole source).
    '-ss',
    String(opts.startTime),
    '-i',
    opts.sourcePath,
    ...extraInputs,
    '-t',
    String(duration),
    '-filter_complex',
    fc,
    '-map',
    '[v]',
    '-map',
    aMap,
    ...codecArgs(opts),
    ...outputTailArgs(opts.outputPath)
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
 * Build the single-frame thumbnail argv (PRD Appendix A `-vframes 1`), reframed to
 * the export's aspect ratio. NOTE: the thumbnail uses the static CENTER-crop — it
 * does NOT apply an auto-reframe (Part J) face-crop or split-screen, so for a
 * reframed export the thumbnail may not match the exported framing (acceptable: a
 * thumbnail is a coarse preview, and a time-varying pan has no single frame).
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
  /** Inject the ffmpeg spawn driver (tests). Default: the real `runFfmpeg`. */
  runFfmpeg?: (opts: RunFfmpegOptions) => Promise<unknown>
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
  const runFfmpeg = opts.runFfmpeg ?? defaultRunFfmpeg
  // Atomic output (audit fix openclip-8dg): encode to a HIDDEN sibling temp in the
  // SAME directory as the user's chosen outputPath, then `rename` it onto the target
  // only after a clean exit. On cancel/SIGKILL or a non-zero exit the partial (which,
  // with +faststart, is an unplayable file whose moov atom was never written) is left
  // under the temp name and unlinked — so the user's export folder never shows a
  // truncated half-written clip and the final file appears atomically. Same-dir temp
  // keeps the rename atomic (no cross-filesystem copy).
  const finalOut = opts.outputPath
  // Cap the temp stem so a near-255-char chosen filename can't push the `.part.mp4`
  // temp over ENAMETOOLONG; the random suffix still makes it unique + collision-free.
  const tmpStem = basename(finalOut).slice(0, 200)
  const tmpOut = join(dirname(finalOut), `.${tmpStem}.${randomUUID()}.part.mp4`)
  const argvOpts: ExportClipOptions = { ...opts, outputPath: tmpOut }

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
    ? exportClipArgsSplit(argvOpts)
    : jumpCut
      ? exportClipArgsMultiRange(argvOpts)
      : exportClipArgs(argvOpts)
  // Split renders a 2-up frame at the CHOSEN aspect's output size (audit fix
  // openclip-omd), same as the non-split paths. The reported result dims drive
  // thumbnails/UI — keep them honest.
  const { width, height } = outputDimensions(opts.aspectRatio)
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
  try {
    await runFfmpeg(runOpts)
    await rename(tmpOut, finalOut)
  } catch (err) {
    await rm(tmpOut, { force: true }).catch(() => {})
    throw err
  }

  return {
    outputPath: finalOut,
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
  await defaultRunFfmpeg({
    args: thumbnailArgs(opts),
    binPath: opts.binPath,
    signal: opts.signal
  })
  return { thumbnailPath: opts.outputPath }
}
