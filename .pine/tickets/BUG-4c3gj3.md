---
id: BUG-4c3gj3
title: A moved, renamed or unplugged source video opens as a silent black preview with no relink path
status: todo
priority: high
labels:
    - data-loss
parent: EPIC-k83ghw
phase: p0
created: "2026-08-15T11:28:11Z"
updated: "2026-08-15T11:28:11Z"
---

## Problem
Nothing checks that the source file still exists, and nothing reports that it does not.

## Evidence
- `src/renderer/src/components/PreviewPlayer.tsx:267` — the `<video>` is pointed at the
  `openclip-media:` URL with **no `onError` handler** and no prior existence check.
- Project load does not stat the source path.

## Impact
The user cleans out Downloads or ejects the external drive their footage lives on. The
project reopens looking completely normal — title bar, clips, transcript, timeline — but
the preview is black and every export fails with raw ffmpeg output. There is no message
and no way to point the project at the moved file.

## Fix
Stat the source on project load; if it is missing, show a clear banner and a
"Locate video…" button that rewrites `sourceVideo.path`.

## Acceptance Criteria
- [ ] Opening a project whose source is missing says so explicitly
- [ ] The user can relink the file without re-importing and re-transcribing
