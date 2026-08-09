---
id: FEAT-ky1jfw
title: Mid-transcribe the whole screen swaps, destroying the progress bar, Cancel, and the only error surface
status: testing
priority: critical
labels:
    - ux
    - jobs
    - bug
deps:
    - FEAT-vh2bwz
parent: EPIC-zpa1nd
created: "2026-08-08T15:56:46Z"
updated: "2026-08-09T01:30:38Z"
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

## What was actually done

The sketch's part (2) — promoting the controller to a module singleton — had already
landed separately, so the in-flight state did survive unmount. What was still missing
was anything RENDERING it, and a layout rule that stopped fighting the import.

Rather than the sketch's `&& !importBusy` (which keeps the user staring at a Welcome
screen for ten minutes), the project is now committed at **probe** time:

1. `runImportPipeline` gained an awaited `onProbed(sourceVideo)`, fired right after
   ffprobe and before audio extraction.
2. The controller's commit block — flush-save the outgoing project, `hydrateProject`,
   `markCommitted`, `setView('editor')` — moved into that callback, unchanged in
   order. It used to run after `runImport` resolved, i.e. after transcription.
3. `App.showEditor` dropped `hasTranscript`. `hasSource` now flips about a second
   into an import (EARLIER than the old predicate, not later) and flips exactly once,
   on a real event, instead of mid-stream on a streamed partial.
4. Progress / stage / Cancel / error live in `JobStatusBar` (FEAT-vh2bwz), which is
   mounted between the title bar and the body and belongs to neither layout.

The user now watches the video and the transcript filling in live, instead of a bar.

### Consequences handled

- **Autosave storm.** `currentProject` used to be null during transcription, so the
  autosave subscriber short-circuited. With an early commit, every streamed partial
  changes the `transcript` ref — a full `.ocproj` write every debounce window for the
  whole transcription. `startAutosave` gained `isSuspended` + `resume()`;
  `installAutosave` suspends while `hasActiveKind('import')` and writes once when the
  import settles, so the terminal `hydrateTranscript` still reaches disk.
- **A cancelled/failed transcription now leaves a real project** holding a real video.
  That is the honest outcome — the import DID happen — and the media reclaim correctly
  does not fire, since the user can see the project.
- **`integration-wave1.e2e`** drove `runImportPipeline` directly and never committed a
  project, so it relied on the buggy `hasTranscript` gate; it now commits in `onProbed`
  like the controller does. Its `getByText('Hello world!')` also had to be scoped to
  the transcript list: the preview player is live during the import now, so the same
  words legitimately appear in the karaoke overlay too.

## Sizing

Impact: **critical** · Effort: **medium**

## Provenance

Found by a multi-agent sweep of the codebase cross-referenced against OpusClip, Kapwing AI Clip Maker, LokaClip, yt-short-clipper and SupoClip. Every `file:line` above was read directly from the source tree.
