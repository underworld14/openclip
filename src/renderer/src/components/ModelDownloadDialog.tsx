/**
 * ModelDownloadDialog — first-run GGML model picker + download progress
 * (T-Media, E.3). PRD §13 / §6.2: models are not bundled; on first transcribe (or
 * via the "Models" affordance) the user picks a size and we stream it from
 * HuggingFace with SHA-verified byte progress over a `model-download` job port.
 *
 * The model table + the pure download orchestration live in `model-download.ts`
 * (unit-tested); this is the UI shell. App mounts it as
 * `<ModelDownloadDialog open={…} />`, so `open` keeps its trunk prop shape.
 */

import { useCallback, useState } from 'react'
import type { WhisperModelSize } from '@shared/jobs'
import {
  WHISPER_MODEL_TABLE,
  DEFAULT_WHISPER_MODEL,
  runModelDownload
} from '@renderer/components/model-download'
import { Button } from '@renderer/components/ui/button'
import { Progress } from '@renderer/components/ui/progress'

export interface ModelDownloadDialogProps {
  open?: boolean
  /** Pre-select a model (e.g. the one the import flow needs). Defaults to base. */
  initialModel?: WhisperModelSize
  /** Called once a model finishes downloading. */
  onDownloaded?: (model: WhisperModelSize) => void
}

export function ModelDownloadDialog({
  open = false,
  initialModel,
  onDownloaded
}: ModelDownloadDialogProps): React.JSX.Element | null {
  const [selected, setSelected] = useState<WhisperModelSize>(initialModel ?? DEFAULT_WHISPER_MODEL)
  const [pct, setPct] = useState(0)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const download = useCallback(
    async (model: WhisperModelSize): Promise<void> => {
      setBusy(true)
      setErr(null)
      setDone(false)
      setPct(0)
      try {
        await runModelDownload({
          bridge: window.openclip,
          model,
          onProgress: (received, total) => {
            if (total > 0) setPct(Math.min(100, Math.round((received / total) * 100)))
          }
        })
        setDone(true)
        onDownloaded?.(model)
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [onDownloaded]
  )

  if (!open) return null

  return (
    <div
      data-testid="model-download-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    >
      <div className="w-[28rem] max-w-[90vw] rounded-lg border bg-background p-4 shadow-lg">
        <h2 className="mb-1 text-base font-semibold">Download a transcription model</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Models are downloaded on demand (PRD §13). Pick a speed/quality/disk trade-off.
        </p>
        <ul className="mb-3 flex flex-col gap-1" data-testid="model-table">
          {WHISPER_MODEL_TABLE.map((row) => (
            <li key={row.model}>
              <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent">
                <input
                  type="radio"
                  name="whisper-model"
                  value={row.model}
                  checked={selected === row.model}
                  onChange={() => setSelected(row.model)}
                />
                <span className="font-medium">{row.model}</span>
                <span className="text-xs text-muted-foreground">
                  {row.sizeLabel} · {row.speed} · {row.accuracy}
                </span>
              </label>
            </li>
          ))}
        </ul>
        {busy && (
          <div className="mb-3 flex flex-col gap-1">
            <Progress value={pct} data-testid="model-progress" />
            <span className="text-xs text-muted-foreground">{pct}%</span>
          </div>
        )}
        {done && (
          <span className="mb-2 block text-xs text-green-600" data-testid="model-done">
            {selected} ready.
          </span>
        )}
        {err && (
          <span className="mb-2 block text-xs text-destructive" data-testid="model-error">
            {err}
          </span>
        )}
        <div className="flex justify-end">
          <Button
            size="sm"
            data-testid="model-download-start"
            disabled={busy}
            onClick={() => void download(selected)}
          >
            {busy ? 'Downloading…' : `Download ${selected}`}
          </Button>
        </div>
      </div>
    </div>
  )
}

export default ModelDownloadDialog
