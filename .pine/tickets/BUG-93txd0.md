---
id: BUG-93txd0
title: 'The store is not project-scoped: an in-flight job writes its results into whichever project is open when it lands'
status: todo
priority: critical
labels:
    - data-loss
parent: EPIC-k83ghw
phase: p0
created: "2026-08-15T11:28:11Z"
updated: "2026-08-15T11:28:11Z"
---

## Problem
Job results are written into a single global Zustand store with no check that the project
they belong to is still the open one — and autosave then persists the corruption.

## Evidence
- `src/renderer/src/stores/projectStore/transcriptSlice.ts:55` — `appendTranscriptPartial`
  and `hydrateTranscript` (`:47`) both `set({ transcript })` unconditionally. No project id
  is carried on the partial, and none is compared.
- `src/renderer/src/stores/projectStore/clipsSlice.ts:194` — on `done`,
  `set({ clips: result.clips.map(detectedToClip), ... })` replaces the list wholesale with
  no project guard.
- The autosave subscriber watches `clips` / `transcript` as its dirty refs, so the write
  reaches the `.ocproj` on disk ~800 ms later.

## Impact
Start a transcription (or a 1–5 minute clip generation), then open another project from
the sidebar while it runs — nothing in the UI says not to. The finished transcript or
clip list lands in **that** project, replacing its real content, and is written to disk.
A previously-good project is silently corrupted.

## Fix
Stamp every job with its `projectId` and drop (or park) any result whose project is no
longer the open one. The `JobPartial`/`JobResult` contracts in `@shared/jobs` are the
right place for the id.

## Acceptance Criteria
- [ ] A transcribe result landing after a project switch does not touch the new project
- [ ] A generate result landing after a project switch does not touch the new project
- [ ] Regression tests cover both, asserting the `.ocproj` on disk is unchanged
