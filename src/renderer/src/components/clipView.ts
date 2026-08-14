/**
 * clipView.ts — pure presentation helpers for ClipCard / ClipSidebar (T-AI,
 * plan E.3). Extracted from the `.tsx` files so they can be unit-tested without
 * a DOM (vitest `node` env) and so the component files only export components
 * (react-refresh/only-export-components).
 */

import type { Clip, ClipVirality } from '@shared/schema'
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

/** Derive the renderable view model from a Clip (PRD §9.3). */
export function clipViewModel(clip: Clip): ClipViewModel {
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
