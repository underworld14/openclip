---
id: FEAT-azqfsv
title: Deferred code-review items from EPIC-xzzpty
status: done
priority: low
labels:
    - cleanup
parent: EPIC-4sa5jb
created: "2026-08-08T18:22:47Z"
updated: "2026-08-14T14:39:18Z"
---

Small items surfaced by the EPIC-xzzpty code review, deliberately deferred rather than folded into the fix pass.

## 1. `NOT_IMPLEMENTED` is a message prefix, not a typed error

`src/main/ipc/ai.ts` — `GENERATE_TITLES` and rewrite-mode `ENHANCE_CAPTIONS` now reject with `new Error('NOT_IMPLEMENTED: …')`. FEAT-et1gxc asked for a typed `JobError('NOT_IMPLEMENTED', …)` "so callers can branch".

The prefix is pragmatic — `ipcMain.handle` flattens an error to its message across IPC, so `JobError.code` is lost anyway (there is an existing comment about this in `job-start-validation.ts`). But a caller that wants to branch has to string-match, which is the thing typed errors exist to avoid. Decide: either accept the prefix and document it as the convention, or give the control plane the same typed-error envelope the job plane has.

## 2. FEAT-c5a15c's Welcome-card checklist was not built

Only the title-bar chips shipped. The ticket's "Desired behavior" also asked for "the same three rows as a green-check checklist" on the Welcome card. The chips ARE visible on Welcome, so a first-run user does see the state — this may be sufficient. Confirm the scope call or build the checklist.

## 3. `preflight.ytDlp` is collected and never used

`SYSTEM_PREFLIGHT` reports `ytDlp`, and `readinessView` ignores it. A missing yt-dlp only affects URL import, so it does not belong in the three general chips — but either gate URL import on it (the import field could say so when a URL is pasted) or drop it from the payload. Reporting something nothing reads is how `whisperCli` ended up probed-and-ignored.

## 4. The model auto-fill effect can clobber in-progress typing

`SettingsPanel.tsx` — the seed effect fires again when the catalogue arrives. The model field keeps a local `modelDraft` and only persists on blur, so if the user starts typing before `/models` resolves, `settings.model` is still `''`, the effect saves `models[0].id`, and the render-phase sync overwrites the draft. No loop (the blank-field guard terminates it), but it is a real race on a slow network, and it also means the field cannot be deliberately left empty.

Fix direction: skip the seed once the input has been focused/edited this session, or seed only on provider change rather than on every catalogue arrival. Needs the renderer test harness ([[FEAT-renderer-harness]]) to test properly.

## Work Evidence

Closed by `pine close --evidence` on 2026-08-14.

- Base: `eb1be422` (last commit at or before ticket created 2026-08-08)
- Commits (2):
  - `d43be280` — chore: close out the four deferred EPIC-xzzpty review items (FEAT-azqfsv)
  - `c297147d` — fix(ai): exclusion-only OpenAI filter, honest test-connection, chip tooltips
- Files changed (base → working tree):

```
 .github/workflows/ci.yml                           |  18 +
 .pine/memory/ci.md                                 |  19 +
 .pine/memory/renderer.md                           |   8 +-
 .pine/tickets/BUG-2smqpv.md                        | 223 ++++++-
 .pine/tickets/BUG-e06a9d.md                        | 220 ++++++-
 .pine/tickets/BUG-g6zq2t.md                        | 244 ++++++-
 .pine/tickets/BUG-jt3d62.md                        | 156 +++++
 .pine/tickets/BUG-t1xj4d.md                        | 230 ++++++-
 .pine/tickets/BUG-y6y5mf.md                        | 226 ++++++-
 .pine/tickets/BUG-yq6qbw.md                        | 241 ++++++-
 .pine/tickets/BUG-yxvrwx.md                        | 220 ++++++-
 .pine/tickets/BUG-zcqyb7.md                        | 198 ++++++
 .pine/tickets/EPIC-9gkehb.md                       | 266 +++++++-
 .pine/tickets/EPIC-c2gg45.md                       | 266 +++++++-
 .pine/tickets/EPIC-f953vk.md                       | 285 +++++++-
 .pine/tickets/EPIC-n6ndb8.md                       | 266 +++++++-
 .pine/tickets/EPIC-zpa1nd.md                       |  35 +-
 .pine/tickets/FEAT-0s2tnc.md                       | 261 +++++++-
 .pine/tickets/FEAT-26tkya.md                       | 141 ++++
 .pine/tickets/FEAT-51hnwx.md                       | 246 ++++++-
 .pine/tickets/FEAT-56bxyh.md                       | 269 +++++++-
 .pine/tickets/FEAT-5hnsby.md                       | 229 ++++++-
 .pine/tickets/FEAT-71ay4e.md                       | 253 ++++++-
 .pine/tickets/FEAT-7ffxsg.md                       | 216 +++++-
 .pine/tickets/FEAT-8559h1.md                       | 213 +++++-
 .pine/tickets/FEAT-905vk4.md                       | 282 +++++++-
 .pine/tickets/FEAT-az3sxm.md                       | 236 ++++++-
 .pine/tickets/FEAT-azqfsv.md                       |  33 +
 .pine/tickets/FEAT-bd87vz.md                       | 263 +++++++-
 .pine/tickets/FEAT-c0zn3j.md                       | 229 ++++++-
 .pine/tickets/FEAT-ckxz8d.md                       | 214 +++++-
 .pine/tickets/FEAT-d8b6bj.md                       | 212 +++++-
 .pine/tickets/FEAT-g39qj3.md                       | 246 ++++++-
 .pine/tickets/FEAT-k28j7h.md                       | 235 ++++++-
 .pine/tickets/FEAT-ky1jfw.md                       | 219 ++++++-
 .pine/tickets/FEAT-kzej8t.md                       | 319 ++++++++-
 .pine/tickets/FEAT-n762y6.md                       | 258 +++++++-
 .pine/tickets/FEAT-rmh08k.md                       | 267 +++++++-
 .pine/tickets/FEAT-vh2bwz.md                       | 120 +++-
 .pine/tickets/FEAT-vvaycm.md                       | 279 +++++++-
 .pine/tickets/FEAT-vwvgs0.md                       | 251 ++++++-
 .pine/tickets/FEAT-ybhdhz.md                       | 246 ++++++-
 CODE_OF_CONDUCT.md                                 | 131 ++++
 CONTRIBUTING.md                                    | 191 ++++++
 LICENSE                                            |  31 +
 README.md                                          | 163 +++++
 THIRD-PARTY-LICENSES.md                            |  49 ++
 build/licenses/ffmpeg/COPYING.GPLv3                | 674 +++++++++++++++++++
 build/licenses/ffmpeg/README.md                    |  69 ++
 docs/PACKAGING.md                                  |  90 ++-
 docs/screenshots/01-welcome.png                    | Bin 0 -> 32645 bytes
 docs/screenshots/02-editor.png                     | Bin 0 -> 92473 bytes
 electron-builder.yml                               |  38 ++
 package-lock.json                                  | 730 +++++++++++++++++++--
 package.json                                       |  13 +-
 scripts/bundle-binaries.mjs                        |  57 ++
 scripts/capture-screenshots.mjs                    | 130 ++++
 scripts/verify-package.mjs                         | 107 ++-
 src/main/index.ts                                  |  24 +-
 src/main/ipc/ai.ts                                 |  55 +-
 src/main/ipc/job-start-validation.ts               |  45 +-
 src/main/ipc/project.ts                            |  52 +-
 src/main/ipc/settings.ts                           |  98 ++-
 src/main/ipc/system.ts                             |  37 +-
 src/main/ipc/video.ts                              | 107 ++-
 src/main/menu.ts                                   | 124 ++++
 src/main/services/ai-client.ts                     | 412 ++++++++++--
 src/main/services/ass-captions.ts                  |  50 +-
 src/main/services/encoder-probe.ts                 |  64 ++
 src/main/services/ffmpeg-caption.ts                |  49 +-
 src/main/services/ffmpeg-export.ts                 | 121 +++-
 src/main/services/jobs/export-runner.ts            | 270 +++++++-
 src/main/services/jobs/generate-clips-runner.ts    | 142 ++++
 src/main/services/openrouter-models.ts             |  37 +-
 src/main/services/project-store.ts                 |  54 +-
 src/main/services/provider-models.ts               |  41 +-
 src/main/services/reframe-cache.ts                 | 156 +++++
 src/main/services/reframe-detect.ts                | 183 +++++-
 src/main/services/sidecar-manager.ts               |   5 +
 src/main/utils/paths.ts                            |  29 +-
 src/preload/index.ts                               |   6 +-
 src/preload/menu-command.ts                        |  32 +
 src/renderer/src/App.tsx                           | 339 +++++++++-
 src/renderer/src/assets/index.css                  |  29 +
 src/renderer/src/components/BrandKitEditor.tsx     |  57 +-
 src/renderer/src/components/CaptionStylePanel.tsx  | 147 +++++
 src/renderer/src/components/ClipCard.tsx           | 208 +++++-
 src/renderer/src/components/ClipSidebar.tsx        | 137 +++-
 src/renderer/src/components/Dashboard.tsx          | 235 ++++++-
 src/renderer/src/components/Dashboard.view.ts      |   5 +-
 src/renderer/src/components/ExportPanel.tsx        | 315 ++++++---
 .../src/components/GeneratePreflightDialog.tsx     | 311 +++++++++
 src/renderer/src/components/ImportPanel.tsx        |  38 +-
 src/renderer/src/components/JobStatusBar.tsx       | 256 ++++++++
 .../src/components/ModelDownloadDialog.tsx         |  31 +-
 src/renderer/src/components/PreviewPlayer.tsx      | 156 ++++-
 src/renderer/src/components/ReadinessBar.tsx       |   6 +-
 src/renderer/src/components/SettingsPanel.tsx      | 535 ++++++++-------
 src/renderer/src/components/ShortcutSheet.tsx      |  63 ++
 src/renderer/src/components/Timeline.tsx           |  32 +-
 src/renderer/src/components/TranscriptPanel.tsx    |  89 ++-
 src/renderer/src/components/Welcome.tsx            |  12 +-
 src/renderer/src/components/batch-export.ts        |   7 +
 src/renderer/src/components/captionSample.ts       |  62 ++
 src/renderer/src/components/clipView.ts            |  88 ++-
 src/renderer/src/components/export-run.ts          |  14 +-
 src/renderer/src/components/generate-clips-run.ts  |  54 ++
 src/renderer/src/components/generateClips.ts       |  44 +-
 src/renderer/src/components/import-pipeline.ts     |  42 +-
 src/renderer/src/components/jobStatus.ts           | 322 +++++++++
 src/renderer/src/components/saveStatus.ts          |  39 ++
 src/renderer/src/components/settingsView.ts        |  27 +
 src/renderer/src/components/ui/dialog.tsx          |  25 +-
 src/renderer/src/hooks/import-controller.ts        | 160 +++--
 src/renderer/src/hooks/jobPort.ts                  |  25 +-
 src/renderer/src/hooks/useGlobalShortcuts.ts       |  91 +++
 src/renderer/src/hooks/useImportController.ts      |  64 +-
 src/renderer/src/hooks/useJob.ts                   | 150 +----
 src/renderer/src/hooks/useProject.ts               |  56 ++
 src/renderer/src/hooks/useReadiness.ts             |  13 +-
 src/renderer/src/main.tsx                          |   8 +
 src/renderer/src/stores/jobNotifications.ts        |  90 +++
 src/renderer/src/stores/jobsStore.ts               | 249 +++++++
 src/renderer/src/stores/projectStore/autosave.ts   | 132 +++-
 src/renderer/src/stores/projectStore/clipsSlice.ts | 153 ++++-
 .../src/stores/projectStore/exportSlice.ts         |  20 +-
 .../src/stores/projectStore/previewSlice.ts        |  85 ++-
 .../src/stores/projectStore/timelineSlice.ts       |  38 +-
 src/renderer/src/stores/uiStore.ts                 |  55 +-
 src/shared/channels.ts                             | 177 ++++-
 src/shared/clip-snap.ts                            | 149 +++++
 src/shared/framing-modes.ts                        |  96 +++
 src/shared/generate-preflight.ts                   | 404 ++++++++++++
 src/shared/ipc-errors.ts                           |  49 ++
 src/shared/jobs.ts                                 | 159 ++++-
 src/shared/reframe-plan.ts                         |  95 ++-
 src/shared/schema.ts                               |  33 +-
 src/shared/shortcuts.ts                            | 385 +++++++++++
 src/shared/subtitle-export.ts                      | 127 ++++
 src/shared/token-estimate.ts                       | 201 ++++++
 tests/e2e/export.e2e.spec.ts                       |  27 +-
 tests/e2e/generate-clips-button.e2e.spec.ts        |  27 +
 tests/e2e/integration-wave1.e2e.spec.ts            |  37 +-
 tests/e2e/job-status-bar.e2e.spec.ts               | 127 ++++
 tests/e2e/timeline.e2e.spec.ts                     |  27 +-
 tests/e2e/vertical-slice.e2e.spec.ts               |  75 ++-
 tests/fixtures/contract/index.ts                   |  19 +-
 tests/harness/fixtures.ts                          |  47 ++
 tests/harness/renderer-env.ts                      |  59 ++
 tests/mocks/openclip.ts                            |  38 +-
 tests/unit/ai-ipc.spec.ts                          |  14 +-
 tests/unit/ai-mapreduce.spec.ts                    | 231 +++++++
 tests/unit/ai-stores.spec.ts                       | 162 +++--
 tests/unit/ai-targeting.spec.ts                    | 162 +++++
 tests/unit/app-menu.spec.ts                        | 158 +++++
 tests/unit/ass-captions.serial.spec.ts             |  21 +-
 tests/unit/ass-playres.serial.spec.ts              | 116 ++++
 tests/unit/ass-playres.spec.ts                     | 127 ++++
 tests/unit/autosave-payload-size.spec.ts           | 158 +++++
 tests/unit/autosave-subscriber.spec.ts             |  79 ++-
 tests/unit/caption-style-panel.spec.tsx            | 243 +++++++
 tests/unit/clip-card-preview.spec.tsx              | 233 +++++++
 tests/unit/clip-card-surfaces.spec.tsx             | 146 +++++
 tests/unit/clip-reject-undo.spec.tsx               | 162 +++++
 tests/unit/clip-snap.spec.ts                       | 159 +++++
 tests/unit/deferred-review-items.spec.tsx          | 127 ++++
 tests/unit/dialog-scroll.spec.tsx                  | 101 +++
 tests/unit/export-cancel.spec.tsx                  | 106 +++
 tests/unit/export-fit-mode.serial.spec.ts          | 143 ++++
 tests/unit/export-fit-mode.spec.ts                 | 199 ++++++
 tests/unit/export-runner.spec.ts                   |  67 +-
 tests/unit/ffmpeg-export.serial.spec.ts            |  21 +-
 tests/unit/ffmpeg-version.serial.spec.ts           |  35 +-
 tests/unit/force-cpu.spec.ts                       | 160 +++++
 tests/unit/generate-clips-runner.spec.ts           | 188 ++++++
 tests/unit/generate-preflight-dialog.spec.tsx      | 374 +++++++++++
 tests/unit/generate-preflight.spec.ts              | 377 +++++++++++
 tests/unit/global-shortcuts.spec.tsx               | 221 +++++++
 tests/unit/import-controller.spec.ts               |  72 ++
 tests/unit/import-panel-drop.spec.tsx              | 136 ++++
 tests/unit/import-url.spec.ts                      |  21 +
 tests/unit/ipc-project.spec.ts                     |  11 +-
 tests/unit/job-notifications.spec.ts               | 131 ++++
 tests/unit/job-port-window-delivery.spec.tsx       |  81 +++
 tests/unit/job-start-validation.spec.ts            |  24 +
 tests/unit/job-status.spec.ts                      | 220 +++++++
 tests/unit/jobs-store.spec.ts                      | 208 ++++++
 tests/unit/openrouter-curated.serial.spec.ts       | 111 ++++
 tests/unit/preload-parity.spec.ts                  |  11 +-
 tests/unit/project-id-path-safety.spec.ts          | 104 +++
 tests/unit/project-management.spec.tsx             | 326 +++++++++
 tests/unit/project-store.spec.ts                   |   7 +-
 tests/unit/provider-models.spec.ts                 |  21 +
 tests/unit/reframe-cache.spec.ts                   | 414 ++++++++++++
 tests/unit/reframe-visibility.spec.tsx             | 527 +++++++++++++++
 tests/unit/reframe.serial.spec.ts                  |  35 +-
 tests/unit/settings-ipc.spec.ts                    | 134 ++++
 tests/unit/settings-panel-model-draft.spec.tsx     | 141 ++++
 tests/unit/settings-tabs.spec.tsx                  |  74 +++
 tests/unit/shortcuts.spec.ts                       | 189 ++++++
 tests/unit/sidecar-srt.spec.ts                     | 122 ++++
 tests/unit/smoke-strict.spec.ts                    |  25 +-
 tests/unit/subtitle-export.spec.ts                 | 144 ++++
 tests/unit/system-notify.spec.ts                   | 133 ++++
 tests/unit/token-estimate.spec.ts                  | 222 +++++++
 tests/unit/transcript-seek.spec.tsx                | 118 ++++
 tests/unit/use-import-controller.spec.tsx          | 145 ++++
 tests/unit/use-readiness.spec.tsx                  | 117 ++++
 tsconfig.test.json                                 |   1 +
 vitest.config.ts                                   |  12 +-
 210 files changed, 28132 insertions(+), 1191 deletions(-)
```
