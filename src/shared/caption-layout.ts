/**
 * src/shared/caption-layout.ts — PURE caption line-layout (Part K, Step 1).
 *
 * Lifted VERBATIM out of `@main/services/ass-captions` so BOTH the libass `.ass`
 * burn (main) AND the in-app WYSIWYG preview (renderer) group + scope words the
 * SAME way — guaranteeing the live preview matches the burned output. Lives in
 * `@shared` because the renderer cannot import from `@main`.
 *
 * No FFmpeg, no Electron, no filesystem. `ass-captions.ts` re-exports these
 * symbols so existing `@main/services/ass-captions` importers are unaffected and
 * the golden `.ass` strings stay byte-for-byte identical.
 */

import type { CaptionStyle, WordTimestamp } from './schema'
import { compressTimeClamped, type Range } from './keep-ranges'

/**
 * The app-default caption style (the bundled DejaVu Sans karaoke look, PRD §6.4).
 * Lives in `@shared` so BOTH the burn (`buildAss` fallback, re-exported via
 * ass-captions) AND the renderer (preview + `resolveEffectiveCaptionStyle`) share
 * one source. `buildAss(opts.style ?? DEFAULT_CAPTION_STYLE)` means passing this
 * explicitly is byte-identical to passing nothing.
 */
export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontFamily: 'DejaVu Sans',
  fontSize: 64,
  fontColor: '#FFFFFF',
  backgroundColor: '#000000',
  position: 'bottom',
  animation: 'none',
  highlightCurrentWord: true,
  emojiEnabled: false
}

// ============================================================================
// Token filtering — drop whisper special / blank tokens
// ============================================================================

/**
 * Whether a word entry should be dropped before captioning. whisper emits
 * special-token entries (`[_BEG_]`, `[_TT_123]`, `[_EOT_]`, `<|…|>`) and
 * blank/whitespace-only words; none should appear as a karaoke syllable.
 */
export function isDroppableToken(word: string): boolean {
  const w = word.trim()
  if (w.length === 0) return true
  // whisper bracket special tokens: [_BEG_], [_TT_700], [_EOT_], [_SOT_], …
  if (/^\[_[A-Z]+_?\d*_?\]$/.test(w)) return true
  // angle-bracket special tokens: <|endoftext|>, <|0.00|>, <|nospeech|>, …
  if (/^<\|.*\|>$/.test(w)) return true
  return false
}

// ============================================================================
// Scope + rebase words to a clip
// ============================================================================

/** A word with clip-RELATIVE timestamps (clip start subtracted), special/blank dropped. */
export interface RebasedWord {
  word: string
  /** seconds, relative to the clip start (>= 0). */
  start: number
  /** seconds, relative to the clip start. */
  end: number
}

/**
 * Scope `words` to the clip's absolute `[clipStart, clipEnd]` range and rebase
 * to clip-relative time. A word is KEPT if it intersects the range (its end is
 * after clipStart AND its start is before clipEnd); partial overlaps are clamped
 * to the clip bounds. Special/blank tokens are dropped. Output is rebased
 * (clipStart subtracted), sorted by start, with non-negative monotonic times.
 */
export function scopeWordsToClip(
  words: WordTimestamp[],
  clipStart: number,
  clipEnd: number
): RebasedWord[] {
  const out: RebasedWord[] = []
  for (const w of words) {
    if (isDroppableToken(w.word)) continue
    // Intersection test against the clip range (half-open; touch at edge dropped).
    if (w.end <= clipStart || w.start >= clipEnd) continue
    const start = Math.max(w.start, clipStart) - clipStart
    const end = Math.min(w.end, clipEnd) - clipStart
    if (!(end > start)) continue // zero/negative span after clamping
    out.push({ word: w.word.trim(), start, end })
  }
  out.sort((a, b) => a.start - b.start)
  return out
}

/**
 * Like `scopeWordsToClip` but for a JUMP-CUT export (Part I.4): map each word's
 * absolute time onto the COMPRESSED (silence-removed) timeline via the keep
 * ranges. Words fully inside a removed gap collapse to zero length and are
 * dropped; the clip window is exactly the keep-ranges span (the first kept
 * sample → t0), so no separate clipStart/End is needed.
 */
export function scopeWordsToKeepRanges(words: WordTimestamp[], keepRanges: Range[]): RebasedWord[] {
  const out: RebasedWord[] = []
  for (const w of words) {
    if (isDroppableToken(w.word)) continue
    const start = compressTimeClamped(w.start, keepRanges)
    const end = compressTimeClamped(w.end, keepRanges)
    if (!(end > start)) continue // entirely inside a removed gap (or zero-length)
    out.push({ word: w.word.trim(), start, end })
  }
  out.sort((a, b) => a.start - b.start)
  return out
}

// ============================================================================
// Line grouping
// ============================================================================

/** Defaults used by both the `.ass` burn and the DOM preview. */
export const DEFAULT_MAX_WORDS_PER_LINE = 7
export const DEFAULT_GAP_BREAK_SEC = 0.8

/**
 * Group an ordered run of words into caption LINES: break to a new line at
 * `maxWordsPerLine` words, OR when the silence before a word exceeds
 * `gapBreakSec`. Generic over `T extends RebasedWord` so it preserves any extra
 * annotation fields (e.g. the keyword/emoji marks added by `caption-emphasis`).
 */
export function groupIntoLines<T extends RebasedWord>(
  words: T[],
  maxWordsPerLine: number,
  gapBreakSec: number
): T[][] {
  const lines: T[][] = []
  let current: T[] = []
  let prevEnd: number | null = null
  for (const w of words) {
    const longGap = prevEnd !== null && w.start - prevEnd > gapBreakSec
    if (current.length >= maxWordsPerLine || longGap) {
      if (current.length > 0) lines.push(current)
      current = []
    }
    current.push(w)
    prevEnd = w.end
  }
  if (current.length > 0) lines.push(current)
  return lines
}

// ============================================================================
// layoutCaptionLines — scope + group in one call (for the DOM preview, Step 3)
// ============================================================================

/** A caption line for the preview: its time span + the (rebased) words in it. */
export interface CaptionLine {
  /** seconds, clip-relative — first word's start. */
  startSec: number
  /** seconds, clip-relative — last word's end. */
  endSec: number
  words: RebasedWord[]
}

export interface LayoutOptions {
  maxWordsPerLine?: number
  gapBreakSec?: number
  /** Jump-cut keep ranges (Part I.4) — when present, words are remapped onto the compressed timeline. */
  keepRanges?: Range[]
}

/**
 * Scope `words` to a clip and group them into caption lines — the SAME pipeline
 * `buildAss` uses (scope/rebase → `groupIntoLines`), so the DOM preview's line
 * breaks and per-word timing match the burned `.ass`. Defaults mirror `buildAss`
 * (7 words/line, 0.8s gap break).
 */
export function layoutCaptionLines(
  words: WordTimestamp[],
  clipStart: number,
  clipEnd: number,
  opts: LayoutOptions = {}
): CaptionLine[] {
  const maxWords = opts.maxWordsPerLine ?? DEFAULT_MAX_WORDS_PER_LINE
  const gapBreak = opts.gapBreakSec ?? DEFAULT_GAP_BREAK_SEC
  const scoped =
    opts.keepRanges && opts.keepRanges.length > 0
      ? scopeWordsToKeepRanges(words, opts.keepRanges)
      : scopeWordsToClip(words, clipStart, clipEnd)
  return groupIntoLines(scoped, maxWords, gapBreak).map((run) => ({
    startSec: run[0].start,
    endSec: run[run.length - 1].end,
    words: run
  }))
}
