---
id: BUG-44fgyv
title: Auto-reframe's motion pass decodes at full resolution and frame rate — roughly 20x the cost of the face pass
status: todo
priority: low
labels:
    - perf
parent: EPIC-k83ghw
phase: p2
created: "2026-08-15T11:28:11Z"
updated: "2026-08-15T11:28:11Z"
---

## Problem
The analysis stage dominates export time on the app's headline use case.

## Evidence
- `src/main/services/reframe-detect.ts:269` — the motion pass decodes full-resolution,
  full-frame-rate video, about 20x the work of the face pass.
- The preview's plan-reframe IPC runs face+motion detection with no `AbortSignal` and no
  PID tracking, so it cannot be cancelled or killed on quit; selecting a second clip while
  a plan is computing drops the request and leaves the previous clip's crop on screen.
- Trimming a clip with "Follow speaker" on re-runs the whole detection pass each time.
- Every clip in a batch export ships the entire transcript word array over IPC, and main
  holds one copy per queued job.

## Impact
A 90-second interview clip pays ~18 seconds of analysis before encoding starts, repeated on
every trim; and the preview can confidently display the wrong clip's framing.

## Fix
Downscale and frame-sample the motion pass, cache plans per clip-bounds, put the plan job
on the job plane so it is cancellable, and pass words by reference/once per batch.

## Acceptance Criteria
- [ ] Motion analysis time drops materially on a 90s clip
- [ ] Switching clips mid-analysis never shows the previous clip's crop
- [ ] A reframe plan is cancellable
