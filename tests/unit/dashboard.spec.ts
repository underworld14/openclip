/**
 * tests/unit/dashboard.spec.ts — T-Persist Dashboard (plan E.3 / PRD §11.2).
 *
 * The vitest env is `node` (the trunk ships no jsdom/testing-library — renderer
 * components are exercised through their pure, framework-free view-model
 * helpers, the same pattern useJob uses with `jobEvents`). Here we assert the
 * `dashboardViewModel(...)` helper that the `Dashboard` component renders from:
 * it turns the store's `recentProjects` metadata into the display rows
 * (relative "updated" label, formatted, with the active project flagged).
 *
 * Done-when (E.3): "Dashboard lists fixture projects" — proven by the view-model
 * producing one row per fixture project, newest first, with correct labels.
 */

import { describe, expect, it } from 'vitest'
import { dashboardViewModel } from '@renderer/components/Dashboard.view'
import type { ProjectMeta } from '@renderer/stores/projectStore'

const NOW = 1_716_900_000_000 // fixed "now" for deterministic relative labels

const recents: ProjectMeta[] = [
  { id: 'a', name: 'Newest', updatedAt: NOW - 30_000, path: '/p/a.ocproj' }, // 30s ago
  { id: 'b', name: 'Hours', updatedAt: NOW - 3 * 3_600_000, path: '/p/b.ocproj' }, // 3h ago
  { id: 'c', name: 'Days', updatedAt: NOW - 2 * 86_400_000, path: '/p/c.ocproj' } // 2d ago
]

describe('dashboardViewModel', () => {
  it('produces one row per recent project, preserving order', () => {
    const vm = dashboardViewModel(recents, null, NOW)
    expect(vm.rows.map((r) => r.id)).toEqual(['a', 'b', 'c'])
    expect(vm.isEmpty).toBe(false)
  })

  it('renders a human relative "updated" label for each row', () => {
    const vm = dashboardViewModel(recents, null, NOW)
    expect(vm.rows[0].updatedLabel).toMatch(/just now|second/i)
    expect(vm.rows[1].updatedLabel).toMatch(/hour/i)
    expect(vm.rows[2].updatedLabel).toMatch(/day/i)
  })

  it('flags the currently-open project as active', () => {
    const vm = dashboardViewModel(recents, 'b', NOW)
    expect(vm.rows.find((r) => r.id === 'b')?.isActive).toBe(true)
    expect(vm.rows.find((r) => r.id === 'a')?.isActive).toBe(false)
  })

  it('reports empty state when there are no recent projects', () => {
    const vm = dashboardViewModel([], null, NOW)
    expect(vm.isEmpty).toBe(true)
    expect(vm.rows).toEqual([])
  })

  it('exposes name and id for click-to-open wiring', () => {
    const vm = dashboardViewModel(recents, null, NOW)
    expect(vm.rows[0]).toMatchObject({ id: 'a', name: 'Newest' })
  })
})
