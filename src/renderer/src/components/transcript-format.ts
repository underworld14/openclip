/**
 * transcript-format — pure presentation helpers for TranscriptPanel (T-Media,
 * E.3). Kept in its own module so the component file only exports a component
 * (react-refresh boundary).
 */

import { formatSeconds } from '@renderer/components/format-time'

/** seconds → `m:ss` (or `h:mm:ss`) for a segment timestamp label (PRD §6.2). Thin
 * wrapper over the single `formatSeconds` formatter (audit fix openclip-64e). */
export function formatTimestamp(seconds: number): string {
  return formatSeconds(seconds, { hours: 'auto' })
}
