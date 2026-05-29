/**
 * ClipCard — one clip suggestion w/ virality score + approve/reject (STUB;
 * owned by T-AI, E.3). PRD §6.3 / §11.2. Trunk ships the seam only.
 */
import type { Clip } from '@shared/schema'

export interface ClipCardProps {
  clip?: Clip
}

export function ClipCard({ clip }: ClipCardProps): React.JSX.Element {
  return (
    <div data-testid="clip-card" className="rounded-md border p-2 text-sm">
      {clip ? `${clip.title} — ${clip.viralityScore}/10` : 'Clip card — stub'}
    </div>
  )
}

export default ClipCard
