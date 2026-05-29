/**
 * Timeline — minimal trim handles writing editedStart/editedEnd (STUB; owned by
 * the timeline spine, E.5). PRD §6.6 / §11.1. Trunk ships the seam only.
 */
export function Timeline(): React.JSX.Element {
  return (
    <div
      data-testid="timeline"
      className="flex h-16 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground"
    >
      Timeline (trim handles, MVP) — stub
    </div>
  )
}

export default Timeline
