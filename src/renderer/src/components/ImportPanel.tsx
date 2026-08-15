/**
 * ImportPanel — the unified smart-import controls (F.2/F.4). One field accepts a
 * local file path OR a pasted YouTube/video URL (auto-detected), plus a native
 * "Choose a video file…" picker. URL imports download via yt-dlp (with a one-time
 * TOS consent) then run the same probe→extract→transcribe pipeline as files.
 *
 * Reused both on the Welcome screen and inside the editor's "Import" dialog. The
 * orchestration lives in `useImportController`; this is the thin UI shell.
 * Test ids (import-panel / import-file-input / import-start / import-progress /
 * import-stage / import-error) are preserved for the E2E/unit suites.
 */

import { useState } from 'react'
import { FolderOpen, Loader2, Upload } from 'lucide-react'
import type { WhisperModelSize } from '@shared/jobs'
import { useImportController } from '@renderer/hooks/useImportController'
import { isUrl, resolveDroppedFile } from '@renderer/components/import-pipeline'
import { useReadiness } from '@renderer/hooks/useReadiness'
import { stageLabel } from '@renderer/components/jobStatus'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Progress } from '@renderer/components/ui/progress'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@renderer/components/ui/dialog'

export interface ImportPanelProps {
  /** Open the first-run model-download dialog (wired by App). */
  onNeedModel?: (model: WhisperModelSize) => void
}

export function ImportPanel({ onNeedModel }: ImportPanelProps = {}): React.JSX.Element {
  const ctl = useImportController({ onNeedModel })
  const [value, setValue] = useState('')
  const [dragging, setDragging] = useState(false)
  const [dropError, setDropError] = useState<string | null>(null)
  const readiness = useReadiness()

  const chooseFile = async (): Promise<void> => {
    // The picker is scoped server-side to a single video file (G.7); no inputs.
    const res = await window.openclip.system.openDialog({})
    if (!res.canceled && res.filePaths[0]) await ctl.importFile(res.filePaths[0])
  }

  const submit = (): void => {
    const v = value.trim()
    if (v && !ctl.busy && !urlBlocked) void ctl.importAny(v)
  }

  const looksUrl = isUrl(value)

  /**
   * Is yt-dlp actually present? (FEAT-azqfsv)
   *
   * `SYSTEM_PREFLIGHT` has always reported `ytDlp` and NOTHING read it —
   * reporting something nothing reads is exactly how `whisperCli` ended up
   * probed-and-ignored. It does not belong in the three general readiness chips
   * (a missing yt-dlp only breaks URL import), so it is surfaced HERE, at the
   * moment it matters: the instant a URL is in the field.
   *
   * `undefined` while the preflight is in flight — treated as available, because
   * blocking a paste on a probe that has not answered yet would be worse than
   * letting the download fail with the real error.
   */
  const ytDlpMissing = readiness.preflight?.ytDlp.ok === false
  const urlBlocked = looksUrl && ytDlpMissing

  /**
   * Drag-and-drop import (FEAT-hmsg5h). The Welcome copy has always told the user
   * to "drop a file", and it is the first acceptance criterion of PRD §6.1.
   *
   * `stopPropagation` (EPIC-k83ghw / BUG-aryvgg): the window now ALSO has a
   * drop target (App.tsx, for anywhere outside this panel) — without this, a
   * drop landing here would bubble up and get imported a second time.
   */
  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setDragging(false)
    setDropError(null)
    if (ctl.busy) return
    const file = e.dataTransfer.files?.[0]
    if (!file) return
    const { path, warning } = resolveDroppedFile(file, window.openclip.files.getPathForFile)
    if (warning) setDropError(warning)
    if (path) void ctl.importFile(path)
  }

  return (
    <div
      data-testid="import-panel"
      className={
        'app-no-drag flex flex-col gap-3 rounded-lg transition-colors ' +
        (dragging ? 'outline-2 outline-dashed outline-offset-4 outline-primary' : '')
      }
      onDragOver={(e) => {
        e.preventDefault()
        if (!ctl.busy) setDragging(true)
      }}
      onDragLeave={(e) => {
        // Only clear when the pointer actually leaves the panel, not when it
        // crosses between children (dragleave fires on every child boundary).
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={onDrop}
    >
      {dragging && (
        <div
          data-testid="import-dropzone"
          className="flex items-center justify-center gap-2 rounded-md border-2 border-dashed border-primary bg-primary/5 px-3 py-6 text-sm text-primary"
        >
          <Upload className="size-4" /> Drop a video here
        </div>
      )}
      {dropError && (
        <span className="text-xs text-amber-500" data-testid="import-drop-warning">
          {dropError}
        </span>
      )}
      <div className="flex gap-2">
        <Input
          data-testid="import-file-input"
          aria-label="Video URL or file path"
          placeholder="Paste a YouTube URL, or drop a video file…"
          value={value}
          disabled={ctl.busy}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
          className="flex-1"
        />
        <Button
          data-testid="import-start"
          onClick={submit}
          disabled={ctl.busy || !value.trim() || urlBlocked}
        >
          {ctl.busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : looksUrl ? (
            'Download'
          ) : (
            'Import'
          )}
        </Button>
      </div>
      {urlBlocked && (
        <p className="text-xs text-amber-600" data-testid="url-import-blocked">
          URL download needs yt-dlp, which is missing from this install. Import a local file
          instead, or reinstall OpenClip.
        </p>
      )}

      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>

      <Button
        variant="outline"
        onClick={() => void chooseFile()}
        disabled={ctl.busy}
        className="gap-2"
      >
        <FolderOpen className="size-4" />
        Choose a video file…
      </Button>

      {ctl.busy && (
        <div className="flex flex-col gap-1">
          <Progress value={ctl.pct} data-testid="import-progress" />
          <div className="flex items-center justify-between gap-2">
            {/* Was the raw internal token — "transcribing · 62%" (FEAT-8559h1).
                Same `stageLabel` map the status bar uses, so the two surfaces
                cannot describe the same stage differently. */}
            <span className="text-xs text-muted-foreground" data-testid="import-stage">
              {stageLabel(ctl.stage) || 'Working'} · {ctl.pct}%
            </span>
            {/* Cancel the in-flight download/transcribe (openclip-2bm). */}
            <Button
              variant="ghost"
              size="sm"
              data-testid="import-cancel"
              onClick={() => void ctl.cancel()}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {ctl.error && (
        <span className="text-xs text-destructive" data-testid="import-error">
          {ctl.error}
        </span>
      )}

      {/* One-time yt-dlp / TOS consent before the first URL download (PRD §20.4). */}
      <Dialog open={ctl.needsConsent} onOpenChange={(o) => !o && ctl.declineConsent()}>
        <DialogContent className="app-no-drag">
          <DialogHeader>
            <DialogTitle>Download from a URL?</DialogTitle>
            <DialogDescription>
              OpenClip uses yt-dlp to download videos. Only download content you own or are licensed
              to use — you are responsible for complying with each platform&apos;s Terms of Service
              and copyright.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={ctl.declineConsent}>
              Cancel
            </Button>
            <Button onClick={ctl.acceptConsent}>I understand — download</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default ImportPanel
