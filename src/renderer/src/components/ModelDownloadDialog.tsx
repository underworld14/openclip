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
  startModelDownload
} from '@renderer/components/model-download'
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
   * Called when the user dismisses the dialog (Escape, backdrop, or a button).
   *
   * Previously there was no way out at all: a hand-rolled `fixed inset-0` div
   * with no Escape handler, no backdrop dismiss and no close control, so the only
   * exit from a mis-click was completing a 75MB–2.9GB download (FEAT-kncqxf).
   *
   * `stillDownloading` says whether a transfer was left running, so the caller
   * can tell the user where it went — dismissal no longer cancels (BUG-45xt77).
   */
  onDismiss?: (stillDownloading: boolean) => void
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
  // Held so the explicit Cancel button can abort the transfer. Dismissing the
  // dialog deliberately does NOT use this — see `dismiss` below.
  const [cancelDownload, setCancelDownload] = useState<(() => void) | null>(null)

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
    (model: WhisperModelSize): void => {
      setBusy(true)
      setErr(null)
      setDone(false)
      setPct(0)
      // One shared starter, so this dialog, the settings row and the readiness
      // chip behave identically in the status bar (BUG-45xt77).
      const handle = startModelDownload({
        model,
        onProgress: (next) => setPct(next),
        onDone: (m) => {
          setBusy(false)
          setDone(true)
          onDownloaded?.(m)
        },
        onError: (message) => {
          setBusy(false)
          setErr(message)
        }
      })
      setCancelDownload(() => handle.cancel)
    },
    [onDownloaded]
  )

  /**
   * Dismiss — WITHOUT cancelling.
   *
   * This used to call `jobs.cancel` on Escape, backdrop click, ✕ and "Not now",
   * so there was no way to let a download continue while you did anything else:
   * the status bar row exists precisely to outlive this dialog, and both dialogs
   * are Radix `modal`, so the bar is click-inert underneath. Closing to reach the
   * bar therefore killed the very download you were trying to keep (BUG-45xt77).
   * Cancelling is now its own explicitly-labelled button, matching the export
   * flow's "continues in the background" behaviour.
   */
  const dismiss = useCallback((): void => {
    onDismiss?.(busy)
  }, [busy, onDismiss])

  /** Explicit cancel: stop the transfer AND close. */
  const cancel = useCallback((): void => {
    cancelDownload?.()
    onDismiss?.(false)
  }, [cancelDownload, onDismiss])

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
        <div className="flex items-center justify-end gap-2">
          {busy && (
            <Button size="sm" variant="ghost" data-testid="model-download-cancel" onClick={cancel}>
              Cancel download
            </Button>
          )}
          <Button size="sm" variant="ghost" data-testid="model-download-dismiss" onClick={dismiss}>
            {/* Closing no longer stops the transfer — say so, rather than leaving
                "Not now" to imply it did. */}
            {busy ? 'Continue in background' : 'Not now'}
          </Button>
          <Button
            size="sm"
            data-testid="model-download-start"
            disabled={busy}
            onClick={() => download(selected)}
          >
            {busy ? 'Downloading…' : `Download ${selected}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default ModelDownloadDialog
