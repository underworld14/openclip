/**
 * PreviewPlayer — HTML5 `<video>` scrubbing of the SOURCE video, seeked to the
 * selected clip's effective bounds (TIMELINE spine, plan E.5 / PRD §6.6 / §11.1
 * center column). NO FFmpeg — pure renderer scrubbing of the original file,
 * loaded over the privileged `openclip-media://` scheme (PRD §6.6 "HTML5 <video>
 * on a registered file:-safe protocol").
 *
 * Behaviour:
 *   - loads the source via `sourceMediaUrl(project.sourceVideo.path)`,
 *   - clamps playback to the selected clip's `resolveBounds` (editedStart/End ??
 *     startTime/endTime) — seeking to the IN point on clip change and pausing at
 *     the OUT point so the preview shows exactly the clip the timeline trims,
 *   - play / pause (wired to the shared `isPlaying` so the timeline Space key
 *     drives it too),
 *   - a current-time + clip-span readout,
 *   - keeps the store `playhead` in sync on `timeupdate` so the Timeline playhead
 *     marker tracks playback.
 */

import { useCallback, useEffect, useRef } from 'react'
import { useProjectStore } from '@renderer/stores/projectStore'
import { resolveBounds } from '@shared/clip-bounds'
import { sourceMediaUrl } from '@renderer/components/source-media'
import { formatTime } from '@renderer/components/timeline-math'
import { Button } from '@renderer/components/ui/button'
import { Play, Pause } from 'lucide-react'

export function PreviewPlayer(): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)

  const currentProject = useProjectStore((s) => s.currentProject)
  const clips = useProjectStore((s) => s.clips)
  const selectedClipId = useProjectStore((s) => s.selectedClipId)
  const isPlaying = useProjectStore((s) => s.isPlaying)
  const setPlaying = useProjectStore((s) => s.setPlaying)
  const setPlayhead = useProjectStore((s) => s.setPlayhead)
  const playhead = useProjectStore((s) => s.playhead)

  const sourcePath = currentProject?.sourceVideo.path ?? null
  const src = sourceMediaUrl(sourcePath)

  const clip = clips.find((c) => c.id === selectedClipId) ?? clips[0] ?? null
  const bounds = clip ? resolveBounds(clip) : null

  // On clip change, seek the <video> to the clip's IN point so the preview
  // starts at the trimmed span (PRD §6.6).
  useEffect(() => {
    const v = videoRef.current
    if (!v || !bounds) return
    if (Math.abs(v.currentTime - bounds.start) > 0.05) {
      v.currentTime = bounds.start
    }
    setPlayhead(bounds.start)
    // Only re-seek when the selected clip's IN point changes (a retrim of the
    // in-handle), not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip?.id, bounds?.start])

  // Drive play/pause from the shared `isPlaying` (so the Timeline Space key and
  // the button stay in sync).
  useEffect(() => {
    const v = videoRef.current
    if (!v || !src) return
    if (isPlaying) void v.play().catch(() => setPlaying(false))
    else v.pause()
  }, [isPlaying, src, setPlaying])

  // Keep the store playhead in sync; pause + clamp at the OUT point so preview
  // never runs past the trimmed span.
  const handleTimeUpdate = useCallback((): void => {
    const v = videoRef.current
    if (!v) return
    if (bounds && v.currentTime >= bounds.end) {
      v.pause()
      v.currentTime = bounds.end
      setPlaying(false)
      setPlayhead(bounds.end)
      return
    }
    setPlayhead(v.currentTime)
  }, [bounds, setPlaying, setPlayhead])

  const togglePlay = useCallback((): void => {
    const v = videoRef.current
    if (!v || !bounds) return
    // Restart from the IN point if we're parked at/after the OUT point.
    if (!isPlaying && v.currentTime >= bounds.end - 0.01) {
      v.currentTime = bounds.start
    }
    setPlaying(!isPlaying)
  }, [bounds, isPlaying, setPlaying])

  return (
    <div data-testid="preview-player" className="flex flex-col gap-2">
      <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-md bg-black/80">
        {src ? (
          <video
            ref={videoRef}
            data-testid="preview-video"
            src={src}
            className="h-full w-full object-contain"
            onTimeUpdate={handleTimeUpdate}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            preload="auto"
          />
        ) : (
          <span className="text-sm text-white/60" data-testid="preview-empty">
            No source video — import a video to preview.
          </span>
        )}
      </div>

      {/* Transport + readout (PRD §6.6: play/pause + current-time display). */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Button
          size="icon"
          variant="secondary"
          aria-label={isPlaying ? 'Pause' : 'Play'}
          data-testid="preview-playpause"
          disabled={!src || !bounds}
          onClick={togglePlay}
        >
          {isPlaying ? <Pause className="size-4" /> : <Play className="size-4" />}
        </Button>
        <span data-testid="preview-time" className="tabular-nums">
          {formatTime(playhead)}
        </span>
        {bounds && (
          <span data-testid="preview-span" className="tabular-nums">
            clip {formatTime(bounds.start)} – {formatTime(bounds.end)} (
            {formatTime(bounds.end - bounds.start)})
          </span>
        )}
      </div>
    </div>
  )
}

export default PreviewPlayer
