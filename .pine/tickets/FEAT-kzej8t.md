---
id: FEAT-kzej8t
title: Auto-reframe is an invisible, unpreviewable, un-overridable on/off switch
status: done
priority: medium
labels:
    - ux
    - reframe
parent: EPIC-f953vk
created: "2026-08-08T15:56:46Z"
updated: "2026-08-14T14:34:29Z"
---

## Current behavior

PreviewPlayer's crop is CSS-only (PreviewPlayer.tsx:168-175); when reframe is on, the preview does not change at all — it just shows a badge reading 'Auto-reframe on export' (PreviewPlayer.tsx:217-224). The user cannot see the face-follow plan, cannot correct a wrong-speaker track, and cannot letterbox instead of crop (pad/fit mode from PRD Appendix A is unimplemented — ffmpeg-export.ts:75-86 `cropExpr` has no pad branch). Detection failure silently degrades to center-crop (export-runner.ts:161 wraps each analysis pass in its own try/catch) with no user-visible signal.

## Desired behavior

Named modes in one control — 'Fill (center crop)', 'Fit (blurred/letterbox background)', 'Follow speaker', 'Split screen' — with the computed plan drawn on the timeline as crop keyframes the user can nudge or delete, and a manual crop box draggable over the preview frame. When detection fails or finds no reliable face, say so and fall back to Fit rather than silently center-cropping.

## Competitor precedent

Kapwing offers three explicit fill modes ('Fit to Center' / 'Fill and Crop' / 'Speaker Focus'). OpusClip names Fill / Fit / Split / Screenshare / Gameplay, applicable per-scene, with a Manual Reframe window on double-click. openshorts falls back from TRACK to a blurred-background GENERAL mode when no face dominates.

## Implementation sketch

Step 1 (small, high value): implement the pad/fit branch in `cropExpr` (ffmpeg-export.ts:75-86) using `scale=…:force_original_aspect_ratio=decrease,pad=…` plus a blurred `split`+`gblur` background, and add it to the reframe select at ExportPanel.tsx:397-409. Step 2: return the `ReframePlan` (already a pure structure in `src/shared/reframe-plan.ts`) to the renderer from a new `video:plan-reframe` channel and render its keyframes as dots on the Timeline track. Step 3: let the preview apply the plan's `crop x` at the current playhead via CSS `object-position`, so face-follow is actually visible. Note reframe planning currently has no cache (docs/auto-reframe-design.md:50 asks for one) — add plan caching keyed on clip id + bounds first, or step 2 re-pays full analysis on every preview.

## Sizing

Impact: **medium** · Effort: **large**

## Provenance

Found by a multi-agent sweep of the codebase cross-referenced against OpusClip, Kapwing AI Clip Maker, LokaClip, yt-short-clipper and SupoClip. Every `file:line` above was read directly from the source tree.

## Delivered (2026-08-14)

- `video:plan-reframe` channel; preview follows the plan's crop at the playhead
  (`cropXAt`, interpolating like the burn). Shares the export plan cache, so the
  preview and the export read one plan.
- `ReframePlan` carries pan `keyframes` (the `xExpr` is unevaluable in the
  renderer, which is why the plan could never be previewed or drawn).
- Detection failure is NAMED in the badge with the cause in its tooltip, instead
  of degrading to a centre crop in silence. Failures are not cached.
- ONE framing control — Fill / Follow speaker / Split screen / Fit (bars) /
  Fit (blur) — replacing the two that interacted and needed a warning.
- Timeline draws a dot per pan keyframe, rebased onto the source timeline.

- **Manual crop override**: drag the preview to place the crop by hand
  (`Clip.reframeCropX`). Persists, wins over the computed plan in both the
  preview and the export, skips detection entirely, and has a Reset button.

## NOT delivered, deliberately

- **Auto-switch to Fit on detection failure.** The "say so" half is done;
  silently letterboxing an export the user configured as "Follow speaker" trades
  one surprise for another. The merged control puts Fit one click away and the
  badge says why they might want it.
- **Nudge/delete individual crop keyframes.** The dots are read-only. The manual
  override subsumes most of the value (pin the crop where you want it) without
  the machinery of persisting a hand-edited plan and deciding when a re-detect
  is allowed to discard those edits.

Sequenced after FEAT-bd87vz (pad/fit — Step 1) and FEAT-rmh08k (plan cache —
Step 2's prerequisite), both closed.

## Work Evidence

Closed by `pine close --evidence` on 2026-08-14.

- Base: `3ea7b027` (last commit at or before ticket created 2026-08-08)
- Commits (4):
  - `ac51ad81` — feat(reframe): a manual crop override — auto-reframe is no longer un-overridable (FEAT-kzej8t)
  - `8409069d` — chore(pine): FEAT-kzej8t → testing, with delivered/not-delivered scope
  - `f111eac8` — feat(reframe): make auto-reframe visible, previewable and honest about failure (FEAT-kzej8t)
  - `3c7d68c2` — chore(pine): adopt pine issue tracking + file the multi-agent audit backlog
- Files changed (base → working tree):

```
 .agents/skills/pine/SKILL.md                       | 145 ++++
 .claude/settings.json                              |  15 +-
 .claude/skills/pine/SKILL.md                       | 145 ++++
 .codex/hooks.json                                  |  14 +
 .codex/hooks/pine-learn-reminder.sh                |   6 +
 .cursor/hooks.json                                 |  10 +
 .cursor/hooks/pine-learn-reminder.sh               |   6 +
 .github/ISSUE_TEMPLATE/bug_report.md               |  30 +
 .github/ISSUE_TEMPLATE/feature_request.md          |  15 +
 .github/pull_request_template.md                   |  24 +
 .github/workflows/ci.yml                           | 100 +++
 .pine/.gitignore                                   |   4 +
 .pine/MEMORY.md                                    |  13 +
 .pine/board.json                                   |   1 +
 .pine/config.json                                  |   1 +
 .pine/memory/ci.md                                 |  19 +
 .pine/memory/competitor-precedent.md               |  10 +
 .pine/memory/perf-refuted.md                       |  11 +
 .pine/memory/renderer.md                           |  15 +
 .pine/prompts/fix.md                               |  22 +
 .pine/templates/bug.md                             |  14 +
 .pine/templates/epic.md                            |   3 +
 .pine/templates/feature.md                         |  12 +
 .pine/tickets/BUG-19bt2k.md                        | 158 +++++
 .pine/tickets/BUG-2hjt1x.md                        | 226 +++++++
 .pine/tickets/BUG-2smqpv.md                        | 250 +++++++
 .pine/tickets/BUG-88mac4.md                        | 210 ++++++
 .pine/tickets/BUG-e06a9d.md                        | 338 ++++++++++
 .pine/tickets/BUG-ery7v7.md                        | 233 +++++++
 .pine/tickets/BUG-g6zq2t.md                        | 344 ++++++++++
 .pine/tickets/BUG-j8pbj9.md                        | 146 +++++
 .pine/tickets/BUG-jt3d62.md                        | 156 +++++
 .pine/tickets/BUG-t1xj4d.md                        | 360 ++++++++++
 .pine/tickets/BUG-y6y5mf.md                        | 300 +++++++++
 .pine/tickets/BUG-yq6qbw.md                        | 449 +++++++++++++
 .pine/tickets/BUG-yxvrwx.md                        | 296 +++++++++
 .pine/tickets/BUG-zcqyb7.md                        | 198 ++++++
 .pine/tickets/EPIC-4sa5jb.md                       |  14 +
 .pine/tickets/EPIC-9gkehb.md                       | 277 ++++++++
 .pine/tickets/EPIC-c2gg45.md                       | 276 ++++++++
 .pine/tickets/EPIC-f953vk.md                       |  15 +
 .pine/tickets/EPIC-n6ndb8.md                       | 277 ++++++++
 .pine/tickets/EPIC-xzzpty.md                       |  15 +
 .pine/tickets/EPIC-zpa1nd.md                       |  48 ++
 .pine/tickets/FEAT-0s2tnc.md                       | 293 +++++++++
 .pine/tickets/FEAT-1k76hk.md                       | 168 +++++
 .pine/tickets/FEAT-26tkya.md                       | 141 ++++
 .pine/tickets/FEAT-51hnwx.md                       | 278 ++++++++
 .pine/tickets/FEAT-56bxyh.md                       | 300 +++++++++
 .pine/tickets/FEAT-5hnsby.md                       | 261 ++++++++
 .pine/tickets/FEAT-6v92dk.md                       | 183 ++++++
 .pine/tickets/FEAT-71ay4e.md                       | 285 ++++++++
 .pine/tickets/FEAT-7ffxsg.md                       | 248 +++++++
 .pine/tickets/FEAT-8559h1.md                       | 245 +++++++
 .pine/tickets/FEAT-905vk4.md                       | 314 +++++++++
 .pine/tickets/FEAT-az3sxm.md                       | 268 ++++++++
 .pine/tickets/FEAT-azqfsv.md                       |  33 +
 .pine/tickets/FEAT-bd87vz.md                       | 297 +++++++++
 .pine/tickets/FEAT-c0zn3j.md                       | 282 ++++++++
 .pine/tickets/FEAT-c5a15c.md                       | 168 +++++
 .pine/tickets/FEAT-ckxz8d.md                       | 246 +++++++
 .pine/tickets/FEAT-d8b6bj.md                       | 252 +++++++
 .pine/tickets/FEAT-et1gxc.md                       | 168 +++++
 .pine/tickets/FEAT-g39qj3.md                       | 278 ++++++++
 .pine/tickets/FEAT-hmsg5h.md                       | 168 +++++
 .pine/tickets/FEAT-k28j7h.md                       | 268 ++++++++
 .pine/tickets/FEAT-kncqxf.md                       | 178 +++++
 .pine/tickets/FEAT-ks4yy4.md                       | 143 ++++
 .pine/tickets/FEAT-ky1jfw.md                       | 264 ++++++++
 .pine/tickets/FEAT-kzej8t.md                       |  67 ++
 .pine/tickets/FEAT-n762y6.md                       | 301 +++++++++
 .pine/tickets/FEAT-rmh08k.md                       | 297 +++++++++
 .pine/tickets/FEAT-vh2bwz.md                       | 180 +++++
 .pine/tickets/FEAT-vvaycm.md                       | 312 +++++++++
 .pine/tickets/FEAT-vwvgs0.md                       | 283 ++++++++
 .pine/tickets/FEAT-ybhdhz.md                       | 278 ++++++++
 .prettierignore                                    |  12 +
 AGENTS.md                                          |  26 +
 CLAUDE.md                                          |  26 +
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
 src/main/index.ts                                  |  33 +-
 src/main/ipc/ai.ts                                 | 152 ++++-
 src/main/ipc/index.ts                              |   4 +-
 src/main/ipc/job-start-validation.ts               |  45 +-
 src/main/ipc/model.ts                              |  25 +-
 src/main/ipc/project.ts                            |  52 +-
 src/main/ipc/settings.ts                           |  98 ++-
 src/main/ipc/system.ts                             |  81 +++
 src/main/ipc/video.ts                              | 107 ++-
 src/main/menu.ts                                   | 124 ++++
 src/main/services/ai-client.ts                     | 412 ++++++++++--
 src/main/services/ass-captions.ts                  |  50 +-
 src/main/services/encoder-probe.ts                 |  64 ++
 src/main/services/ffmpeg-caption.ts                |  49 +-
 src/main/services/ffmpeg-export.ts                 | 171 ++++-
 src/main/services/jobs/export-runner.ts            | 270 +++++++-
 src/main/services/jobs/generate-clips-runner.ts    | 142 ++++
 src/main/services/model-manager.ts                 |  27 +-
 src/main/services/openrouter-models.ts             |  37 +-
 src/main/services/project-store.ts                 |  54 +-
 src/main/services/provider-models.ts               | 146 +++++
 src/main/services/reframe-cache.ts                 | 156 +++++
 src/main/services/reframe-detect.ts                | 183 +++++-
 src/main/services/sidecar-manager.ts               |   5 +
 src/main/services/silence-detect.ts                |   4 +
 src/main/utils/paths.ts                            |  29 +-
 src/preload/api/files.ts                           |  35 +
 src/preload/index.ts                               |  13 +-
 src/preload/menu-command.ts                        |  32 +
 src/renderer/src/App.tsx                           | 415 +++++++++++-
 src/renderer/src/assets/index.css                  |  29 +
 src/renderer/src/components/BrandKitEditor.tsx     |  57 +-
 src/renderer/src/components/CaptionStylePanel.tsx  | 147 +++++
 src/renderer/src/components/ClipCard.tsx           | 208 +++++-
 src/renderer/src/components/ClipSidebar.tsx        | 137 +++-
 src/renderer/src/components/Dashboard.tsx          | 235 ++++++-
 src/renderer/src/components/Dashboard.view.ts      |   5 +-
 src/renderer/src/components/ExportPanel.tsx        | 315 ++++++---
 .../src/components/GeneratePreflightDialog.tsx     | 311 +++++++++
 src/renderer/src/components/ImportPanel.tsx        |  74 ++-
 src/renderer/src/components/JobStatusBar.tsx       | 256 ++++++++
 .../src/components/ModelDownloadDialog.tsx         | 100 ++-
 src/renderer/src/components/PreviewPlayer.tsx      | 156 ++++-
 src/renderer/src/components/ReadinessBar.tsx       |  75 +++
 src/renderer/src/components/SettingsPanel.tsx      | 575 ++++++++++------
 src/renderer/src/components/ShortcutSheet.tsx      |  63 ++
 src/renderer/src/components/Timeline.tsx           |  32 +-
 src/renderer/src/components/TranscriptPanel.tsx    |  89 ++-
 .../src/components/TranscriptionSettings.tsx       | 176 +++++
 src/renderer/src/components/Welcome.tsx            |  12 +-
 src/renderer/src/components/batch-export.ts        |   7 +
 src/renderer/src/components/captionSample.ts       |  62 ++
 src/renderer/src/components/clipView.ts            |  88 ++-
 src/renderer/src/components/export-run.ts          |  14 +-
 src/renderer/src/components/formatBytes.ts         |  15 +
 src/renderer/src/components/generate-clips-run.ts  |  54 ++
 src/renderer/src/components/generateClips.ts       |  56 +-
 src/renderer/src/components/import-pipeline.ts     |  42 +-
 src/renderer/src/components/jobStatus.ts           | 322 +++++++++
 src/renderer/src/components/model-download.ts      |   7 +
 src/renderer/src/components/readinessView.ts       | 132 ++++
 src/renderer/src/components/saveStatus.ts          |  39 ++
 src/renderer/src/components/settingsView.ts        |  95 ++-
 src/renderer/src/components/ui/dialog.tsx          |  25 +-
 src/renderer/src/hooks/import-controller.ts        | 234 +++++--
 src/renderer/src/hooks/importControllerHost.ts     |  42 ++
 src/renderer/src/hooks/jobPort.ts                  |  25 +-
 src/renderer/src/hooks/useGlobalShortcuts.ts       |  91 +++
 src/renderer/src/hooks/useImportController.ts      | 125 +++-
 src/renderer/src/hooks/useJob.ts                   | 150 +----
 src/renderer/src/hooks/useProject.ts               |  61 ++
 src/renderer/src/hooks/useReadiness.ts             |  77 +++
 src/renderer/src/main.tsx                          |  12 +
 src/renderer/src/stores/jobNotifications.ts        |  90 +++
 src/renderer/src/stores/jobsStore.ts               | 249 +++++++
 src/renderer/src/stores/projectStore/autosave.ts   | 132 +++-
 src/renderer/src/stores/projectStore/clipsSlice.ts | 153 ++++-
 .../src/stores/projectStore/exportSlice.ts         |  20 +-
 .../src/stores/projectStore/previewSlice.ts        |  85 ++-
 .../src/stores/projectStore/timelineSlice.ts       |  38 +-
 src/renderer/src/stores/uiStore.ts                 |  55 +-
 src/shared/channels.ts                             | 241 ++++++-
 src/shared/clip-snap.ts                            | 149 +++++
 src/shared/framing-modes.ts                        |  96 +++
 src/shared/generate-preflight.ts                   | 404 ++++++++++++
 src/shared/jobs.ts                                 | 159 ++++-
 src/shared/reframe-plan.ts                         |  95 ++-
 src/shared/schema.ts                               |  33 +-
 src/shared/shortcuts.ts                            | 385 +++++++++++
 src/shared/subtitle-export.ts                      | 127 ++++
 src/shared/token-estimate.ts                       | 201 ++++++
 tests/e2e/export.e2e.spec.ts                       |  27 +-
 tests/e2e/generate-clips-button.e2e.spec.ts        |  68 ++
 tests/e2e/integration-wave1.e2e.spec.ts            |  37 +-
 tests/e2e/job-status-bar.e2e.spec.ts               | 127 ++++
 tests/e2e/model-gate.e2e.spec.ts                   |  53 ++
 tests/e2e/ping.e2e.spec.ts                         |  72 +-
 tests/e2e/timeline.e2e.spec.ts                     |  27 +-
 tests/e2e/vertical-slice.e2e.spec.ts               |  75 ++-
 tests/fixtures/contract/index.ts                   |  19 +-
 tests/harness/fixtures.ts                          |  47 ++
 tests/harness/renderer-env.ts                      |  59 ++
 tests/mocks/openclip.ts                            |  47 +-
 tests/unit/ai-components.spec.ts                   |  57 +-
 tests/unit/ai-ipc.spec.ts                          | 160 ++++-
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
 tests/unit/contract.spec.ts                        |  24 +
 tests/unit/dialog-scroll.spec.tsx                  | 101 +++
 tests/unit/export-cancel.spec.tsx                  | 106 +++
 tests/unit/export-fit-mode.serial.spec.ts          | 143 ++++
 tests/unit/export-fit-mode.spec.ts                 | 199 ++++++
 tests/unit/export-runner.spec.ts                   |  67 +-
 tests/unit/ffmpeg-export.serial.spec.ts            |  63 +-
 tests/unit/ffmpeg-export.spec.ts                   |  56 +-
 tests/unit/ffmpeg-version.serial.spec.ts           |  35 +-
 tests/unit/force-cpu.spec.ts                       | 160 +++++
 tests/unit/format-bytes.spec.ts                    |  25 +
 tests/unit/generate-clips-runner.spec.ts           | 188 ++++++
 tests/unit/generate-clips-view.spec.ts             |  23 +
 tests/unit/generate-preflight-dialog.spec.tsx      | 374 +++++++++++
 tests/unit/generate-preflight.spec.ts              | 377 +++++++++++
 tests/unit/global-shortcuts.spec.tsx               | 221 +++++++
 tests/unit/import-controller-host.spec.ts          |  56 ++
 tests/unit/import-controller.spec.ts               | 215 +++++-
 tests/unit/import-panel-drop.spec.tsx              | 136 ++++
 tests/unit/import-url.spec.ts                      |  21 +
 tests/unit/ipc-project.spec.ts                     |  11 +-
 tests/unit/job-notifications.spec.ts               | 131 ++++
 tests/unit/job-port-window-delivery.spec.tsx       |  81 +++
 tests/unit/job-start-validation.spec.ts            |  24 +
 tests/unit/job-status.spec.ts                      | 220 +++++++
 tests/unit/jobs-store.spec.ts                      | 208 ++++++
 tests/unit/model-manager.spec.ts                   |  30 +-
 tests/unit/onboarding-handlers.spec.ts             | 145 ++++
 tests/unit/openrouter-curated.serial.spec.ts       | 111 ++++
 tests/unit/preload-parity.spec.ts                  |  28 +-
 tests/unit/project-id-path-safety.spec.ts          | 104 +++
 tests/unit/project-management.spec.tsx             | 326 +++++++++
 tests/unit/project-store.spec.ts                   |   7 +-
 tests/unit/provider-models.spec.ts                 | 118 ++++
 tests/unit/readiness-view.spec.ts                  | 117 ++++
 tests/unit/reframe-cache.spec.ts                   | 414 ++++++++++++
 tests/unit/reframe-visibility.spec.tsx             | 527 +++++++++++++++
 tests/unit/reframe.serial.spec.ts                  |  35 +-
 tests/unit/settings-ipc.spec.ts                    | 134 ++++
 tests/unit/settings-panel-model-draft.spec.tsx     | 141 ++++
 tests/unit/settings-tabs.spec.tsx                  |  74 +++
 tests/unit/shortcuts.spec.ts                       | 189 ++++++
 tests/unit/sidecar-srt.spec.ts                     | 122 ++++
 tests/unit/silence-detect.spec.ts                  |  11 +
 tests/unit/smoke-strict.spec.ts                    |  25 +-
 tests/unit/subtitle-export.spec.ts                 | 144 ++++
 tests/unit/system-notify.spec.ts                   | 133 ++++
 tests/unit/token-estimate.spec.ts                  | 222 +++++++
 tests/unit/transcript-seek.spec.tsx                | 118 ++++
 tests/unit/use-import-controller.spec.tsx          | 145 ++++
 tests/unit/use-project.spec.ts                     |  11 +
 tests/unit/use-readiness.spec.tsx                  | 117 ++++
 tsconfig.test.json                                 |   1 +
 vitest.config.ts                                   |  12 +-
 268 files changed, 34457 insertions(+), 1160 deletions(-)
```
