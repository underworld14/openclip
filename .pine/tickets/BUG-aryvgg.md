---
id: BUG-aryvgg
title: Import accepts files it cannot process, then fails at 12% with raw ffprobe/ffmpeg output
status: done
priority: medium
labels:
    - copy
parent: EPIC-k83ghw
phase: p1
created: "2026-08-15T11:28:11Z"
updated: "2026-08-15T13:45:22Z"
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
- [x] A video with no audio is rejected at import with a clear reason
- [x] `youtube.com/watch?v=…` without a scheme imports as a URL
- [x] Dropping a file anywhere in the window imports it

## Resolution
- `main/utils/ffprobe.ts`: new `NoAudioTrackError` — `parseFfprobeJson` now checks for an
  audio stream (not just video) and throws it with a plain, actionable sentence instead of
  letting the project commit and die minutes later inside extraction with raw ffmpeg
  output. Propagates through the existing `IMPORT_VIDEO` invoke → `runImportPipeline` →
  `import-controller.ts`'s generic catch → `ctl.error`, unmodified — no new plumbing needed.
- `components/import-pipeline.ts`: `isUrl` now also recognises a bare pasted domain with a
  path (`BARE_DOMAIN_URL` regex — "dotted-hostname/path", excludes bare filenames and
  absolute/Windows paths); new `normalizeUrlInput` adds the `https://` scheme yt-dlp and
  the main-process job validator both require. Wired into `import-controller.ts`'s
  `importUrl` right after trim, so every entry point (`importAny`, `resumePending`, a
  direct `ctl.importUrl` call) gets a normalized URL, not just the UI's routing decision.
- `components/import-pipeline.ts`: new shared `resolveDroppedFile(file, getPathForFile)` —
  extracted from `ImportPanel`'s own drop handler so it and the new window-wide target
  can't drift on what counts as "looks like a video" or how a path-less drop is worded.
- `App.tsx`: the existing window-level `dragover`/`drop` listeners (previously JUST
  `preventDefault()`, to stop Chromium's default navigate-to-file behaviour) now actually
  import the dropped file via the shared singleton `importCtl` — the Welcome hero copy
  ("drop a file") is now backed by a window-wide target, not just the small ImportPanel
  card. `ImportPanel`'s own drop handler gained `stopPropagation()` so a drop landing on
  the panel doesn't ALSO fire the window handler and import twice.

## Verification
- `tests/unit/ffprobe.spec.ts`: new `NoAudioTrackError` test (plain-sentence message);
  updated 2 existing fixtures that lacked an audio stream (unrelated to their own intent —
  frame-rate fallback, N/A-duration coercion) so they aren't newly, incorrectly rejected.
- `tests/unit/import-url.spec.ts`: new tests for bare-domain detection in `isUrl` and for
  `normalizeUrlInput`, including the negative cases (a dotted filename, an absolute or
  Windows path must NOT be treated as a URL).
- `tests/unit/import-pipeline.spec.ts`: new test proving a probe rejection (the no-audio
  case's exact shape) propagates through `runImportPipeline` as a thrown error verbatim;
  new `resolveDroppedFile` unit tests (valid path / no-path-on-disk / non-video-extension
  soft-warning).
- `tests/unit/import-panel-drop.spec.tsx`: unaffected (still 4/4) — confirms
  `stopPropagation()` didn't change ImportPanel's own local drop behaviour.
- **E2E, against the real packaged app**, with the REAL ffprobe/ffmpeg binaries (not the
  fake-sidecar mode — this needed genuine no-audio detection):
  - A real silent 640×360 video (`ffmpeg -an`, confirmed via `ffprobe` to have zero audio
    streams) imported through `window.openclip.video.import` and rejected with the exact
    `NoAudioTrackError` message, thrown by the real binary path.
  - A synthetic `drop` DragEvent dispatched on `document.body` (well outside the
    ImportPanel card) was received by the window-level listener and ran the full
    `resolveDroppedFile` → warning chain — the "That item has no file on disk" toast
    rendered on screen (screenshot). The "valid path" branch could not be additionally
    E2E-proven THIS way: Electron's `webUtils.getPathForFile` only resolves a REAL,
    OS-drag-originated `File`, never a script-constructed one — genuine drag-and-drop is
    outside what either jsdom or Playwright's synthetic DragEvent can simulate. That branch
    is proven instead by `resolveDroppedFile`'s direct unit tests plus `ImportPanel`'s own
    existing DnD tests, which exercise the identical function and the identical
    `ctl.importFile` singleton call the window handler now also uses.
  - Pasting `youtube.com/watch?v=dQw4w9WgXcQ` into the smart-import field switched the
    button label from "Import" to "Download" live in the real app.
- Full suite: `npm run typecheck` (all 4 projects), `npm run lint`, `npm test` — 1531
  passed / 10 skipped, clean.

## Work Evidence

Closed by `pine close --evidence` on 2026-08-15.

- Base: `216f85f1` (last commit at or before ticket created 2026-08-15)
- Commits (1):
  - `0ab7f99d` — chore(pine): file the production-readiness & UX audit (EPIC-k83ghw)
- Files changed (base → working tree):

```
 .pine/MEMORY.md                                    |   2 +
 .pine/memory/renderer.md                           |   4 +-
 .pine/memory/testing.md                            |   3 +-
 .pine/tickets/BUG-08sb0x.md                        |  36 +++
 .pine/tickets/BUG-12bxbk.md                        |  33 +++
 .pine/tickets/BUG-15cddx.md                        | 138 ++++++++++
 .pine/tickets/BUG-1m642d.md                        |  59 ++++
 .pine/tickets/BUG-44fgyv.md                        |  38 +++
 .pine/tickets/BUG-4c3gj3.md                        | 118 ++++++++
 .pine/tickets/BUG-5jwaxf.md                        | 118 ++++++++
 .pine/tickets/BUG-8kgcxs.md                        | 129 +++++++++
 .pine/tickets/BUG-93txd0.md                        | 126 +++++++++
 .pine/tickets/BUG-9v667j.md                        | 128 +++++++++
 .pine/tickets/BUG-adfj3b.md                        | 119 +++++++++
 .pine/tickets/BUG-aryvgg.md                        |  93 +++++++
 .pine/tickets/BUG-bxqmex.md                        | 134 ++++++++++
 .pine/tickets/BUG-fcg251.md                        | 119 +++++++++
 .pine/tickets/BUG-gasxqq.md                        | 122 +++++++++
 .pine/tickets/BUG-hfwbeb.md                        | 133 +++++++++
 .pine/tickets/BUG-hkmsng.md                        |  34 +++
 .pine/tickets/BUG-hqbett.md                        |  40 +++
 .pine/tickets/BUG-phta04.md                        | 127 +++++++++
 .pine/tickets/BUG-prkcq1.md                        |  33 +++
 .pine/tickets/BUG-qcvhcn.md                        |  44 +++
 .pine/tickets/BUG-sg6kqg.md                        | 203 ++++++++++++++
 .pine/tickets/BUG-t19z5j.md                        | 186 +++++++++++++
 .pine/tickets/BUG-tdgtfb.md                        | 125 +++++++++
 .pine/tickets/BUG-vv87d6.md                        | 120 +++++++++
 .pine/tickets/BUG-w2jv3w.md                        | 106 ++++++++
 .pine/tickets/BUG-whdqsc.md                        |  52 ++++
 .pine/tickets/BUG-y9km1j.md                        |  60 +++++
 .pine/tickets/EPIC-k83ghw.md                       |  66 +++++
 .pine/tickets/FEAT-azvb5c.md                       |  57 ++++
 .pine/tickets/FEAT-rmgkee.md                       |  51 ++++
 .pine/tickets/FEAT-vz5vya.md                       | 118 ++++++++
 .pine/tickets/FEAT-x9femg.md                       | 125 +++++++++
 README.md                                          |  45 +++-
 package-lock.json                                  | 100 ++++++-
 package.json                                       |   1 +
 src/main/index.ts                                  | 120 ++++++++-
 src/main/ipc/audio.ts                              |  50 ++--
 src/main/ipc/job-start-validation.ts               |  13 +-
 src/main/ipc/media.ts                              |  15 +-
 src/main/ipc/system.ts                             |  20 +-
 src/main/ipc/video.ts                              |   8 +-
 src/main/menu.ts                                   |  24 +-
 src/main/services/ffmpeg-extract.ts                |   6 +
 src/main/services/jobs/extract-audio-runner.ts     |  93 +++++++
 src/main/services/media-store.ts                   |  29 ++
 src/main/services/sidecar-manager.ts               |  40 ++-
 src/main/services/updater.ts                       |  59 ++++
 src/main/utils/ffprobe.ts                          |  26 +-
 src/preload/api/audio.ts                           |  12 -
 src/preload/index.ts                               |   4 -
 src/renderer/src/App.tsx                           | 130 +++++++--
 src/renderer/src/assets/index.css                  |  36 +++
 src/renderer/src/components/ErrorBoundary.tsx      |  86 ++++++
 src/renderer/src/components/ExportPanel.tsx        |  25 +-
 .../src/components/GeneratePreflightDialog.tsx     |  39 ++-
 src/renderer/src/components/ImportPanel.tsx        |  28 +-
 src/renderer/src/components/PreviewPlayer.tsx      | 297 +++++++++++++++++++--
 src/renderer/src/components/Timeline.tsx           |  65 +++--
 src/renderer/src/components/batch-export.ts        |  37 ++-
 src/renderer/src/components/caption-css.ts         |  40 ++-
 src/renderer/src/components/import-pipeline.ts     |  90 ++++++-
 src/renderer/src/components/preview-crop.ts        |  49 +++-
 src/renderer/src/components/timeline-math.ts       |  57 ++++
 src/renderer/src/hooks/import-controller.ts        | 206 +++++++++++++-
 src/renderer/src/hooks/useGlobalShortcuts.ts       |   9 +-
 src/renderer/src/hooks/useImportController.ts      |   9 +-
 src/renderer/src/hooks/useProject.ts               |  58 +++-
 src/renderer/src/main.tsx                          |   5 +-
 src/renderer/src/stores/projectStore/clipsSlice.ts | 100 +++++--
 .../src/stores/projectStore/previewSlice.ts        |   8 +
 src/shared/channels.ts                             |  17 +-
 src/shared/jobs.ts                                 |  26 ++
 src/shared/schema.ts                               |  12 +-
 src/shared/shortcuts.ts                            |  32 +++
 tests/e2e/vertical-slice.e2e.spec.ts               |  78 +++++-
 tests/harness/renderer-env.ts                      |  25 ++
 tests/mocks/openclip.ts                            |  11 +-
 tests/unit/ai-stores.spec.ts                       |  25 +-
 tests/unit/app-menu.spec.ts                        |  23 ++
 tests/unit/batch-export.spec.ts                    |  62 +++++
 tests/unit/caption-css.spec.ts                     |  16 +-
 tests/unit/clip-reject-undo.spec.tsx               |  29 ++
 tests/unit/dialog-handlers.spec.ts                 |  10 +-
 tests/unit/error-boundary.spec.tsx                 |  64 +++++
 tests/unit/export-cancel.spec.tsx                  |  26 ++
 tests/unit/extract-audio-runner.spec.ts            | 100 +++++++
 tests/unit/ffprobe.spec.ts                         |  24 +-
 tests/unit/generate-preflight-dialog.spec.tsx      |  37 ++-
 tests/unit/global-shortcuts.spec.tsx               |  44 +++
 tests/unit/import-controller.spec.ts               |  16 +-
 tests/unit/import-pipeline.spec.ts                 |  93 ++++++-
 tests/unit/import-url.spec.ts                      |  35 ++-
 tests/unit/ipc-media.spec.ts                       |  25 +-
 tests/unit/job-start-validation.spec.ts            |  55 ++++
 tests/unit/onboarding-handlers.spec.ts             |  58 +++-
 tests/unit/preload-parity.spec.ts                  |   6 +-
 tests/unit/preview-crop.spec.ts                    |  72 ++++-
 tests/unit/preview-fitmode.spec.tsx                | 201 ++++++++++++++
 tests/unit/reframe-visibility.spec.tsx             |  15 +-
 tests/unit/shortcuts.spec.ts                       |  25 ++
 tests/unit/sidecar-manager.spec.ts                 |  29 ++
 tests/unit/timeline-math.spec.ts                   |  80 ++++++
 tests/unit/updater.spec.ts                         |  88 ++++++
 tests/unit/use-project.spec.ts                     |  50 +++-
 108 files changed, 6464 insertions(+), 283 deletions(-)
```
