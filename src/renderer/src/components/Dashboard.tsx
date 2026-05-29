/**
 * src/renderer/src/components/Dashboard.tsx — recent-projects panel (T-Persist,
 * plan E.3 / PRD §11.2 Dashboard "recent projects, import").
 *
 * Lists the projects from `project:list` (via `useProject`) newest-first with a
 * relative "updated" label, lets the user open one. The pure display logic lives
 * in `Dashboard.view.ts` (`dashboardViewModel`) so it is unit-testable in the
 * trunk's node env (no jsdom) and this file exports only the component
 * (react-refresh) — the same pure-core / thin-wrapper split `useJob` uses.
 */

import { useProject } from '@renderer/hooks/useProject'
import { dashboardViewModel } from './Dashboard.view'

export function Dashboard(): React.JSX.Element {
  const { recentProjects, currentProject, open } = useProject()
  const vm = dashboardViewModel(recentProjects, currentProject?.id ?? null)

  return (
    <div data-testid="dashboard" className="flex flex-col gap-1 p-2">
      <div className="px-1 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Recent Projects
      </div>

      {vm.isEmpty ? (
        <div className="px-1 py-3 text-sm text-muted-foreground">
          No projects yet. Import a video to get started.
        </div>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {vm.rows.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                aria-current={row.isActive ? 'true' : undefined}
                onClick={() => void open(row.id)}
                className={
                  'flex w-full flex-col items-start rounded px-2 py-1.5 text-left text-sm hover:bg-accent ' +
                  (row.isActive ? 'bg-accent font-medium' : '')
                }
              >
                <span className="truncate">{row.name}</span>
                <span className="text-xs text-muted-foreground">{row.updatedLabel}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default Dashboard
