/**
 * src/renderer/src/components/Dashboard.view.ts — pure view-model for the
 * Dashboard recent-projects panel (T-Persist, plan E.3 / PRD §11.2).
 *
 * Kept in its own (non-component) module so `Dashboard.tsx` exports only the
 * component (react-refresh/only-export-components) while this display logic
 * stays unit-testable in the trunk's node env (no jsdom) — the same pure-core /
 * thin-wrapper split `useJob`/`jobEvents` uses.
 */

import type { ProjectMeta } from '@renderer/stores/projectStore'

export interface DashboardRow {
  id: string
  name: string
  updatedAt: number
  /** Human relative label, e.g. "just now", "3 hours ago", "2 days ago". */
  updatedLabel: string
  /** True when this row is the currently-open project. */
  isActive: boolean
}

export interface DashboardViewModel {
  rows: DashboardRow[]
  isEmpty: boolean
}

/** Format an epoch-ms timestamp as a coarse relative label against `now`. */
export function relativeUpdatedLabel(updatedAt: number, now: number): string {
  const deltaSec = Math.max(0, Math.round((now - updatedAt) / 1000))
  if (deltaSec < 45) return 'just now'
  const mins = Math.round(deltaSec / 60)
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

/**
 * Turn the store's recent-project metadata into renderable rows. Order is
 * preserved (the store already lists newest-first via `project:list`).
 */
export function dashboardViewModel(
  recents: ProjectMeta[],
  activeProjectId: string | null,
  now: number = Date.now()
): DashboardViewModel {
  const rows: DashboardRow[] = recents.map((p) => ({
    id: p.id,
    name: p.name,
    updatedAt: p.updatedAt,
    updatedLabel: relativeUpdatedLabel(p.updatedAt, now),
    isActive: p.id === activeProjectId
  }))
  return { rows, isEmpty: rows.length === 0 }
}
