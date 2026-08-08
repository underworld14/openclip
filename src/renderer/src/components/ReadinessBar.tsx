/**
 * ReadinessBar — the persistent first-run status chips (FEAT-c5a15c).
 *
 * Three clickable chips in the title bar: transcription model, AI provider, and
 * the video engine. Red on a fresh install, each one deep-linking to the thing
 * that fixes it. The pattern is lifted from yt-short-clipper, which puts
 * 'Library' and 'API' chips in its header and keeps the primary action greyed
 * until both are green.
 *
 * Presentation only — the state lives in `useReadiness`, the decisions in the
 * pure `readinessView`.
 */

import { AlertCircle, Check, Loader2 } from 'lucide-react'
import type { ReadinessChip } from '@renderer/components/readinessView'

export interface ReadinessBarProps {
  chips: ReadinessChip[]
  onOpenSettings: () => void
  onDownloadModel: () => void
}

export function ReadinessBar({
  chips,
  onOpenSettings,
  onDownloadModel
}: ReadinessBarProps): React.JSX.Element {
  return (
    <div data-testid="readiness-bar" className="flex items-center gap-1">
      {chips.map((chip) => {
        const clickable = chip.action !== 'none'
        return (
          <button
            key={chip.id}
            type="button"
            data-testid={`readiness-chip-${chip.id}`}
            data-state={chip.state}
            // The detail line carries the WHY; a chip that only says "not ready"
            // sends the user hunting.
            title={`${chip.label} — ${chip.detail}`}
            aria-label={`${chip.label} — ${chip.detail}`}
            disabled={!clickable}
            onClick={() => {
              if (chip.action === 'settings') onOpenSettings()
              else if (chip.action === 'download-model') onDownloadModel()
            }}
            className={
              'flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors ' +
              (chip.state === 'ok'
                ? 'border-emerald-500/30 text-emerald-500'
                : chip.state === 'unknown'
                  ? 'border-border text-muted-foreground'
                  : 'border-destructive/40 text-destructive hover:bg-destructive/10')
            }
          >
            {chip.state === 'ok' ? (
              <Check className="size-3" />
            ) : chip.state === 'unknown' ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <AlertCircle className="size-3" />
            )}
            {chip.label}
          </button>
        )
      })}
    </div>
  )
}

export default ReadinessBar
