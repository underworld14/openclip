/**
 * TranscriptPanel — searchable transcript w/ timestamps (T-Media, E.3).
 * PRD §6.2 / §11.2. Reads the hydrated transcript + search query from
 * projectStore (filled live by the transcribe job's partials and finalized by
 * its `done` result) and renders sentence segments with mm:ss timestamps. The
 * search box filters segments by text.
 */

import { useMemo } from 'react'
import { Input } from '@renderer/components/ui/input'
import { useProjectStore } from '@renderer/stores/projectStore'
import { formatTimestamp } from '@renderer/components/transcript-format'

export function TranscriptPanel(): React.JSX.Element {
  const transcript = useProjectStore((s) => s.transcript)
  const search = useProjectStore((s) => s.transcriptSearch)
  const setSearch = useProjectStore((s) => s.setTranscriptSearch)

  // Memoize the filtered segments (openclip-v7z): re-filter the (growing) segment list
  // ONLY when the transcript or query actually changes, not on every unrelated re-render.
  // Mirrors the store's `matchingSegments` but computed inline so the deps are exact.
  // Hooks run before the early return below so their order stays stable.
  const segments = useMemo(() => {
    if (!transcript) return []
    const q = search.trim().toLowerCase()
    if (q.length === 0) return transcript.segments
    return transcript.segments.filter((seg) => seg.text.toLowerCase().includes(q))
  }, [transcript, search])

  if (!transcript || transcript.segments.length === 0) {
    return (
      <div data-testid="transcript-panel" className="p-3 text-sm text-muted-foreground">
        No transcript yet — import a video and transcribe it.
      </div>
    )
  }

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
      {/* Scroll container + per-row content-visibility (openclip-v7z): a long video
          yields thousands of sentence segments. content-visibility:auto lets the browser
          skip layout/paint for off-screen rows (native windowing that handles variable
          row heights, no library/scroll-math); contain-intrinsic-size reserves an
          estimated height so the scrollbar stays stable. */}
      <ul
        className="flex max-h-[60vh] flex-col gap-1 overflow-y-auto"
        data-testid="transcript-segments"
      >
        {segments.map((seg) => (
          <li
            key={seg.id}
            className="flex gap-2 text-sm [content-visibility:auto] [contain-intrinsic-size:auto_1.75rem]"
            data-testid="transcript-segment"
          >
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
