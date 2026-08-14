/**
 * src/renderer/src/components/Dashboard.tsx — recent-projects panel (T-Persist,
 * plan E.3 / PRD §11.2 Dashboard "recent projects, import").
 *
 * Lists the projects from `project:list` (via `useProject`) newest-first with a
 * relative "updated" label. The pure display logic lives in `Dashboard.view.ts`
 * (`dashboardViewModel`) so it is unit-testable in the trunk's node env (no
 * jsdom) and this file exports only the component (react-refresh) — the same
 * pure-core / thin-wrapper split `useJob` uses.
 *
 * FEAT-905vk4 fixed two things here:
 *
 *  - Every row was an open-only button. `projectActions.remove` existed with
 *    ZERO callers, and there was no rename, duplicate or reveal anywhere — a
 *    project could be created and opened, never managed. The row now carries a
 *    menu, built on the `ui/dropdown-menu` that was already bundled and unused.
 *  - `void open(row.id)` DISCARDED the promise, so a failed load produced no
 *    spinner, no toast and no error: clicking a project whose file had moved or
 *    gone corrupt simply did nothing, forever.
 */

import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { useProject } from '@renderer/hooks/useProject'
import { dashboardViewModel } from './Dashboard.view'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'

export function Dashboard(): React.JSX.Element {
  const { recentProjects, currentProject, open, remove, rename, duplicate } = useProject()
  const vm = dashboardViewModel(recentProjects, currentProject?.id ?? null)
  /** The row whose load is in flight — a click used to give no sign of life. */
  const [opening, setOpening] = useState<string | null>(null)
  /** The row awaiting delete confirmation. Deleting a project is unrecoverable. */
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)

  const handleOpen = (id: string): void => {
    setOpening(id)
    open(id)
      .catch((e: unknown) => {
        // The failure this replaces: a discarded rejection, so a project whose
        // file had moved or gone corrupt just silently refused to open.
        toast.error('Could not open project', {
          description: e instanceof Error ? e.message : String(e)
        })
      })
      .finally(() => setOpening((cur) => (cur === id ? null : cur)))
  }

  /**
   * The row being renamed, and its draft text.
   *
   * INLINE rather than a modal: `window.prompt` is unavailable under
   * `sandbox: true`, and editing the name where it is displayed is the better
   * interaction anyway — the user can see the other names while choosing.
   */
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  /**
   * True from the moment Rename is chosen until the input has survived one blur.
   *
   * THE BUG THIS FIXES: Radix returns focus to the menu trigger as the dropdown
   * closes, which blurs the just-mounted rename input — and the blur handler
   * treats that as "the user finished editing", so choosing Rename cancelled
   * itself before a key could be typed. (`onCloseAutoFocus` + preventDefault
   * does NOT prevent it; the focus move still lands on the input's blur.) So the
   * FIRST blur is understood as the menu closing, not as the user leaving, and
   * focus is taken back.
   */
  const justOpenedRename = useRef(false)
  const renameInput = useRef<HTMLInputElement | null>(null)

  const commitRename = (id: string): void => {
    const next = draftName.trim()
    setRenamingId(null)
    const row = vm.rows.find((r) => r.id === id)
    // An empty name or an unchanged one is a cancel, not an error to report.
    if (!next || next === row?.name) return
    rename(id, next).catch((e: unknown) =>
      toast.error('Could not rename project', {
        description: e instanceof Error ? e.message : String(e)
      })
    )
  }

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
            <li key={row.id} className="group relative flex items-center gap-1">
              {renamingId === row.id ? (
                <input
                  data-testid="project-rename-input"
                  autoFocus
                  ref={renameInput}
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onBlur={() => {
                    if (justOpenedRename.current) {
                      justOpenedRename.current = false
                      // The dropdown closing, not the user leaving — see the ref.
                      renameInput.current?.focus()
                      return
                    }
                    commitRename(row.id)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename(row.id)
                    // Escape abandons the edit without writing anything.
                    if (e.key === 'Escape') setRenamingId(null)
                  }}
                  className="min-w-0 flex-1 rounded border bg-background px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              ) : (
                <button
                  type="button"
                  data-testid="project-open"
                  data-project-id={row.id}
                  aria-current={row.isActive ? 'true' : undefined}
                  aria-busy={opening === row.id}
                  disabled={opening === row.id}
                  onClick={() => handleOpen(row.id)}
                  className={
                    'flex min-w-0 flex-1 flex-col items-start rounded px-2 py-1.5 text-left text-sm hover:bg-accent ' +
                    (row.isActive ? 'bg-accent font-medium' : '')
                  }
                >
                  <span className="w-full truncate">{row.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {opening === row.id ? 'Opening…' : row.updatedLabel}
                  </span>
                </button>
              )}

              <DropdownMenu>
                <DropdownMenuTrigger
                  data-testid="project-menu"
                  data-project-id={row.id}
                  aria-label={`Actions for ${row.name}`}
                  className="shrink-0 rounded px-1.5 py-1 text-muted-foreground hover:bg-accent"
                >
                  ⋯
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="app-no-drag">
                  <DropdownMenuItem
                    data-testid="project-rename"
                    onSelect={() => {
                      setDraftName(row.name)
                      setRenamingId(row.id)
                      justOpenedRename.current = true
                    }}
                  >
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    data-testid="project-duplicate"
                    onSelect={() => {
                      duplicate(row.id)
                        .then((p) => toast.success(`Duplicated as “${p.name}”`))
                        .catch((e: unknown) =>
                          toast.error('Could not duplicate project', {
                            description: e instanceof Error ? e.message : String(e)
                          })
                        )
                    }}
                  >
                    Duplicate
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    data-testid="project-reveal"
                    onSelect={() => {
                      void window.openclip.system
                        .openFolder({ path: row.path })
                        .catch((e: unknown) =>
                          toast.error('Could not reveal project', {
                            description: e instanceof Error ? e.message : String(e)
                          })
                        )
                    }}
                  >
                    Reveal in Finder
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    data-testid="project-delete"
                    variant="destructive"
                    onSelect={() => setConfirmingDelete(row.id)}
                  >
                    Delete…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Deleting a project removes the `.ocproj` and its owned media —
                there is no undo, so it asks. Inline rather than a modal so the
                row being deleted stays visible while the user decides. */}
              {confirmingDelete === row.id && (
                <div
                  data-testid="project-delete-confirm"
                  className="absolute right-0 top-full z-10 mt-1 flex items-center gap-2 rounded-md border bg-popover px-2 py-1.5 text-xs shadow-md"
                >
                  <span>Delete “{row.name}”?</span>
                  <button
                    type="button"
                    data-testid="project-delete-cancel"
                    className="rounded px-1.5 py-0.5 hover:bg-accent"
                    onClick={() => setConfirmingDelete(null)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    data-testid="project-delete-confirm-yes"
                    className="rounded bg-destructive px-1.5 py-0.5 text-destructive-foreground"
                    onClick={() => {
                      setConfirmingDelete(null)
                      remove(row.id)
                        .then(() => toast.success(`Deleted “${row.name}”`))
                        .catch((e: unknown) =>
                          toast.error('Could not delete project', {
                            description: e instanceof Error ? e.message : String(e)
                          })
                        )
                    }}
                  >
                    Delete
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default Dashboard
