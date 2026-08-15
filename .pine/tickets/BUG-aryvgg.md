---
id: BUG-aryvgg
title: Import accepts files it cannot process, then fails at 12% with raw ffprobe/ffmpeg output
status: todo
priority: medium
labels:
    - copy
parent: EPIC-k83ghw
phase: p1
created: "2026-08-15T11:28:11Z"
updated: "2026-08-15T11:28:11Z"
---

## Problem
No classification of the common bad-input cases, before or after the failure.

## Evidence
- `src/main/utils/ffprobe.ts:63` — a video with **no audio track** passes probing, commits
  the project, and then dies during extraction.
- `src/main/utils/ffprobe.ts:108` — failures surface as
  `Command failed: /…/ffprobe -v quiet …` plus the stderr tail.
- A pasted link without a scheme is treated as a file path (no normalization), so
  `youtube.com/watch?v=…` fails inside ffprobe instead of downloading.
- Drag-and-drop only works over the small import card; a drop anywhere else in the window
  is silently swallowed, though the hero copy invites dropping.

## Impact
A screen recording made without a microphone, a muted export, or silent b-roll produces a
crash log. So does a correctly-pasted YouTube link missing `https://`.

## Fix
Detect "no audio stream" at probe time and refuse with a plain sentence; normalize pasted
URLs; classify the common ffprobe failures; widen the drop target to the window.

## Acceptance Criteria
- [ ] A video with no audio is rejected at import with a clear reason
- [ ] `youtube.com/watch?v=…` without a scheme imports as a URL
- [ ] Dropping a file anywhere in the window imports it
