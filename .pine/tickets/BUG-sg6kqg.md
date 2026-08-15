---
id: BUG-sg6kqg
title: Cancel is a silent no-op during 'Reading video' and 'Extracting audio'
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
Two import stages run as plain `invoke` calls with no cancellation path.

## Evidence
- `src/main/ipc/audio.ts:33` — audio extraction is a plain handler: no `AbortSignal`, no
  PID tracking in `SidecarManager`, no progress events.
- `src/renderer/src/hooks/import-controller.ts:508` — Cancel has nothing to call for these
  stages.
- `jobStatus.ts:161-169` extrapolates an ETA from a percentage that never moves.

## Impact
On a 2–3 hour podcast, "Extracting audio" runs for minutes with the bar frozen at 12% and
an ETA that inflates every second. The user concludes it has hung and presses Cancel — in
the panel, then in the status bar — and absolutely nothing happens.

## Fix
Move extraction (and probe) onto the job plane so they get progress, PID tracking and
cancellation like every other long operation.

## Acceptance Criteria
- [ ] Cancel during "Extracting audio" stops the ffmpeg child and returns the UI to idle
- [ ] The progress bar advances during extraction, or the ETA is suppressed
