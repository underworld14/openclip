---
id: BUG-5jwaxf
title: A new project exists only in memory until the import settles — a quit or crash mid-transcription loses everything
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
The most-likely moment to quit is the long one, and it is exactly the unprotected window.

## Evidence
- `src/renderer/src/stores/projectStore/autosave.ts:157,248` — the project is first written
  when the import settles, not when it is created.
- A URL-imported video already downloaded into `userData/media/<projectId>/` is then
  reclaimed by the launch-time orphan sweeper, because no `.ocproj` references it.

## Impact
Paste a YouTube link, wait ten minutes for the download plus transcription, then quit
(or the Mac restarts, or the app crashes): the project is absent from Recent Projects and
the downloaded video is deleted on next launch. Nothing survives.

## Fix
Persist the project document as soon as ffprobe returns and the project is committed —
the same moment `hasSource` flips and the editor appears.

## Acceptance Criteria
- [ ] A project appears in Recent Projects before transcription starts
- [ ] Killing the app mid-transcription leaves a loadable project and its media intact
