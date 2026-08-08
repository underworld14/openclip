/**
 * TranscriptionSettings — the Settings section for whisper models (FEAT-1k76hk).
 *
 * `Settings.whisperModel` existed in the schema and the store from the start,
 * but Settings had no whisper control at all and the import path hardcoded
 * 'base'. So a user could download `large-v3` and still get `base`
 * transcription, with no way to see what was installed, switch, or reclaim the
 * gigabytes it occupied — models were effectively write-only.
 *
 * One row per model: size/speed/accuracy, an Installed/Not installed badge, a
 * radio to make it the active one, and Delete to free disk.
 */

import { useCallback, useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { WhisperModelSize } from '@shared/jobs'
import type { ModelStatus } from '@shared/channels'
import { WHISPER_MODEL_TABLE } from '@renderer/components/model-download'
import { Button } from '@renderer/components/ui/button'
import { Label } from '@renderer/components/ui/label'
import { formatBytes } from '@renderer/components/formatBytes'

export interface TranscriptionSettingsProps {
  active: WhisperModelSize
  onSelect: (model: WhisperModelSize) => void
  /** Open the download dialog pre-selected on this model. */
  onDownload: (model: WhisperModelSize) => void
  /**
   * Called after the installed set changes, so the readiness chip re-probes.
   * Without it, deleting the ACTIVE model left a green "Transcription ✓" chip
   * over a model that is gone.
   */
  onChanged?: () => void
}

export function TranscriptionSettings({
  active,
  onSelect,
  onDownload,
  onChanged
}: TranscriptionSettingsProps): React.JSX.Element {
  const [statuses, setStatuses] = useState<ModelStatus[]>([])
  const [busy, setBusy] = useState<WhisperModelSize | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setStatuses(await window.openclip.model.status({}))
    } catch {
      setStatuses([])
    }
  }, [])

  // Reading model presence off disk is a subscription to an external system, so
  // the write happens in the promise callback rather than synchronously in the
  // effect body (react-hooks set-state-in-effect).
  useEffect(() => {
    let alive = true
    void window.openclip.model
      .status({})
      .then((rows) => {
        if (alive) setStatuses(rows)
      })
      .catch(() => {
        if (alive) setStatuses([])
      })
    return () => {
      alive = false
    }
    // `refresh` is the same read, used for the post-delete re-probe.
  }, [])

  const installedBytes = statuses.reduce((sum, s) => sum + (s.installed ? (s.bytes ?? 0) : 0), 0)

  const remove = async (model: WhisperModelSize): Promise<void> => {
    // Multi-gigabyte downloads: confirm before discarding one.
    const row = statuses.find((s) => s.model === model)
    const size = formatBytes(row?.bytes)
    if (
      !window.confirm(
        `Delete the ${model} model${size ? ` (${size})` : ''}? You can re-download it later.`
      )
    )
      return
    setBusy(model)
    setError(null)
    try {
      await window.openclip.model.delete({ model })
      await refresh()
      onChanged?.()
    } catch (e) {
      // A silent failure left the row looking installed with no explanation.
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-1.5" data-testid="transcription-settings">
      <div className="flex items-center justify-between">
        <Label>Transcription models</Label>
        {installedBytes > 0 && (
          <span className="text-xs text-muted-foreground">
            {formatBytes(installedBytes)} on disk
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Transcription runs on this Mac. Larger models are more accurate and slower.
      </p>
      {error && (
        <span className="text-xs text-destructive" data-testid="whisper-error">
          {error}
        </span>
      )}
      <ul className="flex flex-col rounded-md border">
        {WHISPER_MODEL_TABLE.map((row) => {
          const status = statuses.find((s) => s.model === row.model)
          const installed = status?.installed ?? false
          return (
            <li
              key={row.model}
              data-testid={`whisper-row-${row.model}`}
              className="flex items-center gap-2 border-b px-2 py-1.5 text-sm last:border-b-0"
            >
              <input
                type="radio"
                name="active-whisper-model"
                aria-label={`Use ${row.model}`}
                checked={active === row.model}
                onChange={() => onSelect(row.model)}
              />
              <span className="font-medium">{row.model}</span>
              <span className="text-xs text-muted-foreground">
                {row.sizeLabel} · {row.speed} · {row.accuracy}
              </span>
              <span className="ml-auto flex items-center gap-1">
                {installed ? (
                  <>
                    <span className="text-xs text-emerald-500">
                      Installed{status?.bytes ? ` · ${formatBytes(status.bytes)}` : ''}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6"
                      aria-label={`Delete ${row.model}`}
                      data-testid={`whisper-delete-${row.model}`}
                      disabled={busy === row.model}
                      onClick={() => void remove(row.model)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    data-testid={`whisper-download-${row.model}`}
                    onClick={() => onDownload(row.model)}
                  >
                    Download
                  </Button>
                )}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export default TranscriptionSettings
