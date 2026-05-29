/**
 * ClipCard — one clip suggestion w/ virality score + approve/reject (T-AI, E.3).
 * PRD §6.3 / §11.2.
 *
 * The load-bearing presentation logic lives in `./clipView` (pure, unit-tested
 * without a DOM). This file is a thin render of the view model + approve/reject
 * buttons wired to the projectStore.
 */

import type { Clip } from '@shared/schema'
import { useProjectStore } from '@renderer/stores/projectStore'
import { Button } from '@renderer/components/ui/button'
import { clipViewModel } from '@renderer/components/clipView'

export interface ClipCardProps {
  clip?: Clip
}

export function ClipCard({ clip }: ClipCardProps): React.JSX.Element {
  const approveClip = useProjectStore((s) => s.approveClip)
  const rejectClip = useProjectStore((s) => s.rejectClip)
  const selectClip = useProjectStore((s) => s.selectClip)
  const selectedClipId = useProjectStore((s) => s.selectedClipId)

  if (!clip) {
    return (
      <div data-testid="clip-card" className="rounded-md border p-2 text-sm">
        Clip card — stub
      </div>
    )
  }

  const vm = clipViewModel(clip)
  const selected = selectedClipId === clip.id

  return (
    <div
      data-testid="clip-card"
      data-clip-id={clip.id}
      data-selected={selected}
      onClick={() => selectClip(clip.id)}
      className={`flex flex-col gap-1 rounded-md border p-2 text-sm ${
        selected ? 'border-primary' : ''
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="line-clamp-2 font-medium">{vm.title}</span>
        <span
          className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs font-semibold text-amber-600"
          aria-label="virality score"
        >
          ⭐ {vm.score}/10
        </span>
      </div>
      <span className="text-xs text-muted-foreground">{vm.range}</span>
      <p className="line-clamp-2 text-xs text-muted-foreground">{vm.hook}</p>
      <div className="mt-1 flex gap-1">
        {vm.canApprove && (
          <Button
            size="sm"
            variant={vm.isApproved ? 'default' : 'secondary'}
            onClick={(e) => {
              e.stopPropagation()
              approveClip(clip.id)
            }}
          >
            Approve
          </Button>
        )}
        {vm.isApproved && (
          <span className="self-center text-xs font-medium text-green-600">Approved</span>
        )}
        {vm.canReject && (
          <Button
            size="sm"
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation()
              rejectClip(clip.id)
            }}
          >
            Reject
          </Button>
        )}
      </div>
    </div>
  )
}

export default ClipCard
