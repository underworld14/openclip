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
import { trackTask } from '@renderer/stores/jobsStore'
import { Button } from '@renderer/components/ui/button'
import { Progress } from '@renderer/components/ui/progress'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'

export interface ModelDownloadDialogProps {
  open?: boolean
  /** Pre-select a model (e.g. the one the import flow needs). Defaults to base. */
  initialModel?: WhisperModelSize
  /** Called once a model finishes downloading. */
  onDownloaded?: (model: WhisperModelSize) => void
  /**
   * Called when the user dismisses the dialog (Escape, backdrop, or Cancel).
   *
   * Previously there was no way out at all: a hand-rolled `fixed inset-0` div
   * with no Escape handler, no backdrop dismiss and no close control, so the only
   * exit from a mis-click was completing a 75MB–2.9GB download (FEAT-kncqxf).
   */
  onDismiss?: () => void
}

export function ModelDownloadDialog({
  open = false,
  initialModel,
  onDownloaded,
  onDismiss
}: ModelDownloadDialogProps): React.JSX.Element | null {
  const [selected, setSelected] = useState<WhisperModelSize>(initialModel ?? DEFAULT_WHISPER_MODEL)
  const [pct, setPct] = useState(0)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [prevInitial, setPrevInitial] = useState(initialModel)
  const [prevOpen, setPrevOpen] = useState(open)
  // Held so Cancel can abort an in-flight download instead of only hiding the UI.
  const [jobId, setJobId] = useState<string | null>(null)

  // The dialog is mounted once and toggled via `open`; `useState` only read
  // `initialModel` on first mount, so when the import flow later needs a DIFFERENT
  // model the radio kept its stale selection and the user could download the wrong
  // size (audit fix openclip-2x7). React's "adjust state during render when a prop
  // changes" pattern (no effect) re-syncs `selected` — never clobbering a selection
  // mid-download.
  // The component stays mounted and only its content unmounts, so without this a
  // reopened dialog still showed last time's "base ready." or cancellation error.
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open && !busy) {
      setDone(false)
      setErr(null)
      setPct(0)
    }
  }

  if (initialModel !== prevInitial) {
    setPrevInitial(initialModel)
    if (initialModel && !busy) setSelected(initialModel)
  }

  const download = useCallback(
    async (model: WhisperModelSize): Promise<void> => {
      setBusy(true)
      setErr(null)
      setDone(false)
      setPct(0)
      try {
        // Tracked so the download stays visible (and cancellable) in the status
        // bar after this dialog is dismissed — a 2.9GB large-v3 pull outlives
        // any reason the user had for keeping the dialog open (EPIC-zpa1nd).
        await trackTask(
          { kind: 'model-download', label: model, stages: ['downloading'] },
          async (task) => {
            await runModelDownload({
              bridge: window.openclip,
              model,
              onStart: (id) => {
                setJobId(id)
                task.setCancel(() => window.openclip.jobs.cancel(id))
              },
              onProgress: (received, total) => {
                const next = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0
                if (total > 0) setPct(next)
                task.progress(next, 'downloading', {
                  receivedBytes: received,
                  totalBytes: total
                })
              }
            })
          }
        )
        setDone(true)
        onDownloaded?.(model)
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
        setJobId(null)
      }
    },
    [onDownloaded]
  )

  /**
   * Dismiss. A running download is CANCELLED rather than orphaned — hiding the
   * dialog while multiple gigabytes keep streaming would be a worse dead end
   * than the one this replaces.
   */
  const dismiss = useCallback((): void => {
    if (jobId) void window.openclip.jobs.cancel(jobId)
    onDismiss?.()
  }, [jobId, onDismiss])

  if (!open) return null

  return (
    <Dialog open={open} onOpenChange={(o) => !o && dismiss()}>
      <DialogContent className="app-no-drag" data-testid="model-download-dialog">
        <DialogHeader>
          <DialogTitle>Choose a transcription model</DialogTitle>
          <DialogDescription>
            Transcription runs entirely on this Mac, so the model has to be downloaded once. Larger
            models are more accurate and slower.
          </DialogDescription>
        </DialogHeader>
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
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" data-testid="model-download-cancel" onClick={dismiss}>
            {busy ? 'Cancel download' : 'Not now'}
          </Button>
          <Button
            size="sm"
            data-testid="model-download-start"
            disabled={busy}
            onClick={() => void download(selected)}
          >
            {busy ? 'Downloading…' : `Download ${selected}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default ModelDownloadDialog
