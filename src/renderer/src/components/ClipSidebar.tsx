/**
 * ClipSidebar — the list of clip cards w/ scores (T-AI, plan E.3). PRD §11.1
 * (right column) / §11.2.
 *
 * Renders the projectStore clips sorted by virality (highest first) as
 * `ClipCard`s. The sort/view-model logic lives in `ClipCard`'s pure helpers
 * (`sortClipsForSidebar`), unit-tested without a DOM.
 */

import { useProjectStore } from '@renderer/stores/projectStore'
import { ClipCard } from '@renderer/components/ClipCard'
import { sortClipsForSidebar } from '@renderer/components/clipView'

export function ClipSidebar(): React.JSX.Element {
  const clips = useProjectStore((s) => s.clips)
  const generating = useProjectStore((s) => s.generating)
  const generateError = useProjectStore((s) => s.generateError)

  const ordered = sortClipsForSidebar(clips)

  return (
    <div data-testid="clip-sidebar" className="flex h-full flex-col gap-2 p-3">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Clips {clips.length > 0 && <span className="text-foreground">({clips.length})</span>}
      </h2>

      {generating && <p className="text-sm text-muted-foreground">Generating clips…</p>}
      {generateError && (
        <p className="text-sm text-destructive" role="alert">
          {generateError}
        </p>
      )}

      {!generating && clips.length === 0 && (
        <p className="text-sm text-muted-foreground">No clips yet — run “Auto Generate Clips”.</p>
      )}

      {ordered.map((vm) => {
        const clip = clips.find((c) => c.id === vm.id)!
        return <ClipCard key={vm.id} clip={clip} />
      })}
    </div>
  )
}

export default ClipSidebar
