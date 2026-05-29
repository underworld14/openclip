/**
 * src/main/services/ffmpeg-caption.ts — the CAPTION-BURN composition step
 * (spine, plan E.5 / PRD §6.4). Bridges the PURE `ass-captions` generator and
 * the EXPORT filtergraph: it writes a clip's karaoke `.ass` to the per-job temp
 * dir and hands back the path the export re-encode burns via
 * `subtitles=<ass>:fontsdir=<paths.fontsDir()>` (the proven order, fix M3).
 *
 * Composed INTO export, not a separate pass: the export runner calls
 * `writeClipCaptions()` (when captions are enabled) BEFORE `exportClip`, then
 * threads the returned `.ass` path as `exportClip({ assPath, fontsDir })` so the
 * crop+scale+subtitles happen in ONE re-encode (a 2-stage micro-pipeline with
 * export — fix M3). The fontsdir comes from trunk-frozen `paths.fontsDir()`.
 *
 * Re-exported through the `ffmpeg.ts` barrel (seam: `export * from
 * './ffmpeg-caption'`) so consumers `import { writeClipCaptions } from
 * '@main/services/ffmpeg'`.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { CaptionStyle, WordTimestamp } from '@shared/schema'
import { buildAss } from './ass-captions'

export interface WriteClipCaptionsOptions {
  /** The clip's word timestamps (ABSOLUTE seconds — project transcript words). */
  words: WordTimestamp[]
  /** Clip start in ABSOLUTE seconds (resolveBounds().start). */
  clipStart: number
  /** Clip end in ABSOLUTE seconds (resolveBounds().end). */
  clipEnd: number
  /** Caption style (font/size/color/bg/position/animation). */
  style?: CaptionStyle
  /** Where to write the .ass (e.g. `<jobTempDir>/clip-<id>.captions.ass`). */
  assPath: string
}

/**
 * Generate the clip's karaoke `.ass` and write it to `assPath` (creating parent
 * dirs as needed), returning the path. Pure-ish: the heavy lifting is the pure
 * `buildAss`; this only does the filesystem write so the export runner can burn
 * it. Returns the written path so the runner threads it straight into
 * `exportClip({ assPath })`.
 */
export function writeClipCaptions(opts: WriteClipCaptionsOptions): string {
  const ass = buildAss({
    words: opts.words,
    clipStart: opts.clipStart,
    clipEnd: opts.clipEnd,
    style: opts.style
  })
  mkdirSync(dirname(opts.assPath), { recursive: true })
  writeFileSync(opts.assPath, ass, 'utf8')
  return opts.assPath
}
