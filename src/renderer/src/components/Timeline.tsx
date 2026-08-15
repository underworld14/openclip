/**
 * Timeline — the MINIMAL single-track trim strip (TIMELINE spine, plan E.5 /
 * PRD §6.6 / §11.1). Scope is deliberately small: ONE track for the selected
 * clip, TWO drag handles (in / out) writing `editedStart`/`editedEnd`, the clip
 * region, a playhead marker, and the MVP keyboard set (I mark-in, O mark-out,
 * Space play/pause). NO multi-track / split / waveform / undo (v0.6 — PRD §6.6).
 *
 * All trim arithmetic lives in the pure `timeline-math` helpers; this component
 * is the thin DOM shell that maps pointer X → time (`pxToWindowTime`, within the
 * current visible WINDOW — see `computeVisibleWindow`, BUG-9v667j) and dispatches
 * the store's trim actions (`dragClipHandle` / `markIn` / `markOut`), which
 * persist `editedStart`/`editedEnd` so `resolveBounds` honours them on export
 * (PRD §6.6 "Export honors the edited bounds").
 */

import { useCallback, useMemo, useRef } from 'react'
import { useProjectStore } from '@renderer/stores/projectStore'
import { resolveBounds } from '@shared/clip-bounds'
import {
  computeVisibleWindow,
  windowToFraction,
  pxToWindowTime,
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
  // The computed reframe plan, for the keyframe dots (FEAT-kzej8t).
  const reframePlan = useProjectStore((s) => s.reframePlan)
  const setPlayhead = useProjectStore((s) => s.setPlayhead)
  const dragClipHandle = useProjectStore((s) => s.dragClipHandle)
  const markIn = useProjectStore((s) => s.markIn)
  const markOut = useProjectStore((s) => s.markOut)
  // The ⌘+/⌘- zoom level (App.tsx). Previously read by nothing (EPIC-k83ghw /
  // BUG-9v667j) — the track always mapped the FULL source onto its width no
  // matter what this said.
  const zoom = useProjectStore((s) => s.zoom)

  const duration = currentProject?.sourceVideo.duration ?? 0
  const clip = clips.find((c) => c.id === selectedClipId) ?? clips[0] ?? null
  const bounds = clip ? resolveBounds(clip) : null
  // Keyed off the PRIMITIVE bounds, not the `bounds` object (resolveBounds
  // returns a fresh one every render) — otherwise this (and `eventTime`
  // below, which depends on it) would recompute on every render regardless
  // of whether the clip's actual bounds moved.
  const visibleWindow = useMemo(
    () => (bounds ? computeVisibleWindow(bounds, duration, zoom) : { start: 0, end: duration }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bounds?.start, bounds?.end, duration, zoom]
  )

  // Map a pointer event to an absolute source time using the track's geometry
  // — within the current visible WINDOW, not the whole source (BUG-9v667j).
  const eventTime = useCallback(
    (clientX: number): number => {
      const el = trackRef.current
      if (!el) return visibleWindow.start
      const rect = el.getBoundingClientRect()
      return pxToWindowTime(clientX - rect.left, rect.width, visibleWindow)
    },
    [visibleWindow]
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

  // Click/drag the track BODY to seek the playhead (openclip-3p3): map pointer X → time
  // and clamp into the clip span (the preview plays that span; its paused playhead→video
  // sync moves the frame). The trim handles stopPropagation, so dragging them never seeks.
  const onTrackPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (!bounds) return
      const t = Math.min(Math.max(eventTime(e.clientX), bounds.start), bounds.end)
      setPlayhead(t)
    },
    [bounds, eventTime, setPlayhead]
  )

  // MVP keyboard set (PRD §6.6 / §11.3): I mark-in, O mark-out.
  //
  // Space is deliberately NOT handled here (EPIC-k83ghw / BUG-bxqmex): it
  // used to toggle play/pause locally AND the app-wide shortcut layer
  // (useGlobalShortcuts) ALSO matched bare Space and toggled the SAME
  // isPlaying flag — but the two handlers read it from different sources
  // (this one from the React-subscribed hook value, the global one via a
  // live `store.getState()` read) and fired in the same synchronous keydown
  // dispatch, so one toggled it and the other immediately toggled it back:
  // Space did nothing at all with the timeline focused, which is exactly
  // what clicking the timeline to seek leaves focused. The global handler
  // now owns playback exclusively.
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
      }
    },
    [clip, duration, markIn, markOut]
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

  const startFrac = windowToFraction(bounds.start, visibleWindow)
  const endFrac = windowToFraction(bounds.end, visibleWindow)
  const playFrac = windowToFraction(playhead, visibleWindow)

  return (
    <div
      data-testid="timeline"
      tabIndex={0}
      role="group"
      // The keys work app-wide now (FEAT-vvaycm) and are listed in the ? sheet
      // and the Clip menu; this label stays for anyone landing here by tab.
      aria-label="Clip timeline — I mark in, O mark out, Space play/pause, ? for all shortcuts"
      onKeyDown={onKeyDown}
      className="flex flex-col gap-1 rounded-md border p-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span className="truncate">{clip.title}</span>
        <span className="tabular-nums" data-testid="timeline-bounds">
          {formatTime(bounds.start)} – {formatTime(bounds.end)}
        </span>
      </div>

      {/* The single track spanning the current visible WINDOW (a comfortable
        margin around the clip, not necessarily the whole source — BUG-9v667j). */}
      <div
        ref={trackRef}
        data-testid="timeline-track"
        onPointerDown={onTrackPointerDown}
        className="relative h-10 w-full cursor-pointer select-none rounded bg-muted"
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

        {/* Auto-reframe pan keyframes (FEAT-kzej8t).

          The computed plan was invisible: the user could not see WHERE the crop
          moves, only that reframing was switched on. Each dot is a point the
          crop is pinned to, at its clip-relative time mapped back onto the
          source timeline — so a pan that swings at the wrong moment is visible
          without exporting. */}
        {reframePlan?.mode === 'pan' &&
          (reframePlan.keyframes ?? []).map((k, i) => {
            const t = bounds.start + k.t
            if (t < bounds.start || t > bounds.end) return null
            return (
              <div
                key={`kf-${i}`}
                data-testid="reframe-keyframe"
                title={`Crop x=${Math.round(k.x)} at ${(bounds.start + k.t).toFixed(2)}s`}
                className="pointer-events-none absolute top-0 size-1.5 -translate-x-1/2 rounded-full bg-sky-400"
                style={{ left: `${windowToFraction(t, visibleWindow) * 100}%` }}
              />
            )
          })}

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
          aria-label="Trim in — left/right arrow keys nudge by one frame"
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
          aria-label="Trim out — shift+left/right arrow keys nudge by one frame"
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
