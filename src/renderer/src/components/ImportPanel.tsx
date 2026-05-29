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
import { FolderOpen, Loader2 } from 'lucide-react'
import type { WhisperModelSize } from '@shared/jobs'
import { useImportController } from '@renderer/hooks/useImportController'
import { isUrl } from '@renderer/components/import-pipeline'
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

const VIDEO_FILTERS = [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi'] }]

export function ImportPanel({ onNeedModel }: ImportPanelProps = {}): React.JSX.Element {
  const ctl = useImportController({ onNeedModel })
  const [value, setValue] = useState('')

  const chooseFile = async (): Promise<void> => {
    const res = await window.openclip.system.openDialog({
      properties: ['openFile'],
      filters: VIDEO_FILTERS
    })
    if (!res.canceled && res.filePaths[0]) await ctl.importFile(res.filePaths[0])
  }

  const submit = (): void => {
    const v = value.trim()
    if (v && !ctl.busy) void ctl.importAny(v)
  }

  const looksUrl = isUrl(value)

  return (
    <div data-testid="import-panel" className="app-no-drag flex flex-col gap-3">
      <div className="flex gap-2">
        <Input
          data-testid="import-file-input"
          aria-label="Video URL or file path"
          placeholder="Paste a YouTube or video URL…"
          value={value}
          disabled={ctl.busy}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
          className="flex-1"
        />
        <Button data-testid="import-start" onClick={submit} disabled={ctl.busy || !value.trim()}>
          {ctl.busy ? <Loader2 className="size-4 animate-spin" /> : looksUrl ? 'Download' : 'Import'}
        </Button>
      </div>

      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>

      <Button variant="outline" onClick={() => void chooseFile()} disabled={ctl.busy} className="gap-2">
        <FolderOpen className="size-4" />
        Choose a video file…
      </Button>

      {ctl.busy && (
        <div className="flex flex-col gap-1">
          <Progress value={ctl.pct} data-testid="import-progress" />
          <span className="text-xs text-muted-foreground" data-testid="import-stage">
            {ctl.stage} · {ctl.pct}%
          </span>
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
