/**
 * Welcome — the first-run screen (F.2). Shown when there is no project content
 * yet: a focused hero with the unified smart-import controls (file picker + drop
 * + YouTube/URL field, via ImportPanel) and a recent-projects list. Once a source
 * video / transcript / clips exist, App swaps to the 3-pane editor.
 */

import { toast } from 'sonner'
import { Clapperboard, Clock } from 'lucide-react'
import type { WhisperModelSize } from '@shared/jobs'
import { ImportPanel } from '@renderer/components/ImportPanel'
import { useProject } from '@renderer/hooks/useProject'
import { dashboardViewModel } from '@renderer/components/Dashboard.view'

export interface WelcomeProps {
  onNeedModel?: (model: WhisperModelSize) => void
}

export function Welcome({ onNeedModel }: WelcomeProps = {}): React.JSX.Element {
  const { recentProjects, currentProject, open } = useProject()
  const vm = dashboardViewModel(recentProjects, currentProject?.id ?? null)

  return (
    <div data-testid="welcome" className="flex h-full items-center justify-center p-8">
      <div className="flex w-full max-w-lg flex-col gap-7">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Clapperboard className="size-7" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">OpenClip</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Turn a long video into viral shorts — drop a file or paste a YouTube link.
            </p>
          </div>
        </div>

        <div className="rounded-xl border bg-card/60 p-4 shadow-sm backdrop-blur">
          <ImportPanel onNeedModel={onNeedModel} />
        </div>

        {!vm.isEmpty && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <Clock className="size-3" /> Recent projects
            </div>
            <ul className="flex flex-col">
              {vm.rows.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    onClick={() =>
                      // Was `void open(...)`, which DISCARDED the rejection: a
                      // project whose file had moved just silently refused to
                      // open, with no spinner and no error (FEAT-905vk4).
                      open(row.id).catch((e: unknown) =>
                        toast.error('Could not open project', {
                          description: e instanceof Error ? e.message : String(e)
                        })
                      )
                    }
                    className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm hover:bg-accent"
                  >
                    <span className="truncate">{row.name}</span>
                    <span className="ml-3 shrink-0 text-xs text-muted-foreground">
                      {row.updatedLabel}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}

export default Welcome
