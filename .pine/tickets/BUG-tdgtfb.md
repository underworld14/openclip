---
id: BUG-tdgtfb
title: New Project, Delete Project and Duplicate all leave the store and disk inconsistent
status: doing
priority: high
labels:
    - data-loss
parent: EPIC-k83ghw
phase: p0
created: "2026-08-15T11:28:11Z"
updated: "2026-08-15T11:49:22Z"
---

## Problem
Three project-lifecycle commands each corrupt state in a different way.

## Evidence
- **New Project (Cmd+N)** — `src/renderer/src/App.tsx:229` is
  `setCurrentProject(null)` only. `clips`, `transcript` and timeline state are left in
  place, so the previous project's clips stay on screen and any edit made there is written
  into the new project.
- **Delete the open project** — `src/renderer/src/hooks/useProject.ts:197` removes it from
  disk and the list but leaves it loaded in the editor. The next edit re-creates the
  `.ocproj` after its media directory has already been deleted.
- **Duplicate** — `src/renderer/src/hooks/useProject.ts:218` copies the project document
  but not the app-owned media under `userData/media/<projectId>/`. Deleting the original
  therefore destroys the duplicate's video.

## Impact
Silent cross-project contamination and orphaned projects that point at deleted media —
all from commands the user reasonably expects to be safe.

## Fix
Route all three through one "close the open project" path that clears every slice;
block or redirect deletion of the open project; make Duplicate copy (or reference-count)
the media directory.

## Acceptance Criteria
- [ ] Cmd+N clears clips, transcript and timeline state
- [ ] Deleting the open project closes it in the editor and cannot resurrect the file
- [ ] A duplicate survives deletion of its original
