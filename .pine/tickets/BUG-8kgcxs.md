---
id: BUG-8kgcxs
title: Framing mode and manual crop reset to Fill on every restart
status: todo
priority: medium
labels:
    - wysiwyg
parent: EPIC-k83ghw
phase: p1
created: "2026-08-15T11:28:11Z"
updated: "2026-08-15T11:28:11Z"
---

## Problem
The framing choice lives in a non-persisted slice.

## Evidence
- `src/renderer/src/stores/projectStore/previewSlice.ts:59` — `reframeMode` is initialised
  from a default on load rather than rehydrated from the project document, so a saved
  manual crop also stops being applied.

## Impact
The user sets "Follow speaker", hand-places the crop on the right speaker, exports one
clip, quits for the night — and next morning the same project opens on "Fill" with the
crop ignored. Re-exporting produces a different video from yesterday's.

## Fix
Persist `reframeMode` and the manual crop on the project and rehydrate them on load.

## Acceptance Criteria
- [ ] Reopening a project restores its framing mode and manual crop
