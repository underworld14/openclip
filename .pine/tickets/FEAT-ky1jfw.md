---
id: FEAT-ky1jfw
title: Mid-transcribe the whole screen swaps, destroying the progress bar, Cancel, and the only error surface
status: todo
priority: critical
labels:
    - ux
    - jobs
    - bug
parent: EPIC-zpa1nd
deps:
    - FEAT-vh2bwz
created: "2026-08-08T15:56:46Z"
updated: "2026-08-08T15:56:46Z"
---

## Current behavior

App.tsx:56 `const showEditor = hasSource || hasTranscript || hasClips`, where `hasTranscript` (App.tsx:54) counts `transcript.segments.length > 0`. Transcript segments arrive as streamed job partials (transcribe-runner.ts:113-115 `emit.partial({words, segments})`), so the first closed sentence — not any user action — unmounts Welcome→ImportPanel, which owns the only progress bar (ImportPanel.tsx:96), Cancel (ImportPanel.tsx:105) and error slot (ImportPanel.tsx:115). The controller lives in a `useMemo([])` with no teardown (useImportController.ts), so the promise chain keeps running and writes state to a subscriber nobody renders. A transcribe failure at 80% is therefore completely silent.

## Desired behavior

Progress, stage, cancel, and error must be owned by app-level chrome that survives the layout switch. Either keep the user on Welcome until the transcribe job emits `done`, or (better) hoist a persistent progress strip into the title bar/status bar that renders for any active job regardless of which view is mounted.

## Competitor precedent

OpusClip's project stage machine (IMPORT→CURATE→REFINE→RENDER) is dashboard-level state you can navigate away from and back to; completion arrives by email/webhook. Kapwing's processing view is a page you own until it finishes.

## Verified in the real built app

Confirmed with high confidence by an adversarial verifier driving a real Electron run.
The observed sequence for a first-run import: for ~1-2 s the user sees a progress bar, a
stage label and a Cancel button. The moment whisper closes its first sentence — roughly 1%
of the way into a 10-minute transcription — the Welcome screen unmounts and takes the
progress bar, the Cancel button and the only error surface with it.

Because `useImportController` builds the controller in a `useMemo` with `[]` deps and has no
teardown, the async import work keeps running against an unmounted subscriber: a transcribe
failure at 80% sets an error nobody renders. **The failure is completely silent.**

## Implementation sketch

Two-part. (1) Change App.tsx:56 to `const showEditor = (hasSource || hasClips) && !importBusy` — or gate on an explicit `importComplete` flag the controller sets after `stage:'done'` (import-controller.ts sets `set({stage:'done'})` at the end of importFile). (2) Promote the import controller out of `useImportController`'s `useMemo` into a module-level singleton (or a Zustand slice) so state survives unmount, and render the progress/cancel/error row from App.tsx so it is present in both layouts. This also unblocks Gap #13 (global job surface).

## Sizing

Impact: **critical** · Effort: **medium**

## Provenance

Found by a multi-agent sweep of the codebase cross-referenced against OpusClip, Kapwing AI Clip Maker, LokaClip, yt-short-clipper and SupoClip. Every `file:line` above was read directly from the source tree.
