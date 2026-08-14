/**
 * clipView.ts — pure presentation helpers for ClipCard / ClipSidebar (T-AI,
 * plan E.3). Extracted from the `.tsx` files so they can be unit-tested without
 * a DOM (vitest `node` env) and so the component files only export components
 * (react-refresh/only-export-components).
 */

import type { Clip, ClipVirality, TranscriptSegment } from '@shared/schema'
import { formatSeconds } from '@renderer/components/format-time'

/** Format absolute seconds as M:SS (no hours rollover). Thin wrapper over the single
 * `formatSeconds` formatter (audit fix openclip-64e). */
export function formatTimecode(seconds: number): string {
  return formatSeconds(seconds)
}

/** One bar in the virality breakdown (label + raw 0-25 score, for the card). */
export interface ViralityBar {
  label: string
  /** Raw sub-score, 0-25. */
  score: number
  /** 0-1 fill ratio (score/25) for the bar width. */
  ratio: number
}

export interface ClipViewModel {
  id: string
  title: string
  hook: string
  score: number
  clipType: string
  keywords: string[]
  /** Displayed time range (honors editedStart/editedEnd if present). */
  range: string
  status: Clip['status']
  isApproved: boolean
  canApprove: boolean
  canReject: boolean
  /** True when Reject has hidden this clip; the card shows Restore instead. */
  isRejected: boolean
  /** True once the clip has been exported — the card shows a badge for it. */
  isExported: boolean
  /** AI-written social caption for this clip, when the project has one. */
  suggestedCaption?: string
  /** AI-suggested hashtags, when the project has them. */
  hashtags?: string[]
  /**
   * What is actually SAID in the clip, from the transcript. Undefined when there
   * is no transcript (or no words in the span) — the card then shows nothing
   * rather than an empty quote block.
   */
  excerpt?: string
  /** Poster frame extracted at the clip's IN point, when one has been made. */
  thumbnailPath?: string
  /** Part I — 0-100 virality total + the four sub-score bars (undefined on old clips). */
  viralityTotal?: number
  viralityBars?: ViralityBar[]
  /** Part I — opening-hook type chip (undefined when not classified). */
  hookType?: string
}

/** Build the four sub-score bars from a Clip's persisted 4-D breakdown. */
export function viralityBars(v: ClipVirality): ViralityBar[] {
  return [
    { label: 'Hook', score: v.hook, ratio: v.hook / 25 },
    { label: 'Engage', score: v.engagement, ratio: v.engagement / 25 },
    { label: 'Value', score: v.value, ratio: v.value / 25 },
    { label: 'Share', score: v.shareability, ratio: v.shareability / 25 }
  ]
}

/**
 * The clip's ACTUAL spoken words, from the transcript inside its bounds
 * (FEAT-71ay4e).
 *
 * The card showed the AI's title and its pitch — and never a syllable of what is
 * actually said in the span. To judge a suggestion the user had to click each
 * card and scrub. This is the cheapest credibility win available: the transcript
 * is already in the store, and seeing the real words next to the AI's claim about
 * them is what makes the claim checkable.
 *
 * Partial overlaps count: a segment straddling the IN point is part of what the
 * viewer will hear.
 */
export function clipExcerpt(
  segments: TranscriptSegment[] | undefined,
  start: number,
  end: number,
  maxChars = 240
): string | undefined {
  if (!segments || segments.length === 0) return undefined
  const text = segments
    .filter((s) => s.end > start && s.start < end)
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(' ')
    .trim()
  if (!text) return undefined
  if (text.length <= maxChars) return text
  // Cut on a word boundary — a mid-word truncation reads as corruption.
  const cut = text.slice(0, maxChars)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

/** Derive the renderable view model from a Clip (PRD §9.3). */
export function clipViewModel(clip: Clip, segments?: TranscriptSegment[]): ClipViewModel {
  const start = clip.editedStart ?? clip.startTime
  const end = clip.editedEnd ?? clip.endTime
  return {
    id: clip.id,
    title: clip.title,
    hook: clip.hook,
    score: clip.viralityScore,
    clipType: clip.clipType,
    keywords: clip.keywords,
    range: `${formatTimecode(start)} – ${formatTimecode(end)}`,
    status: clip.status,
    isApproved: clip.status === 'approved',
    canApprove: clip.status === 'suggested' || clip.status === 'edited',
    canReject: clip.status !== 'exported' && clip.status !== 'rejected',
    /** Rejected is reversible, so the card offers the way back (FEAT-k28j7h). */
    isRejected: clip.status === 'rejected',
    /**
     * An EXPORTED clip used to render nothing at all — not approved (so no
     * badge), not approvable, not rejectable — so a clip the user had already
     * shipped looked broken (FEAT-ybhdhz).
     */
    isExported: clip.status === 'exported',
    /**
     * The AI writes a social caption and hashtags for every clip, the mapper
     * carries them onto the Clip and the schema persists them — and nothing ever
     * showed them (FEAT-g39qj3). The user paid for those tokens on every
     * generation. Optional, because projects written before they existed have
     * neither.
     */
    suggestedCaption: clip.suggestedCaption,
    hashtags: clip.hashtags,
    excerpt: clipExcerpt(segments, start, end),
    thumbnailPath: clip.thumbnailPath,
    viralityTotal: clip.virality?.total,
    viralityBars: clip.virality ? viralityBars(clip.virality) : undefined,
    hookType: clip.hookType
  }
}

/**
 * Sort clips for the sidebar: highest virality first. Returns the sorted `Clip[]`
 * directly (audit fix openclip-0hp/don): the sidebar previously got back view models,
 * then did an O(n) `clips.find()` PER ROW (O(n²)) to recover each Clip, and ClipCard
 * rebuilt the view model a second time. Returning Clips lets the sidebar render
 * `ClipCard` straight from the sorted list (ClipCard builds the view model once).
 */
export function sortClipsForSidebar(clips: Clip[]): Clip[] {
  return [...clips].sort((a, b) => b.viralityScore - a.viralityScore)
}

/**
 * Split the clip list into what the sidebar shows and what Reject has hidden
 * (FEAT-k28j7h). Rejected clips are still in the project — they are simply not
 * in the way — so the sidebar can offer "N hidden · Show" instead of the user
 * having to wonder where a clip went.
 */
export function partitionRejected(clips: Clip[]): { visible: Clip[]; hidden: Clip[] } {
  const visible: Clip[] = []
  const hidden: Clip[] = []
  for (const c of clips) (c.status === 'rejected' ? hidden : visible).push(c)
  return { visible, hidden }
}
