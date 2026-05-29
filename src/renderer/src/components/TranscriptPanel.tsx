/**
 * TranscriptPanel — searchable transcript w/ timestamps (T-Media, E.3).
 * PRD §6.2 / §11.2. Reads the hydrated transcript + search query from
 * projectStore (filled live by the transcribe job's partials and finalized by
 * its `done` result) and renders sentence segments with mm:ss timestamps. The
 * search box filters segments by text.
 */

import { Input } from '@renderer/components/ui/input'
import { useProjectStore } from '@renderer/stores/projectStore'
import { formatTimestamp } from '@renderer/components/transcript-format'

export function TranscriptPanel(): React.JSX.Element {
  const transcript = useProjectStore((s) => s.transcript)
  const search = useProjectStore((s) => s.transcriptSearch)
  const setSearch = useProjectStore((s) => s.setTranscriptSearch)
  const matchingSegments = useProjectStore((s) => s.matchingSegments)

  if (!transcript || transcript.segments.length === 0) {
    return (
      <div data-testid="transcript-panel" className="p-3 text-sm text-muted-foreground">
        No transcript yet — import a video and transcribe it.
      </div>
    )
  }

  const segments = matchingSegments()

  return (
    <div data-testid="transcript-panel" className="flex flex-col gap-2 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          Transcript · {transcript.language || 'auto'} · {transcript.segments.length} segments
        </span>
      </div>
      <Input
        type="search"
        placeholder="Search transcript…"
        aria-label="Search transcript"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="h-8 text-sm"
      />
      <ul className="flex flex-col gap-1" data-testid="transcript-segments">
        {segments.map((seg) => (
          <li key={seg.id} className="flex gap-2 text-sm" data-testid="transcript-segment">
            <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
              {formatTimestamp(seg.start)}
            </span>
            <span>{seg.text}</span>
          </li>
        ))}
        {segments.length === 0 && (
          <li className="text-sm text-muted-foreground">No segments match “{search}”.</li>
        )}
      </ul>
    </div>
  )
}

export default TranscriptPanel
