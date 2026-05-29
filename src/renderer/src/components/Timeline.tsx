/**
 * Timeline — the MINIMAL single-track trim strip (TIMELINE spine, plan E.5 /
 * PRD §6.6 / §11.1). Scope is deliberately small: ONE track for the selected
 * clip, TWO drag handles (in / out) writing `editedStart`/`editedEnd`, the clip
 * region, a playhead marker, and the MVP keyboard set (I mark-in, O mark-out,
 * Space play/pause). NO multi-track / split / waveform / undo (v0.6 — PRD §6.6).
 *
 * All trim arithmetic lives in the pure `timeline-math` helpers; this component
 * is the thin DOM shell that maps pointer X → time (`pxToTime`) and dispatches
 * the store's trim actions (`dragClipHandle` / `markIn` / `markOut`), which
 * persist `editedStart`/`editedEnd` so `resolveBounds` honours them on export
 * (PRD §6.6 "Export honors the edited bounds").
 */

import { useCallback, useRef } from 'react'
import { useProjectStore } from '@renderer/stores/projectStore'
import { resolveBounds } from '@shared/clip-bounds'
import {
  pxToTime,
  timeToFraction,
  formatTime,
  type TrimHandle
} from '@renderer/components/timeline-math'

export function Timeline(): React.JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef<TrimHandle | null>(null)

  const currentProject = useProjectStore((s) => s.currentProject)
  const clips = useProjectStore((s) => s.clips)
  const selectedClipId = useProjectStore((s) => s.selectedClipId)
  const playhead = useProjectStore((s) => s.playhead)
  const isPlaying = useProjectStore((s) => s.isPlaying)
  const setPlaying = useProjectStore((s) => s.setPlaying)
  const dragClipHandle = useProjectStore((s) => s.dragClipHandle)
  const markIn = useProjectStore((s) => s.markIn)
  const markOut = useProjectStore((s) => s.markOut)

  const duration = currentProject?.sourceVideo.duration ?? 0
  const clip = clips.find((c) => c.id === selectedClipId) ?? clips[0] ?? null
  const bounds = clip ? resolveBounds(clip) : null

  // Map a pointer event to an absolute source time using the track's geometry.
  const eventTime = useCallback(
    (clientX: number): number => {
      const el = trackRef.current
      if (!el) return 0
      const rect = el.getBoundingClientRect()
      return pxToTime(clientX - rect.left, rect.width, duration)
    },
    [duration]
  )

  const onHandlePointerDown = useCallback(
    (handle: TrimHandle) =>
      (e: React.PointerEvent<HTMLButtonElement>): void => {
        e.preventDefault()
        e.stopPropagation()
        draggingRef.current = handle
        e.currentTarget.setPointerCapture(e.pointerId)
      },
    []
  )

  const onHandlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>): void => {
      const handle = draggingRef.current
      if (!handle || !clip) return
      dragClipHandle(clip.id, handle, eventTime(e.clientX), duration)
    },
    [clip, dragClipHandle, duration, eventTime]
  )

  const onHandlePointerUp = useCallback((e: React.PointerEvent<HTMLButtonElement>): void => {
    draggingRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }, [])

  // MVP keyboard set (PRD §6.6 / §11.3): I mark-in, O mark-out, Space play/pause.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>): void => {
      if (!clip) return
      switch (e.key) {
        case 'i':
        case 'I':
          e.preventDefault()
          markIn(clip.id)
          break
        case 'o':
        case 'O':
          e.preventDefault()
          markOut(clip.id, duration)
          break
        case ' ':
        case 'Spacebar':
          e.preventDefault()
          setPlaying(!isPlaying)
          break
      }
    },
    [clip, duration, isPlaying, markIn, markOut, setPlaying]
  )

  if (!clip || !bounds || !(duration > 0)) {
    return (
      <div
        data-testid="timeline"
        className="flex h-16 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground"
      >
        {clips.length === 0
          ? 'Generate or select a clip to trim.'
          : 'Import a source video to enable the timeline.'}
      </div>
    )
  }

  const startFrac = timeToFraction(bounds.start, duration)
  const endFrac = timeToFraction(bounds.end, duration)
  const playFrac = timeToFraction(playhead, duration)

  return (
    <div
      data-testid="timeline"
      tabIndex={0}
      role="group"
      aria-label="Clip timeline — I mark in, O mark out, Space play/pause"
      onKeyDown={onKeyDown}
      className="flex flex-col gap-1 rounded-md border p-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span className="truncate">{clip.title}</span>
        <span className="tabular-nums" data-testid="timeline-bounds">
          {formatTime(bounds.start)} – {formatTime(bounds.end)}
        </span>
      </div>

      {/* The single track spanning the full source duration. */}
      <div
        ref={trackRef}
        data-testid="timeline-track"
        className="relative h-10 w-full select-none rounded bg-muted"
      >
        {/* The selected clip region. */}
        <div
          data-testid="timeline-clip-region"
          className="absolute top-0 h-full rounded bg-primary/30"
          style={{
            left: `${startFrac * 100}%`,
            width: `${Math.max(0, endFrac - startFrac) * 100}%`
          }}
        />

        {/* Playhead marker. */}
        <div
          data-testid="timeline-playhead"
          className="pointer-events-none absolute top-0 h-full w-0.5 bg-foreground"
          style={{ left: `${playFrac * 100}%` }}
        />

        {/* IN handle. */}
        <button
          type="button"
          data-testid="timeline-handle-in"
          aria-label="Trim in"
          onPointerDown={onHandlePointerDown('in')}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerUp}
          className="absolute top-0 h-full w-2 -translate-x-1/2 cursor-ew-resize rounded-l bg-primary"
          style={{ left: `${startFrac * 100}%` }}
        />

        {/* OUT handle. */}
        <button
          type="button"
          data-testid="timeline-handle-out"
          aria-label="Trim out"
          onPointerDown={onHandlePointerDown('out')}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerUp}
          className="absolute top-0 h-full w-2 -translate-x-1/2 cursor-ew-resize rounded-r bg-primary"
          style={{ left: `${endFrac * 100}%` }}
        />
      </div>
    </div>
  )
}

export default Timeline
