/**
 * clipView.ts — pure presentation helpers for ClipCard / ClipSidebar (T-AI,
 * plan E.3). Extracted from the `.tsx` files so they can be unit-tested without
 * a DOM (vitest `node` env) and so the component files only export components
 * (react-refresh/only-export-components).
 */

import type { Clip } from '@shared/schema'

/** Format absolute seconds as M:SS. */
export function formatTimecode(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
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
    canReject: clip.status !== 'exported'
  }
}

/** Sort clips for the sidebar: highest virality first, mapped to view models. */
export function sortClipsForSidebar(clips: Clip[]): ClipViewModel[] {
  return [...clips].sort((a, b) => b.viralityScore - a.viralityScore).map(clipViewModel)
}
