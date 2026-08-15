---
id: BUG-hqbett
title: Test and E2E env overrides are honoured in the packaged app, and Electron fuses are left permissive
status: done
priority: medium
labels:
    - security
parent: EPIC-k83ghw
phase: p2
created: "2026-08-15T11:28:11Z"
updated: "2026-08-15T16:10:12Z"
---

## Problem
Development affordances ship enabled in production.

## Evidence
- `OPENCLIP_FFMPEG`, `OPENCLIP_FFPROBE`, `OPENCLIP_WHISPER_CLI`, `OPENCLIP_FONTS_DIR` and
  the **fake-sidecar** switch are read in `src/main/utils/paths.ts` with **no
  `app.isPackaged` gate** — verified: they are the first branch in each resolver
  (`paths.ts:76,86,137,157,216`).
- Electron fuses are not flipped in the packaged build — `RunAsNode` and Node CLI/inspect
  are at their permissive defaults.
- `src/main/menu.ts` ships `{ role: 'toggleDevTools' }` in the production View menu.
- Project ids are interpolated into `.ocproj` paths without the single-segment check that
  `assertSafeProjectId` applies elsewhere (`paths.ts:329`).

## Impact
Anything that can set an environment variable for the app can redirect every sidecar to an
arbitrary executable, or switch the app into fake-sidecar mode.

## Fix
Gate all `OPENCLIP_*` overrides on `!app.isPackaged`, flip `RunAsNode` /
`EnableNodeCliInspectArguments` / `OnlyLoadAppFromAsar` fuses, and apply
`assertSafeProjectId` on the project-document path.

## Acceptance Criteria
- [ ] Env overrides are ignored in a packaged build
- [ ] Fuses are flipped in the release build
- [ ] The `.ocproj` path rejects a non-single-segment project id

## Work Evidence

Closed by `pine close --evidence` on 2026-08-15.

- Base: `216f85f1` (last commit at or before ticket created 2026-08-15)
- Commits (3):
  - `c348eafc` — fix(security): tighten settings.json perms, escape AI captions, gate dev env overrides in packaged builds
  - `ce609dd3` — fix(ai): stop OPENAI_BASE_URL env override, give AI emoji its own unconstrained transport
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
 .pine/tickets/BUG-4tscfq.md                        | 183 ++++++++++++-
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
 .pine/tickets/BUG-hkmsng.md                        | 209 +++++++++++++++
 .pine/tickets/BUG-hqbett.md                        |  40 +++
 .pine/tickets/BUG-phta04.md                        | 127 +++++++++
 .pine/tickets/BUG-prkcq1.md                        | 191 +++++++++++++
 .pine/tickets/BUG-qcvhcn.md                        |  44 +++
 .pine/tickets/BUG-sg6kqg.md                        | 203 ++++++++++++++
 .pine/tickets/BUG-t19z5j.md                        | 186 +++++++++++++
 .pine/tickets/BUG-tdgtfb.md                        | 125 +++++++++
 .pine/tickets/BUG-v4phgj.md                        | 183 ++++++++++++-
 .pine/tickets/BUG-vh7vwp.md                        | 183 ++++++++++++-
 .pine/tickets/BUG-vv87d6.md                        | 120 +++++++++
 .pine/tickets/BUG-w2jv3w.md                        | 106 ++++++++
 .pine/tickets/BUG-whdqsc.md                        | 231 ++++++++++++++++
 .pine/tickets/BUG-y9km1j.md                        |  73 +++++
 .pine/tickets/EPIC-k83ghw.md                       |  66 +++++
 .pine/tickets/FEAT-azvb5c.md                       | 226 ++++++++++++++++
 .pine/tickets/FEAT-rmgkee.md                       | 234 ++++++++++++++++
 .pine/tickets/FEAT-vz5vya.md                       | 118 ++++++++
 .pine/tickets/FEAT-x9femg.md                       | 125 +++++++++
 README.md                                          |  74 +++--
 electron-builder.yml                               |  35 ++-
 package-lock.json                                  | 100 ++++++-
 package.json                                       |   1 +
 src/main/index.ts                                  | 120 ++++++++-
 src/main/ipc/ai.ts                                 |  24 +-
 src/main/ipc/audio.ts                              |  50 ++--
 src/main/ipc/job-start-validation.ts               |  13 +-
 src/main/ipc/media.ts                              |  15 +-
 src/main/ipc/project.ts                            |  32 ++-
 src/main/ipc/settings.ts                           |  17 +-
 src/main/ipc/system.ts                             |  20 +-
 src/main/ipc/video.ts                              |  15 +-
 src/main/menu.ts                                   |  30 ++-
 src/main/services/ai-client.ts                     | 193 ++++++++++++-
 src/main/services/ai-emoji.ts                      |  10 +-
 src/main/services/ass-captions.ts                  |  13 +-
 src/main/services/ffmpeg-extract.ts                |   6 +
 src/main/services/jobs/extract-audio-runner.ts     | 100 +++++++
 src/main/services/jobs/generate-clips-runner.ts    |  84 ++++--
 src/main/services/jobs/transcribe-runner.ts        |  16 +-
 src/main/services/media-store.ts                   |  29 ++
 src/main/services/project-store.ts                 |  16 +-
 src/main/services/sidecar-errors.ts                | 172 ++++++++++++
 src/main/services/sidecar-manager.ts               |  54 +++-
 src/main/services/updater.ts                       |  59 ++++
 src/main/utils/ffprobe.ts                          |  26 +-
 src/main/utils/paths.ts                            |  50 +++-
 src/preload/api/audio.ts                           |  12 -
 src/preload/index.ts                               |   4 -
 src/renderer/src/App.tsx                           | 130 +++++++--
 src/renderer/src/assets/index.css                  |  36 +++
 src/renderer/src/components/Dashboard.tsx          |  12 +-
 src/renderer/src/components/ErrorBoundary.tsx      |  86 ++++++
 src/renderer/src/components/ExportPanel.tsx        |  30 ++-
 .../src/components/GeneratePreflightDialog.tsx     |  39 ++-
 src/renderer/src/components/ImportPanel.tsx        |  28 +-
 src/renderer/src/components/PreviewPlayer.tsx      | 297 +++++++++++++++++++--
 src/renderer/src/components/SettingsPanel.tsx      | 128 ++++++---
 src/renderer/src/components/Timeline.tsx           |  65 +++--
 src/renderer/src/components/batch-export.ts        |  42 ++-
 src/renderer/src/components/caption-css.ts         |  40 ++-
 src/renderer/src/components/import-pipeline.ts     |  90 ++++++-
 src/renderer/src/components/jobStatus.ts           |  15 ++
 src/renderer/src/components/model-download.ts      |   5 +-
 src/renderer/src/components/preview-crop.ts        |  49 +++-
 src/renderer/src/components/readinessView.ts       |   2 +-
 src/renderer/src/components/timeline-math.ts       |  57 ++++
 src/renderer/src/hooks/import-controller.ts        | 219 ++++++++++++++-
 src/renderer/src/hooks/useGlobalShortcuts.ts       |   9 +-
 src/renderer/src/hooks/useImportController.ts      |   9 +-
 src/renderer/src/hooks/useProject.ts               | 115 +++++++-
 src/renderer/src/main.tsx                          |   5 +-
 src/renderer/src/stores/jobsStore.ts               |  11 +-
 src/renderer/src/stores/projectStore/clipsSlice.ts | 121 +++++++--
 .../src/stores/projectStore/previewSlice.ts        |   8 +
 src/shared/ai-providers.ts                         |  39 +++
 src/shared/channels.ts                             |  17 +-
 src/shared/jobs.ts                                 |  26 ++
 src/shared/schema.ts                               |  12 +-
 src/shared/shortcuts.ts                            |  32 +++
 tests/e2e/vertical-slice.e2e.spec.ts               |  78 +++++-
 tests/harness/renderer-env.ts                      |  25 ++
 tests/mocks/openclip.ts                            |  12 +-
 tests/unit/ai-mapreduce.spec.ts                    |  75 ++++++
 tests/unit/ai-providers-meta.spec.ts               |  49 ++++
 tests/unit/ai-providers.spec.ts                    | 111 ++++++++
 tests/unit/ai-stores.spec.ts                       |  93 ++++++-
 tests/unit/app-menu.spec.ts                        |  23 ++
 tests/unit/ass-captions.spec.ts                    |  16 ++
 tests/unit/batch-export.spec.ts                    |  62 +++++
 tests/unit/caption-css.spec.ts                     |  16 +-
 tests/unit/clip-reject-undo.spec.tsx               |  29 ++
 tests/unit/dialog-handlers.spec.ts                 |  10 +-
 tests/unit/error-boundary.spec.tsx                 |  64 +++++
 tests/unit/export-cancel.spec.tsx                  |  26 ++
 tests/unit/extract-audio-runner.spec.ts            | 100 +++++++
 tests/unit/ffprobe.spec.ts                         |  24 +-
 tests/unit/generate-clips-runner.spec.ts           | 117 ++++++++
 tests/unit/generate-preflight-dialog.spec.tsx      |  37 ++-
 tests/unit/global-shortcuts.spec.tsx               |  44 +++
 tests/unit/import-controller.spec.ts               |  16 +-
 tests/unit/import-pipeline.spec.ts                 |  93 ++++++-
 tests/unit/import-url.spec.ts                      |  35 ++-
 tests/unit/ipc-media.spec.ts                       |  25 +-
 tests/unit/ipc-project.spec.ts                     |  51 +++-
 tests/unit/job-start-validation.spec.ts            |  55 ++++
 tests/unit/job-status.spec.ts                      |  24 ++
 tests/unit/onboarding-handlers.spec.ts             |  58 +++-
 tests/unit/paths-prod.spec.ts                      |  35 +++
 tests/unit/preload-parity.spec.ts                  |   6 +-
 tests/unit/preview-crop.spec.ts                    |  72 ++++-
 tests/unit/preview-fitmode.spec.tsx                | 201 ++++++++++++++
 tests/unit/project-management.spec.tsx             |  11 +
 tests/unit/project-store.spec.ts                   |  34 +++
 tests/unit/reframe-visibility.spec.tsx             |  15 +-
 tests/unit/settings-panel-copy.spec.tsx            | 130 +++++++++
 tests/unit/settings-tabs.spec.tsx                  |   4 +-
 tests/unit/shortcuts.spec.ts                       |  25 ++
 tests/unit/sidecar-errors.spec.ts                  | 142 ++++++++++
 tests/unit/sidecar-manager.spec.ts                 |  63 +++++
 tests/unit/timeline-math.spec.ts                   |  80 ++++++
 tests/unit/trunk-infra.spec.ts                     |  30 +++
 tests/unit/updater.spec.ts                         |  88 ++++++
 tests/unit/use-project.spec.ts                     | 134 +++++++++-
 144 files changed, 9909 insertions(+), 439 deletions(-)
```
