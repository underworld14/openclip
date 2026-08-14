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
import type { CaptionStyle, TranscriptSegment, WordTimestamp } from '@shared/schema'
import { scopeWordsToClip, groupIntoLines } from '@shared/caption-layout'
import { serializeTranscript } from '@shared/subtitle-export'
import type { Range } from '@shared/keep-ranges'
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
  /** Part K — words to EMPHASIZE (keyword highlight); usually `Clip.keywords`. */
  keywords?: string[]
  /**
   * Part K (emoji) — BYOK-AI emoji map (normalized word → emoji), used by buildAss
   * only when `style.autoEmoji === 'ai'`. Absent ⇒ the local dictionary.
   */
  aiEmojiMap?: Record<string, string>
  /**
   * The export canvas the captions will be burned onto, so PlayResY matches the
   * aspect ratio (BUG-y6y5mf). Omitted ⇒ the 9:16 default.
   */
  canvas?: { width: number; height: number }
  /** Where to write the .ass (e.g. `<jobTempDir>/clip-<id>.captions.ass`). */
  assPath: string
  /**
   * Jump-cut keep ranges (Part I.4 — ABSOLUTE source seconds). When present, the
   * caption word times are remapped onto the compressed (silence-removed)
   * timeline so karaoke matches the cut video.
   */
  keepRanges?: Range[]
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
    style: opts.style,
    keywords: opts.keywords,
    aiEmojiMap: opts.aiEmojiMap,
    keepRanges: opts.keepRanges,
    canvas: opts.canvas
  })
  mkdirSync(dirname(opts.assPath), { recursive: true })
  writeFileSync(opts.assPath, ass, 'utf8')
  return opts.assPath
}

/**
 * Write a sidecar `.srt` next to an exported clip (FEAT-vwvgs0).
 *
 * PRD §6.2 wants the transcript available as DATA, not only as burned pixels.
 * The export already holds the words it is burning, scoped and rebased to this
 * clip, so producing the subtitle file alongside costs nothing at export time —
 * and saves the user a separate round-trip when they upload, where a real `.srt`
 * beats baked-in text (searchable, translatable, toggleable).
 *
 * Word timings are grouped into readable cues with the SAME line-layout rule the
 * karaoke burner uses, so the sidecar and the burned captions break in the same
 * places rather than drifting apart.
 */
export function writeSidecarSubtitles(opts: {
  outputPath: string
  words: WordTimestamp[]
  clipStart: number
  clipEnd: number
  /** Max words per cue. Defaults to the caption layout's 7. */
  maxWordsPerLine?: number
}): string {
  const scoped = scopeWordsToClip(opts.words, opts.clipStart, opts.clipEnd)
  const lines = groupIntoLines(scoped, opts.maxWordsPerLine ?? 7, 0.8)
  const segments: TranscriptSegment[] = lines.map((line, i) => ({
    id: `cue-${i}`,
    start: line[0].start,
    end: line[line.length - 1].end,
    text: line.map((w) => w.word).join(' '),
    confidence: 1
  }))
  const srt = serializeTranscript({ language: '', segments, words: [] }, 'srt')
  const path = opts.outputPath.replace(/\.[^./\\]+$/, '') + '.srt'
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, srt, 'utf8')
  return path
}
