---
id: BUG-sg6kqg
title: Cancel is a silent no-op during 'Reading video' and 'Extracting audio'
status: done
priority: high
labels:
    - dead-control
parent: EPIC-k83ghw
phase: p1
created: "2026-08-15T11:28:11Z"
updated: "2026-08-15T13:32:33Z"
---

## Problem
Two import stages run as plain `invoke` calls with no cancellation path.

## Evidence
- `src/main/ipc/audio.ts:33` — audio extraction is a plain handler: no `AbortSignal`, no
  PID tracking in `SidecarManager`, no progress events.
- `src/renderer/src/hooks/import-controller.ts:508` — Cancel has nothing to call for these
  stages.
- `jobStatus.ts:161-169` extrapolates an ETA from a percentage that never moves.

## Impact
On a 2–3 hour podcast, "Extracting audio" runs for minutes with the bar frozen at 12% and
an ETA that inflates every second. The user concludes it has hung and presses Cancel — in
the panel, then in the status bar — and absolutely nothing happens.

## Fix
Move extraction (and probe) onto the job plane so they get progress, PID tracking and
cancellation like every other long operation.

## Acceptance Criteria
- [x] Cancel during "Extracting audio" stops the ffmpeg child and returns the UI to idle
- [x] The progress bar advances during extraction, or the ETA is suppressed

## Resolution
Extraction is now a streaming job (`extract-audio`, `jobs.ts`), not a plain `invoke`:
- `jobs.ts`: new `JobKind` `'extract-audio'` + `JobParams`/`JobResult`/`JobPartial` entries.
- `main/services/jobs/extract-audio-runner.ts` (new): probes for a duration (tolerant of
  failure, same as before), then extracts via `ffmpeg-extract.ts`'s `extractAudio`, now
  wired with `onSpawn`/`onExit` so the ffmpeg PID is tracked by `SidecarManager` — cancel
  SIGTERM→SIGKILLs the real child, same path every other job already had.
  `sidecar-manager.ts`'s `concurrencyFor` gained an `extract-audio` case sharing the export
  formula (same class of ffmpeg work).
- `main/ipc/audio.ts`: now registers the runner (mirrors `transcribe.ts`) instead of
  handling a plain invoke.
- The old `audio:extract` channel, its `ChannelMap` entry, and the `window.openclip.audio`
  preload namespace (its only method) are DELETED — dead after the migration, not kept as
  a shim (single remaining consumer, moved to the job).
- `import-pipeline.ts` / `import-controller.ts` (`retranscribe`, the other direct call
  site): both extraction call sites now `drainJob(bridge, 'extract-audio', …)` with a new
  `onExtractStart` callback so `activeJobId` is set during extraction too — Cancel reaches
  it exactly like it already reached the transcribe job.
- `main/ipc/job-start-validation.ts`: the separate, hand-maintained trust-boundary `KIND`
  enum + `paramsByKind` map (NOT derived from the `JobKind` type) needed `extract-audio`
  added too — missing this made every real extract-audio job start fail INPUT_INVALID at
  runtime despite a clean typecheck. Caught by re-running the vertical-slice E2E against
  the real packaged app, not by any static check; added a structural drift-guard test
  (`job-start-validation.spec.ts`) that fails loudly for the NEXT job kind that forgets
  this file, instead of only failing at runtime.
- "Reading video" (ffprobe via `IMPORT_VIDEO`) was deliberately left as a plain invoke:
  it's a fast, bounded metadata read (container header, not the full stream), it's a
  second independent consumer (`PreviewPlayer.tsx`) reusing the same channel, and the
  ticket's own acceptance criteria only test the extraction stage — the impact section's
  cited scenario (a multi-hour podcast hanging for minutes) is specific to the ffmpeg
  decode, not the probe.

## Verification
- New `tests/unit/extract-audio-runner.spec.ts` (4 tests): the ffmpeg PID is tracked via
  `ctx.trackPid` (cancel/kill-on-quit can reach it), the AbortSignal is forwarded, progress
  streams across multiple values (not frozen), a probe failure is tolerated.
- `tests/unit/sidecar-manager.spec.ts`: new concurrency assertion for `extract-audio`.
- `tests/unit/import-pipeline.spec.ts`: new tests — the pipeline reports the extract-audio
  jobId (so a caller can cancel it) and multiple distinct progress stages (proof the bar
  moves); a cancelled/errored extraction surfaces as a thrown pipeline error, not a hang.
- `tests/unit/job-start-validation.spec.ts`: new tests for the `extract-audio` params
  validator + the structural "every JobKind has a validator" drift guard described above.
- `tests/mocks/openclip.ts` / `preload-parity.spec.ts`: updated for the removed `audio`
  namespace and the new job's default mock script.
- **E2E, against the real packaged app** (`npm run build` + `npx playwright test
  tests/e2e/vertical-slice.e2e.spec.ts`): both tests updated to start the real
  `extract-audio` job (acquire its port, drain to `done`) ahead of `transcribe`, exactly as
  the renderer now does. First run caught a genuine runtime gap unit tests and typecheck
  both missed — `job-start-validation.ts`'s separate KIND enum rejected the new job kind
  with INPUT_INVALID. Fixed, rebuilt, reran: both pass.
- Full suite: `npm run typecheck` (all 4 projects), `npm run lint`, `npm test` — 1522
  passed / 10 skipped, run twice for determinism, both clean.

## Work Evidence

Closed by `pine close --evidence` on 2026-08-15.

- Base: `216f85f1` (last commit at or before ticket created 2026-08-15)
- Commits (1):
  - `0ab7f99d` — chore(pine): file the production-readiness & UX audit (EPIC-k83ghw)
- Files changed (base → working tree):

```
 .pine/MEMORY.md                                    |   2 +
 .pine/memory/renderer.md                           |   3 +-
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
 .pine/tickets/BUG-aryvgg.md                        |  38 +++
 .pine/tickets/BUG-bxqmex.md                        | 134 ++++++++++
 .pine/tickets/BUG-fcg251.md                        | 119 +++++++++
 .pine/tickets/BUG-gasxqq.md                        | 122 +++++++++
 .pine/tickets/BUG-hfwbeb.md                        | 133 +++++++++
 .pine/tickets/BUG-hkmsng.md                        |  34 +++
 .pine/tickets/BUG-hqbett.md                        |  40 +++
 .pine/tickets/BUG-phta04.md                        | 127 +++++++++
 .pine/tickets/BUG-prkcq1.md                        |  33 +++
 .pine/tickets/BUG-qcvhcn.md                        |  44 +++
 .pine/tickets/BUG-sg6kqg.md                        |  88 ++++++
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
 src/main/services/media-store.ts                   |  29 ++
 src/main/services/sidecar-manager.ts               |  40 ++-
 src/main/services/updater.ts                       |  59 ++++
 src/preload/api/audio.ts                           |  12 -
 src/preload/index.ts                               |   4 -
 src/renderer/src/App.tsx                           |  79 +++++-
 src/renderer/src/assets/index.css                  |  36 +++
 src/renderer/src/components/ErrorBoundary.tsx      |  86 ++++++
 src/renderer/src/components/ExportPanel.tsx        |  25 +-
 .../src/components/GeneratePreflightDialog.tsx     |  39 ++-
 src/renderer/src/components/PreviewPlayer.tsx      | 297 +++++++++++++++++++--
 src/renderer/src/components/Timeline.tsx           |  65 +++--
 src/renderer/src/components/batch-export.ts        |  37 ++-
 src/renderer/src/components/caption-css.ts         |  40 ++-
 src/renderer/src/components/import-pipeline.ts     |  21 +-
 src/renderer/src/components/preview-crop.ts        |  49 +++-
 src/renderer/src/components/timeline-math.ts       |  57 ++++
 src/renderer/src/hooks/import-controller.ts        | 199 +++++++++++++-
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
 tests/unit/generate-preflight-dialog.spec.tsx      |  37 ++-
 tests/unit/global-shortcuts.spec.tsx               |  44 +++
 tests/unit/import-controller.spec.ts               |  16 +-
 tests/unit/import-pipeline.spec.ts                 |  47 ++++
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
 102 files changed, 5855 insertions(+), 242 deletions(-)
```
