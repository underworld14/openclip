/**
 * ModelDownloadDialog — first-run GGML model picker + download progress (STUB;
 * owned by T-Media, E.3). PRD §13. Trunk ships the seam only.
 */
export interface ModelDownloadDialogProps {
  open?: boolean
}

export function ModelDownloadDialog({
  open = false
}: ModelDownloadDialogProps): React.JSX.Element | null {
  if (!open) return null
  return (
    <div data-testid="model-download-dialog" className="p-3 text-sm text-muted-foreground">
      Download whisper model — stub
    </div>
  )
}

export default ModelDownloadDialog
