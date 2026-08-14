/**
 * ClipCard — one clip suggestion w/ virality score + approve/reject (T-AI, E.3).
 * PRD §6.3 / §11.2.
 *
 * The load-bearing presentation logic lives in `./clipView` (pure, unit-tested
 * without a DOM). This file is a thin render of the view model + approve/reject
 * buttons wired to the projectStore.
 */

import type { Clip } from '@shared/schema'
import { toast } from 'sonner'
import { useProjectStore } from '@renderer/stores/projectStore'
import { Button } from '@renderer/components/ui/button'
import { clipViewModel } from '@renderer/components/clipView'

export interface ClipCardProps {
  clip?: Clip
}

export function ClipCard({ clip }: ClipCardProps): React.JSX.Element {
  const approveClip = useProjectStore((s) => s.approveClip)
  const rejectClip = useProjectStore((s) => s.rejectClip)
  const restoreClip = useProjectStore((s) => s.restoreClip)
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
      // A PLAIN CONTAINER (FEAT-ybhdhz). It used to carry role="button" +
      // tabIndex + an Enter/Space handler while nesting real <Button>s for
      // Approve and Reject — interactive controls inside an interactive control,
      // which makes assistive-technology announcement ambiguous and traps Space
      // (the inner buttons and the outer role both claim it). The selectable
      // region is now an explicit <button> around the title block, with the
      // action row as its sibling.
      className={`flex flex-col gap-1 rounded-md border p-2 text-sm ${
        selected ? 'border-primary' : ''
      }`}
    >
      <button
        type="button"
        data-testid="clip-select"
        aria-pressed={selected}
        aria-label={`Select clip: ${vm.title}`}
        onClick={() => selectClip(clip.id)}
        className="flex flex-col gap-1 text-left"
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
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{vm.range}</span>
          {vm.hookType && vm.hookType !== 'none' && (
            <span
              data-testid="hook-type"
              className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium capitalize text-foreground/80"
            >
              {vm.hookType}
            </span>
          )}
        </div>
        <p className="line-clamp-2 text-xs text-muted-foreground">{vm.hook}</p>
      </button>

      {vm.viralityBars && (
        <div className="mt-1 flex flex-col gap-0.5" aria-label="virality breakdown">
          {vm.viralityBars.map((b) => (
            <div key={b.label} className="flex items-center gap-1.5">
              <span className="w-12 shrink-0 text-[10px] text-muted-foreground">{b.label}</span>
              <div className="h-1 flex-1 overflow-hidden rounded bg-muted">
                <div
                  className="h-full rounded bg-amber-500"
                  style={{ width: `${Math.round(b.ratio * 100)}%` }}
                />
              </div>
              <span className="w-7 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
                {b.score}
              </span>
            </div>
          ))}
        </div>
      )}
      {/* The AI wrote these, the mapper carried them and the schema persisted
          them — and nothing ever displayed them, so the user paid for the tokens
          on every generation and never saw the output (FEAT-g39qj3). */}
      {(vm.suggestedCaption || (vm.hashtags && vm.hashtags.length > 0)) && (
        <div className="mt-1 flex flex-col gap-1 border-t pt-1.5" data-testid="clip-social">
          {vm.suggestedCaption && (
            <p
              className="line-clamp-2 text-[11px] text-muted-foreground"
              data-testid="clip-caption"
            >
              {vm.suggestedCaption}
            </p>
          )}
          {vm.hashtags && vm.hashtags.length > 0 && (
            <div className="flex flex-wrap gap-1" data-testid="clip-hashtags">
              {vm.hashtags.map((h) => (
                <span
                  key={h}
                  className="rounded bg-muted px-1 py-0.5 text-[10px] text-foreground/70"
                >
                  {h.startsWith('#') ? h : `#${h}`}
                </span>
              ))}
            </div>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-6 self-start px-1.5 text-[10px]"
            data-testid="clip-copy-caption"
            onClick={(e) => {
              e.stopPropagation()
              // Caption then hashtags, which is the order they get pasted in.
              const text = [
                vm.suggestedCaption,
                (vm.hashtags ?? []).map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ')
              ]
                .filter(Boolean)
                .join('\n\n')
              void navigator.clipboard.writeText(text).then(
                () => toast('Caption copied'),
                () => toast.error('Could not copy to the clipboard')
              )
            }}
          >
            Copy caption
          </Button>
        </div>
      )}

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
        {/* An exported clip rendered NO badge and no actions at all, so a clip
            the user had already shipped looked broken (FEAT-ybhdhz). */}
        {vm.isExported && (
          <span
            className="self-center rounded bg-green-600/15 px-1.5 py-0.5 text-xs font-medium text-green-600"
            data-testid="clip-exported-badge"
          >
            Exported
          </span>
        )}
        {vm.canReject && (
          <Button
            size="sm"
            variant="ghost"
            data-testid="clip-reject"
            onClick={(e) => {
              e.stopPropagation()
              rejectClip(clip.id)
              // Reject is reversible now, but the user cannot know that unless we
              // say so — and the card vanishes from the list the moment they
              // click (FEAT-k28j7h). The toast is where the undo lives.
              toast('Clip hidden', {
                description: clip.title,
                action: { label: 'Undo', onClick: () => restoreClip(clip.id) }
              })
            }}
          >
            Reject
          </Button>
        )}
        {vm.isRejected && (
          <Button
            size="sm"
            variant="secondary"
            data-testid="clip-restore"
            onClick={(e) => {
              e.stopPropagation()
              restoreClip(clip.id)
            }}
          >
            Restore
          </Button>
        )}
      </div>
    </div>
  )
}

export default ClipCard
