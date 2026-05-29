/**
 * ClipSidebar — the list of clip cards w/ scores (STUB; owned by T-AI, E.3).
 * PRD §11.1 (right column) / §11.2. Trunk ships the seam only.
 */
export function ClipSidebar(): React.JSX.Element {
  return (
    <div data-testid="clip-sidebar" className="flex h-full flex-col gap-2 p-3">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Clips</h2>
      <p className="text-sm text-muted-foreground">No clips yet — stub</p>
    </div>
  )
}

export default ClipSidebar
