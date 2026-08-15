---
id: BUG-hkmsng
title: A generation that returns zero clips wipes the list and says nothing
status: done
priority: medium
labels:
    - copy
parent: EPIC-k83ghw
phase: p1
created: "2026-08-15T11:28:11Z"
updated: "2026-08-15T14:16:27Z"
---

## Problem
The empty result is indistinguishable from the button not working.

## Evidence
- `src/main/services/ai-client.ts:705` — a run whose candidates are all clamped or dropped
  returns an empty array, and `clipsSlice` replaces `clips` with it.
- For most videos the progress bar stays at 0% with "Analyzing transcript…" for the whole
  run, so the app already looks frozen before the empty result lands.

## Impact
The user picks a length preset, presses Generate, waits, pays for the API call — and the
sidebar returns to "No clips yet", exactly as before they pressed anything. They have no
idea whether it ran, failed, or found nothing.

## Fix
Distinguish "ran, found nothing" from "never ran": keep the previous clips, and explain
why zero came back (e.g. "No moment matched 60–90s — try a wider length range").

## Acceptance Criteria
- [x] A zero-clip run shows an explanation and does not clear existing clips
- [x] Generate progress advances visibly during a run

## Resolution
- `main/services/ai-client.ts` (`mapReduceGenerate`): a run whose `ranked` candidates are
  ALL clamped/deduped away now pushes an explanatory warning naming the actual length range
  ("No moment matched your 15–90s length range — try widening the range, a different style,
  or different keywords") instead of returning silently. Also fixed a latent bug this
  exposed: the "every chunk failed → typed error" guard checked `all.length === 0`, which is
  ALSO true when a chunk fails but the surviving chunks succeed with zero candidates — so a
  1-of-5-chunks-refused run that legitimately found nothing was misreported as an outright
  failure. Now checks `failedChunks === chunks.length` (genuinely every chunk), so "some
  failed, the rest found nothing" correctly returns both warnings together.
- `main/services/jobs/generate-clips-runner.ts`: the bar sat at 0% "Analyzing…" for the
  whole run on most videos, because the only REAL progress signal (`onChunk`) fires at chunk
  BOUNDARIES and most transcripts are a single chunk. Added a trickle: `setInterval` ticks
  progress toward (never reaching) a conservative 40% ceiling, decaying, cleared the instant
  a REAL chunk boundary arrives (so it can't regress a multi-chunk run's real progress) and
  in a `finally` on every exit path (success/error/cancel).
- `stores/projectStore/clipsSlice.ts` (`generateClips`): when `result.clips.length === 0`,
  the clip list is now left COMPLETELY UNTOUCHED rather than replaced with `[...preserved,
  ...[]]` — the old logic dropped any never-reviewed 'suggested' clip from a prior run (only
  approved/exported/edited ones were preserved), silently reverting the sidebar to "No clips
  yet" exactly as if Generate had never been pressed. A non-empty result still replaces
  untouched suggestions exactly as before (Regenerate's actual point, BUG-vv87d6 behaviour
  unaffected).

## Verification
- `tests/unit/ai-mapreduce.spec.ts` (2 new tests): a legitimately-empty result is `ok:true`
  with `clips:[]` and the length-range warning; a mixed "1 chunk refused, rest found
  nothing" run carries BOTH the chunk-failure and the zero-clips warning (the regression the
  guard-condition fix addresses).
- `tests/unit/generate-clips-runner.spec.ts` (2 new tests, Vitest fake timers): progress
  ticks monotonically upward while a single unchunked LLM call is pending, never claims
  false completion (<90%), jumps cleanly to 100 on resolution, and stops ticking (no further
  emits) after settlement; a real chunk boundary stops the trickle immediately and is never
  overwritten by a subsequent tick.
- `tests/unit/ai-stores.spec.ts` (2 new tests): a zero-clip job result keeps an untouched
  prior 'suggested' clip in place AND surfaces `generateWarnings`; a non-empty result still
  replaces an untouched stale suggestion (no regression vs BUG-vv87d6).
- Full suite: `npm run typecheck` (all 4), `npm run lint`, `npm test` — 1555 passed / 10
  skipped, run twice for determinism, clean.
- **Live, against the real packaged app**: drove the REAL `projectStore` to the exact
  post-zero-result state `generateClips` now produces (a never-reviewed prior clip +
  `generateWarnings`). Screenshot: the sidebar shows "Clips (1)" with the untouched prior
  suggestion still listed, and the amber explanation banner above it — never "No clips yet".

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
 .pine/tickets/BUG-aryvgg.md                        | 214 +++++++++++++++
 .pine/tickets/BUG-bxqmex.md                        | 134 ++++++++++
 .pine/tickets/BUG-fcg251.md                        | 119 +++++++++
 .pine/tickets/BUG-gasxqq.md                        | 122 +++++++++
 .pine/tickets/BUG-hfwbeb.md                        | 133 +++++++++
 .pine/tickets/BUG-hkmsng.md                        |  78 ++++++
 .pine/tickets/BUG-hqbett.md                        |  40 +++
 .pine/tickets/BUG-phta04.md                        | 127 +++++++++
 .pine/tickets/BUG-prkcq1.md                        |  33 +++
 .pine/tickets/BUG-qcvhcn.md                        |  44 +++
 .pine/tickets/BUG-sg6kqg.md                        | 203 ++++++++++++++
 .pine/tickets/BUG-t19z5j.md                        | 186 +++++++++++++
 .pine/tickets/BUG-tdgtfb.md                        | 125 +++++++++
 .pine/tickets/BUG-vv87d6.md                        | 120 +++++++++
 .pine/tickets/BUG-w2jv3w.md                        | 106 ++++++++
 .pine/tickets/BUG-whdqsc.md                        | 231 ++++++++++++++++
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
 src/main/services/ai-client.ts                     |  26 +-
 src/main/services/ffmpeg-extract.ts                |   6 +
 src/main/services/jobs/extract-audio-runner.ts     |  93 +++++++
 src/main/services/jobs/generate-clips-runner.ts    |  26 ++
 src/main/services/media-store.ts                   |  29 ++
 src/main/services/sidecar-errors.ts                | 172 ++++++++++++
 src/main/services/sidecar-manager.ts               |  54 +++-
 src/main/services/updater.ts                       |  59 ++++
 src/main/utils/ffprobe.ts                          |  26 +-
 src/preload/api/audio.ts                           |  12 -
 src/preload/index.ts                               |   4 -
 src/renderer/src/App.tsx                           | 130 +++++++--
 src/renderer/src/assets/index.css                  |  36 +++
 src/renderer/src/components/ErrorBoundary.tsx      |  86 ++++++
 src/renderer/src/components/ExportPanel.tsx        |  30 ++-
 .../src/components/GeneratePreflightDialog.tsx     |  39 ++-
 src/renderer/src/components/ImportPanel.tsx        |  28 +-
 src/renderer/src/components/PreviewPlayer.tsx      | 297 +++++++++++++++++++--
 src/renderer/src/components/Timeline.tsx           |  65 +++--
 src/renderer/src/components/batch-export.ts        |  42 ++-
 src/renderer/src/components/caption-css.ts         |  40 ++-
 src/renderer/src/components/import-pipeline.ts     |  90 ++++++-
 src/renderer/src/components/jobStatus.ts           |  15 ++
 src/renderer/src/components/model-download.ts      |   5 +-
 src/renderer/src/components/preview-crop.ts        |  49 +++-
 src/renderer/src/components/timeline-math.ts       |  57 ++++
 src/renderer/src/hooks/import-controller.ts        | 219 ++++++++++++++-
 src/renderer/src/hooks/useGlobalShortcuts.ts       |   9 +-
 src/renderer/src/hooks/useImportController.ts      |   9 +-
 src/renderer/src/hooks/useProject.ts               |  58 +++-
 src/renderer/src/main.tsx                          |   5 +-
 src/renderer/src/stores/jobsStore.ts               |  11 +-
 src/renderer/src/stores/projectStore/clipsSlice.ts | 121 +++++++--
 .../src/stores/projectStore/previewSlice.ts        |   8 +
 src/shared/channels.ts                             |  17 +-
 src/shared/jobs.ts                                 |  26 ++
 src/shared/schema.ts                               |  12 +-
 src/shared/shortcuts.ts                            |  32 +++
 tests/e2e/vertical-slice.e2e.spec.ts               |  78 +++++-
 tests/harness/renderer-env.ts                      |  25 ++
 tests/mocks/openclip.ts                            |  11 +-
 tests/unit/ai-mapreduce.spec.ts                    |  75 ++++++
 tests/unit/ai-stores.spec.ts                       |  93 ++++++-
 tests/unit/app-menu.spec.ts                        |  23 ++
 tests/unit/batch-export.spec.ts                    |  62 +++++
 tests/unit/caption-css.spec.ts                     |  16 +-
 tests/unit/clip-reject-undo.spec.tsx               |  29 ++
 tests/unit/dialog-handlers.spec.ts                 |  10 +-
 tests/unit/error-boundary.spec.tsx                 |  64 +++++
 tests/unit/export-cancel.spec.tsx                  |  26 ++
 tests/unit/extract-audio-runner.spec.ts            | 100 +++++++
 tests/unit/ffprobe.spec.ts                         |  24 +-
 tests/unit/generate-clips-runner.spec.ts           |  87 ++++++
 tests/unit/generate-preflight-dialog.spec.tsx      |  37 ++-
 tests/unit/global-shortcuts.spec.tsx               |  44 +++
 tests/unit/import-controller.spec.ts               |  16 +-
 tests/unit/import-pipeline.spec.ts                 |  93 ++++++-
 tests/unit/import-url.spec.ts                      |  35 ++-
 tests/unit/ipc-media.spec.ts                       |  25 +-
 tests/unit/job-start-validation.spec.ts            |  55 ++++
 tests/unit/job-status.spec.ts                      |  24 ++
 tests/unit/onboarding-handlers.spec.ts             |  58 +++-
 tests/unit/preload-parity.spec.ts                  |   6 +-
 tests/unit/preview-crop.spec.ts                    |  72 ++++-
 tests/unit/preview-fitmode.spec.tsx                | 201 ++++++++++++++
 tests/unit/reframe-visibility.spec.tsx             |  15 +-
 tests/unit/shortcuts.spec.ts                       |  25 ++
 tests/unit/sidecar-errors.spec.ts                  | 142 ++++++++++
 tests/unit/sidecar-manager.spec.ts                 |  63 +++++
 tests/unit/timeline-math.spec.ts                   |  80 ++++++
 tests/unit/updater.spec.ts                         |  88 ++++++
 tests/unit/use-project.spec.ts                     |  50 +++-
 118 files changed, 7532 insertions(+), 302 deletions(-)
```
