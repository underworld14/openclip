---
id: FEAT-vz5vya
title: No way to re-transcribe an existing project — a failed or cancelled transcription can only be 'retried' by importing a duplicate
status: doing
priority: high
labels:
    - recovery
parent: EPIC-k83ghw
phase: p0
created: "2026-08-15T11:28:11Z"
updated: "2026-08-15T11:49:22Z"
---

## Problem
Transcription is only reachable from the import pipeline.

## Evidence
- `src/renderer/src/hooks/import-controller.ts:262,409` — the transcribe job is started
  only as a stage of an import. There is no command, menu item or button that transcribes
  an already-open project.
- "Retry" on a failed import starts a brand-new project (and re-downloads the video for a
  URL import), leaving a half-built duplicate behind.

## Impact
Wifi drops at 60% of a 90-minute podcast, or whisper crashes, or the user hits Cancel by
mistake. The project still holds the video but no transcript, and the only way forward is
to import the same file again as a second project.

## Fix
Add a "Transcribe" / "Re-transcribe" action on an open project that reuses the cached WAV.

## Acceptance Criteria
- [ ] An open project with no transcript offers to transcribe it
- [ ] Retry resumes the existing project instead of creating a duplicate
