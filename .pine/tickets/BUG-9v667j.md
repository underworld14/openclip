---
id: BUG-9v667j
title: The timeline never zooms — a clip in a long video is a few pixels wide and cannot be trimmed with a mouse
status: todo
priority: high
labels:
    - dead-control
parent: EPIC-k83ghw
phase: p1
created: "2026-08-15T11:28:11Z"
updated: "2026-08-15T11:28:11Z"
---

## Problem
The track always spans the whole source and the zoom shortcut is not wired to it.

## Evidence
- `src/renderer/src/components/Timeline.tsx:134,203` — the track maps the full source
  duration to the full width; the `zoom` store value is not applied to the mapping.
- `App.tsx:271-278` binds `zoom-in`/`zoom-out` to `setZoom`, so Cmd+/Cmd- change a value
  nothing reads.

## Impact
On the app's flagship use case — a 60-minute podcast cut into 45-second shorts — the clip
occupies ~1.2% of the track (about 8px at 700px) and both 8px handles sit on top of each
other. Mouse trimming is impossible; any drag jumps the bounds. The documented zoom
shortcut does nothing.

## Fix
Apply `zoom` (and a scroll offset) to the time↔pixel mapping in `timeline-math.ts`, or
default the visible window to the clip plus padding rather than the whole source.

## Acceptance Criteria
- [ ] Both trim handles are independently grabbable on a 60-minute source
- [ ] Cmd+/Cmd- visibly change the timeline scale
