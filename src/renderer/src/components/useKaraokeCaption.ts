/**
 * useKaraokeCaption — the WYSIWYG preview's live caption view-model (Part K,
 * Step 3). Given the clip bounds + transcript words + the resolved CaptionStyle +
 * the current playhead, it returns the ACTIVE caption line and the active word,
 * using the SAME shared layout (`layoutCaptionLines`) + annotation
 * (`annotateWords`) the burn uses — so the preview shows the same line breaks,
 * keyword emphasis and emoji that will be burned in.
 *
 * The pure selection (`pickActiveLine`) is exported for unit testing.
 */

import { useMemo } from 'react'
import type { CaptionStyle, WordTimestamp } from '@shared/schema'
import { layoutCaptionLines } from '@shared/caption-layout'
import { annotateWords, type AnnotatedWord } from '@shared/caption-emphasis'

export interface AnnotatedLine {
  startSec: number
  endSec: number
  words: AnnotatedWord[]
}

export interface ActiveCaption {
  words: AnnotatedWord[]
  /** Index of the currently-spoken word in `words` (-1 before the first word). */
  activeIndex: number
}

/**
 * PURE: pick the active line for clip-relative time `t` (± `tolSec`) and the
 * active word within it. The last word whose end has passed stays highlighted
 * until the next word begins (matches karaoke fill). Returns null when no line
 * is active at `t`.
 */
export function pickActiveLine(
  lines: AnnotatedLine[],
  t: number,
  tolSec = 0.1
): ActiveCaption | null {
  for (const line of lines) {
    if (t < line.startSec - tolSec || t > line.endSec + tolSec) continue
    let activeIndex = -1
    for (let i = 0; i < line.words.length; i++) {
      const w = line.words[i]
      if (t >= w.start - tolSec && t <= w.end + tolSec) {
        activeIndex = i
        break
      }
      if (t > w.end) activeIndex = i // hold the last-passed word highlighted
    }
    return { words: line.words, activeIndex }
  }
  return null
}

/**
 * Hook: the active caption at the current playhead. `playhead` is ABSOLUTE source
 * seconds; words are rebased to the clip and annotated (keyword + auto-emoji) so
 * the preview matches the burn. Returns null when captions don't apply at `t`.
 */
export function useKaraokeCaption(args: {
  words: WordTimestamp[]
  clipStart: number
  clipEnd: number
  style: CaptionStyle
  playhead: number
  keywords?: string[]
}): ActiveCaption | null {
  const annotatedLines = useMemo<AnnotatedLine[]>(() => {
    const lines = layoutCaptionLines(args.words, args.clipStart, args.clipEnd, {
      maxWordsPerLine: args.style.wordsPerLine
    })
    return lines.map((l) => ({
      startSec: l.startSec,
      endSec: l.endSec,
      words: annotateWords(l.words, {
        keywords: args.keywords,
        autoEmoji: args.style.autoEmoji
      })
    }))
  }, [
    args.words,
    args.clipStart,
    args.clipEnd,
    args.style.wordsPerLine,
    args.style.autoEmoji,
    args.keywords
  ])

  const tRel = args.playhead - args.clipStart
  return useMemo(() => pickActiveLine(annotatedLines, tRel), [annotatedLines, tRel])
}
