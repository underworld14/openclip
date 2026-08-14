/**
 * ClipSidebar — the list of clip cards w/ scores (T-AI, plan E.3). PRD §11.1
 * (right column) / §11.2.
 *
 * Renders the projectStore clips sorted by virality (highest first) as
 * `ClipCard`s. The sort/view-model logic lives in `ClipCard`'s pure helpers
 * (`sortClipsForSidebar`), unit-tested without a DOM.
 */

import { useMemo, useState } from 'react'
import { useProjectStore } from '@renderer/stores/projectStore'
import { ClipCard } from '@renderer/components/ClipCard'
import { partitionRejected, sortClipsForSidebar } from '@renderer/components/clipView'
import { Button } from '@renderer/components/ui/button'
import { Progress } from '@renderer/components/ui/progress'

export function ClipSidebar(): React.JSX.Element {
  const clips = useProjectStore((s) => s.clips)
  const generating = useProjectStore((s) => s.generating)
  const generateError = useProjectStore((s) => s.generateError)
  const generatePct = useProjectStore((s) => s.generatePct)
  const generateChunk = useProjectStore((s) => s.generateChunk)
  const provisionalClips = useProjectStore((s) => s.provisionalClips)
  const cancelGenerate = useProjectStore((s) => s.cancelGenerate)

  // Rejected clips are hidden, not deleted (FEAT-k28j7h). Keep them one click
  // away rather than gone, so Reject stops being a destructive action.
  const [showHidden, setShowHidden] = useState(false)

  // Memoize the sort so it only re-runs when the clips array changes — not on every
  // selection/approval re-render (audit fix openclip-don).
  const { visible, hidden } = useMemo(() => partitionRejected(clips), [clips])
  const ordered = useMemo(() => sortClipsForSidebar(visible), [visible])
  const orderedHidden = useMemo(() => sortClipsForSidebar(hidden), [hidden])
  const provisional = useMemo(() => sortClipsForSidebar(provisionalClips), [provisionalClips])
  const showProvisional = generating && provisional.length > 0

  return (
    <div data-testid="clip-sidebar" className="flex h-full flex-col gap-2 p-3">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Clips {visible.length > 0 && <span className="text-foreground">({visible.length})</span>}
      </h2>

      {/* Was the bare text "Generating clips…" for a 2-6 minute operation with no
          way out (FEAT-c0zn3j). Map-reduce always knew its chunk count; nothing
          had ever asked it. */}
      {generating && (
        <div className="flex flex-col gap-1.5" data-testid="generate-progress">
          <Progress value={generatePct} className="h-1" />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground" data-testid="generate-stage">
              {generateChunk
                ? `Analyzing chunk ${generateChunk.index + 1} of ${generateChunk.count}`
                : 'Analyzing transcript…'}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px]"
              data-testid="generate-cancel"
              onClick={() => void cancelGenerate()}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {generateError && (
        <p className="text-sm text-destructive" role="alert" data-testid="generate-error">
          {generateError}
        </p>
      )}

      {!generating && visible.length === 0 && hidden.length === 0 && (
        <p className="text-sm text-muted-foreground">No clips yet — run “Auto Generate Clips”.</p>
      )}

      {/* While a run is producing candidates, show THOSE rather than the previous
          run's results — a list mixing last time's ranked clips with this time's
          unranked ones is unreadable. The old clips are not discarded: they stay
          in the store and come back if this run fails or is cancelled, so a
          regeneration can never lose what the user already had. */}
      {showProvisional
        ? provisional.map((clip) => (
            <div key={clip.id} className="opacity-60" data-testid="provisional-clip">
              <ClipCard clip={clip} />
            </div>
          ))
        : ordered.map((clip) => <ClipCard key={clip.id} clip={clip} />)}

      {/* Rejected clips live here rather than being destroyed (FEAT-k28j7h). */}
      {!showProvisional && hidden.length > 0 && (
        <div className="flex flex-col gap-2 border-t pt-2" data-testid="hidden-clips">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 justify-start px-2 text-[11px] text-muted-foreground"
            data-testid="hidden-clips-toggle"
            onClick={() => setShowHidden((v) => !v)}
          >
            {hidden.length} hidden · {showHidden ? 'Hide' : 'Show'}
          </Button>
          {showHidden &&
            orderedHidden.map((clip) => (
              <div key={clip.id} className="opacity-60" data-testid="hidden-clip">
                <ClipCard clip={clip} />
              </div>
            ))}
        </div>
      )}
    </div>
  )
}

export default ClipSidebar
