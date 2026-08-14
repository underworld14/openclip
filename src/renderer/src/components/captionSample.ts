/**
 * captionSample.ts — pick the words a caption-template thumbnail renders
 * (FEAT-0s2tnc).
 *
 * The gallery was 13 `<button>`s whose only description was a raw HTML `title`
 * attribute. "Hormozi", "MrBeast", "Beast Pop", "Captionate" mean nothing
 * without seeing them — the single most visible thing the app produces was
 * chosen from a list of names.
 *
 * The thumbnails render the SAME phrase in every template, because the point of
 * a gallery is to isolate one variable. And they render the user's OWN words
 * where possible: a preset previewed on the actual video reads as "this is what
 * mine will look like" in a way that lorem text never does.
 *
 * PURE — no DOM, no store.
 */

import type { WordTimestamp } from '@shared/schema'

/**
 * Shown when the project has no transcript yet (the panel is reachable before
 * transcription finishes). Three words, so the thumbnail layout is identical
 * either way and switching to real words doesn't reflow the strip.
 */
export const FALLBACK_SAMPLE = ['THIS', 'IS', 'HUGE']

/** Longest word a thumbnail can show before it stops being a thumbnail. */
const MAX_WORD_LENGTH = 12

/**
 * Three consecutive real words from the transcript, or the fallback.
 *
 * Consecutive rather than "the three shortest": a real phrase is what the
 * template will actually be asked to render, and cherry-picking short words
 * would flatter every preset equally and inform nothing.
 *
 * The scan skips any window containing a word too long to fit, and falls back
 * rather than truncating — a clipped word in a *style* preview reads as the
 * style being broken.
 */
export function sampleCaptionWords(words: WordTimestamp[] | undefined, count = 3): string[] {
  if (!words || words.length < count) return FALLBACK_SAMPLE.slice(0, count)
  const cleaned = words.map((w) => w.word.trim()).filter(Boolean)
  for (let i = 0; i + count <= cleaned.length; i += 1) {
    const window = cleaned.slice(i, i + count)
    if (window.every((w) => w.length <= MAX_WORD_LENGTH)) return window
  }
  return FALLBACK_SAMPLE.slice(0, count)
}

/**
 * Which word in the thumbnail is "currently spoken", so the highlight color is
 * actually visible.
 *
 * The middle one: it is the only choice where the neighbours on both sides show
 * the BASE color, which is what makes the contrast — the whole reason a
 * karaoke-caption preset looks different from any other — legible at thumbnail
 * size.
 */
export function sampleActiveIndex(count: number): number {
  return Math.floor(Math.max(0, count - 1) / 2)
}
