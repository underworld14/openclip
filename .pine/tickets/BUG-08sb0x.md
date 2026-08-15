---
id: BUG-08sb0x
title: The app never reclaims its own caches — ~115 MB per source hour is left behind, and reopened projects show blank clip cards
status: todo
priority: medium
labels:
    - housekeeping
parent: EPIC-k83ghw
phase: p2
created: "2026-08-15T11:28:11Z"
updated: "2026-08-15T11:28:11Z"
---

## Problem
Deleting a project reclaims its media but not its derived data.

## Evidence
- The extracted-audio WAV cache under `<temp>/openclip/<projectId>/cache` is never
  reclaimed: the launch-time orphan sweep skips it and project deletion does not touch it
  (~115 MB per hour of source).
- Clip poster frames are written to the OS temp dir and never regenerated, so reopening an
  older project shows blank clip cards permanently.
- The delete confirmation never mentions that the downloaded video is deleted with the
  project.

## Impact
Disk fills silently over time, and old projects visibly degrade.

## Fix
Extend the launch sweep to the per-project cache, delete it with the project, regenerate
missing poster frames on load, and name the media deletion in the confirm dialog.

## Acceptance Criteria
- [ ] Deleting a project reclaims its WAV cache and posters
- [ ] Reopening an old project re-renders its clip thumbnails
- [ ] The delete confirm says the video will be removed
