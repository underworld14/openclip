/**
 * saveStatus.ts — the pure label for the title-bar persistence indicator
 * (FEAT-51hnwx).
 *
 * Pure so it is unit-testable without a DOM, matching `readinessView` /
 * `settingsView` / `clipView`.
 */

import type { SaveState } from '@renderer/stores/uiStore'

/** Coarse buckets — "2s ago" precision is noise, and a live-ticking clock is worse. */
export function relativeSince(ms: number): string {
  if (ms < 5_000) return 'just now'
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
  return `${Math.round(ms / 3_600_000)}h ago`
}

/**
 * What the indicator should say. Returns `null` when there is nothing worth
 * showing — before the first save there is no state to report, and inventing
 * "Saved" there would be a lie.
 */
export function saveStatusLabel(
  state: SaveState,
  lastSavedAt: number | null,
  now: number
): string | null {
  switch (state) {
    case 'saving':
      return 'Saving…'
    case 'error':
      return 'Not saved'
    case 'saved':
      return lastSavedAt === null ? 'Saved' : `Saved · ${relativeSince(now - lastSavedAt)}`
    default:
      return null
  }
}
