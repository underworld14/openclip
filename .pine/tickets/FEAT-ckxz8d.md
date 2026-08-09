---
id: FEAT-ckxz8d
title: No global job surface — once a modal closes, running work is invisible and unreachable
status: done
priority: high
labels:
    - ux
    - jobs
deps:
    - FEAT-vh2bwz
parent: EPIC-zpa1nd
created: "2026-08-08T15:56:46Z"
updated: "2026-08-09T03:57:41Z"
---

## Current behavior

useJob.ts:200-209 documents itself as 'RESERVED, NOT YET WIRED … `uiStore.tasks`, which is currently WRITTEN but never READ by any component — the global job-queue/progress UI it was designed for doesn't exist yet.' `grep -rn "useJob("` finds zero component call sites (only two doc comments). Every progress surface is modal-local: ImportPanel.tsx:96-110, ExportPanel.tsx:430-435, ModelDownloadDialog's `busy` block. Batch export reports only `{done}/{total} exported · N failed` (ExportPanel.tsx:489-495) with no per-clip progress (`batch-export.ts:88 onClipProgress?` is never passed), no per-clip error text, and no 'Open folder' at the end.

## Desired behavior

A persistent status strip / job tray in the title bar listing every running and queued job with kind, stage, percent, and a per-job Cancel — visible from any view. A native OS notification plus dock badge on completion so the user can genuinely walk away. Batch export gets per-clip rows and a 'Reveal folder' at the end.

## Competitor precedent

OpusClip's 'we'll email you' promise (conclusionActions with EMAIL/webhook) — the desktop-native equivalent is a notification + dock badge, which is strictly better delivery of the same promise. LokaClip renders concurrent renders as a visible queue.

## Implementation sketch

The plumbing already exists and is dead code — wire it. Have import-controller, ExportPanel and ModelDownloadDialog all route through `useJob` (useJob.ts:210) so `uiStore.tasks` (uiStore.ts:29) is populated, then build `components/JobTray.tsx` reading that map and mount it in App.tsx's title bar. Add a `system:notify` channel calling Electron `Notification` + `app.dock.setBadge` on terminal `done`. For batch, pass `onClipProgress` through `batch-export.ts:88` and keep failure messages per clip instead of only counting them.

## Sizing

Impact: **high** · Effort: **medium**

## Provenance

Found by a multi-agent sweep of the codebase cross-referenced against OpusClip, Kapwing AI Clip Maker, LokaClip, yt-short-clipper and SupoClip. Every `file:line` above was read directly from the source tree.

## Done

The registry + the persistent bar landed with FEAT-vh2bwz (the spine). This
ticket finished the surface.

**Batch export has rows again.** `onClipProgress` had existed on
`runBatchExport` since it was written and was never passed. Each clip is now a
child task under the batch parent, so ten concurrent encodes show per-clip
progress and — the part that mattered — the per-clip FAILURE MESSAGE. "3 failed"
cannot be acted on; "clip-4: No space left on device" can. The parent settles
with a Reveal pointed at the first exported FILE rather than the folder, because
the main handler reveals a path inside its parent and handing it the directory
would open the directory's parent.

**Native completion delivery.** New `SYSTEM_NOTIFY` channel (additive to the
frozen `channels.ts`; `buildNamespace('system')` derives
`window.openclip.system.notify` at both type and runtime level, and
`preload-parity.spec` caught it immediately, which is the drift test doing its
job). The handler raises an Electron `Notification` and a dock badge.

Suppression is decided MAIN-SIDE, deliberately: only the main process knows
whether the window has focus, and notifying someone who is watching the bar
finish is noise. The dock badge clears on the next window focus — a badge that
outlives the user's attention is a stuck dot.

**Failures also toast.** `installJobNotifications` subscribes terminal
transitions and raises a `sonner` toast with a Retry action on failure. Successes
do NOT toast: the bar already showed them, and a toast per finished job is how
notification fatigue starts. Cancellations announce nothing at all — the user did
that themselves, seconds ago.

An id-keyed guard means a task announces once: settled tasks stay in the map
until dismissed, so without it every later store tick would re-fire. Child rows
are skipped so a batch announces once rather than once per clip.

## Work Evidence

Closed by `pine close --evidence` on 2026-08-09.

- Base: `3ea7b027` (last commit at or before ticket created 2026-08-08)
- Commits (3):
  - `f694d8f4` — feat(jobs): finish the global job surface — batch rows and completion delivery (FEAT-ckxz8d)
  - `c297147d` — fix(ai): exclusion-only OpenAI filter, honest test-connection, chip tooltips
  - `3c7d68c2` — chore(pine): adopt pine issue tracking + file the multi-agent audit backlog
- Files changed (base → working tree):

```
 .agents/skills/pine/SKILL.md                       | 145 ++++++++++
 .claude/settings.json                              |  15 +-
 .claude/skills/pine/SKILL.md                       | 145 ++++++++++
 .codex/hooks.json                                  |  14 +
 .codex/hooks/pine-learn-reminder.sh                |   6 +
 .cursor/hooks.json                                 |  10 +
 .cursor/hooks/pine-learn-reminder.sh               |   6 +
 .github/ISSUE_TEMPLATE/bug_report.md               |  30 ++
 .github/ISSUE_TEMPLATE/feature_request.md          |  15 +
 .github/pull_request_template.md                   |  24 ++
 .github/workflows/ci.yml                           |  82 ++++++
 .pine/.gitignore                                   |   4 +
 .pine/MEMORY.md                                    |  13 +
 .pine/board.json                                   |   1 +
 .pine/config.json                                  |   1 +
 .pine/memory/competitor-precedent.md               |  10 +
 .pine/memory/perf-refuted.md                       |  11 +
 .pine/memory/renderer.md                           |   9 +
 .pine/prompts/fix.md                               |  22 ++
 .pine/templates/bug.md                             |  14 +
 .pine/templates/epic.md                            |   3 +
 .pine/templates/feature.md                         |  12 +
 .pine/tickets/BUG-19bt2k.md                        | 158 ++++++++++
 .pine/tickets/BUG-2hjt1x.md                        | 226 +++++++++++++++
 .pine/tickets/BUG-2smqpv.md                        |  31 ++
 .pine/tickets/BUG-88mac4.md                        | 210 ++++++++++++++
 .pine/tickets/BUG-e06a9d.md                        | 122 ++++++++
 .pine/tickets/BUG-ery7v7.md                        | 233 +++++++++++++++
 .pine/tickets/BUG-g6zq2t.md                        | 104 +++++++
 .pine/tickets/BUG-j8pbj9.md                        | 146 ++++++++++
 .pine/tickets/BUG-t1xj4d.md                        | 134 +++++++++
 .pine/tickets/BUG-y6y5mf.md                        |  78 +++++
 .pine/tickets/BUG-yq6qbw.md                        | 212 ++++++++++++++
 .pine/tickets/BUG-yxvrwx.md                        |  80 +++++
 .pine/tickets/EPIC-4sa5jb.md                       |  14 +
 .pine/tickets/EPIC-9gkehb.md                       |  15 +
 .pine/tickets/EPIC-c2gg45.md                       |  14 +
 .pine/tickets/EPIC-f953vk.md                       |  15 +
 .pine/tickets/EPIC-n6ndb8.md                       |  15 +
 .pine/tickets/EPIC-xzzpty.md                       |  15 +
 .pine/tickets/EPIC-zpa1nd.md                       |  15 +
 .pine/tickets/FEAT-0s2tnc.md                       |  36 +++
 .pine/tickets/FEAT-1k76hk.md                       | 168 +++++++++++
 .pine/tickets/FEAT-26tkya.md                       |  44 +++
 .pine/tickets/FEAT-51hnwx.md                       |  36 +++
 .pine/tickets/FEAT-56bxyh.md                       |  35 +++
 .pine/tickets/FEAT-5hnsby.md                       |  36 +++
 .pine/tickets/FEAT-6v92dk.md                       | 183 ++++++++++++
 .pine/tickets/FEAT-71ay4e.md                       |  36 +++
 .pine/tickets/FEAT-7ffxsg.md                       |  36 +++
 .pine/tickets/FEAT-8559h1.md                       | 245 ++++++++++++++++
 .pine/tickets/FEAT-905vk4.md                       |  36 +++
 .pine/tickets/FEAT-az3sxm.md                       |  36 +++
 .pine/tickets/FEAT-azqfsv.md                       |  33 +++
 .pine/tickets/FEAT-bd87vz.md                       |  38 +++
 .pine/tickets/FEAT-c0zn3j.md                       | 282 ++++++++++++++++++
 .pine/tickets/FEAT-c5a15c.md                       | 168 +++++++++++
 .pine/tickets/FEAT-ckxz8d.md                       |  73 +++++
 .pine/tickets/FEAT-d8b6bj.md                       |  44 +++
 .pine/tickets/FEAT-et1gxc.md                       | 168 +++++++++++
 .pine/tickets/FEAT-g39qj3.md                       |  36 +++
 .pine/tickets/FEAT-hmsg5h.md                       | 168 +++++++++++
 .pine/tickets/FEAT-k28j7h.md                       |  37 +++
 .pine/tickets/FEAT-kncqxf.md                       | 178 ++++++++++++
 .pine/tickets/FEAT-ks4yy4.md                       | 143 +++++++++
 .pine/tickets/FEAT-ky1jfw.md                       | 264 +++++++++++++++++
 .pine/tickets/FEAT-kzej8t.md                       |  36 +++
 .pine/tickets/FEAT-n762y6.md                       |  47 +++
 .pine/tickets/FEAT-rmh08k.md                       |  34 +++
 .pine/tickets/FEAT-vh2bwz.md                       | 180 ++++++++++++
 .pine/tickets/FEAT-vvaycm.md                       |  37 +++
 .pine/tickets/FEAT-vwvgs0.md                       |  36 +++
 .pine/tickets/FEAT-ybhdhz.md                       |  36 +++
 .prettierignore                                    |  12 +
 AGENTS.md                                          |  26 ++
 CLAUDE.md                                          |  26 ++
 src/main/index.ts                                  |   9 +
 src/main/ipc/ai.ts                                 | 147 +++++++++-
 src/main/ipc/index.ts                              |   4 +-
 src/main/ipc/job-start-validation.ts               |  15 +-
 src/main/ipc/model.ts                              |  25 +-
 src/main/ipc/system.ts                             |  77 +++++
 src/main/services/ai-client.ts                     | 216 +++++++++++---
 src/main/services/ffmpeg-export.ts                 |  50 +++-
 src/main/services/jobs/export-runner.ts            |  25 +-
 src/main/services/jobs/generate-clips-runner.ts    | 133 +++++++++
 src/main/services/model-manager.ts                 |  27 +-
 src/main/services/provider-models.ts               | 146 ++++++++++
 src/main/services/reframe-detect.ts                |  22 +-
 src/main/services/sidecar-manager.ts               |   5 +
 src/main/services/silence-detect.ts                |   4 +
 src/preload/api/files.ts                           |  35 +++
 src/preload/index.ts                               |   7 +-
 src/renderer/src/App.tsx                           | 112 ++++++-
 src/renderer/src/components/ClipSidebar.tsx        |  51 +++-
 src/renderer/src/components/ExportPanel.tsx        | 120 ++++++--
 src/renderer/src/components/ImportPanel.tsx        |  74 ++++-
 src/renderer/src/components/JobStatusBar.tsx       | 256 ++++++++++++++++
 .../src/components/ModelDownloadDialog.tsx         | 100 +++++--
 src/renderer/src/components/ReadinessBar.tsx       |  75 +++++
 src/renderer/src/components/SettingsPanel.tsx      | 204 +++++++++----
 .../src/components/TranscriptionSettings.tsx       | 176 +++++++++++
 src/renderer/src/components/export-run.ts          |  14 +-
 src/renderer/src/components/formatBytes.ts         |  15 +
 src/renderer/src/components/generate-clips-run.ts  |  54 ++++
 src/renderer/src/components/generateClips.ts       |  12 +-
 src/renderer/src/components/import-pipeline.ts     |  42 ++-
 src/renderer/src/components/jobStatus.ts           | 322 +++++++++++++++++++++
 src/renderer/src/components/model-download.ts      |   7 +
 src/renderer/src/components/readinessView.ts       | 132 +++++++++
 src/renderer/src/components/settingsView.ts        |  68 ++++-
 src/renderer/src/hooks/import-controller.ts        | 234 ++++++++++++---
 src/renderer/src/hooks/importControllerHost.ts     |  42 +++
 src/renderer/src/hooks/useImportController.ts      |  88 ++++--
 src/renderer/src/hooks/useJob.ts                   | 150 ++--------
 src/renderer/src/hooks/useProject.ts               |   5 +
 src/renderer/src/hooks/useReadiness.ts             |  77 +++++
 src/renderer/src/main.tsx                          |  12 +
 src/renderer/src/stores/jobNotifications.ts        |  90 ++++++
 src/renderer/src/stores/jobsStore.ts               | 249 ++++++++++++++++
 src/renderer/src/stores/projectStore/autosave.ts   |  61 +++-
 src/renderer/src/stores/projectStore/clipsSlice.ts |  88 +++++-
 .../src/stores/projectStore/exportSlice.ts         |   4 +-
 src/renderer/src/stores/uiStore.ts                 |  37 +--
 src/shared/channels.ts                             | 113 ++++++--
 src/shared/jobs.ts                                 |  83 +++++-
 tests/e2e/generate-clips-button.e2e.spec.ts        |  41 +++
 tests/e2e/integration-wave1.e2e.spec.ts            |  31 +-
 tests/e2e/job-status-bar.e2e.spec.ts               | 127 ++++++++
 tests/e2e/model-gate.e2e.spec.ts                   |  53 ++++
 tests/e2e/ping.e2e.spec.ts                         |  72 +++--
 tests/mocks/openclip.ts                            |  20 +-
 tests/unit/ai-components.spec.ts                   |  57 +++-
 tests/unit/ai-ipc.spec.ts                          | 146 +++++++++-
 tests/unit/ai-mapreduce.spec.ts                    | 112 +++++++
 tests/unit/ai-stores.spec.ts                       | 162 ++++++++---
 tests/unit/autosave-subscriber.spec.ts             |  73 +++++
 tests/unit/contract.spec.ts                        |  24 ++
 tests/unit/export-runner.spec.ts                   |  67 ++++-
 tests/unit/ffmpeg-export.serial.spec.ts            |  42 +++
 tests/unit/ffmpeg-export.spec.ts                   |  56 +++-
 tests/unit/format-bytes.spec.ts                    |  25 ++
 tests/unit/generate-clips-runner.spec.ts           | 188 ++++++++++++
 tests/unit/generate-clips-view.spec.ts             |  23 ++
 tests/unit/import-controller-host.spec.ts          |  56 ++++
 tests/unit/import-controller.spec.ts               | 215 +++++++++++++-
 tests/unit/import-url.spec.ts                      |  21 ++
 tests/unit/job-notifications.spec.ts               | 131 +++++++++
 tests/unit/job-status.spec.ts                      | 220 ++++++++++++++
 tests/unit/jobs-store.spec.ts                      | 208 +++++++++++++
 tests/unit/model-manager.spec.ts                   |  30 +-
 tests/unit/onboarding-handlers.spec.ts             | 145 ++++++++++
 tests/unit/preload-parity.spec.ts                  |  18 +-
 tests/unit/provider-models.spec.ts                 | 118 ++++++++
 tests/unit/readiness-view.spec.ts                  | 117 ++++++++
 tests/unit/silence-detect.spec.ts                  |  11 +
 tests/unit/system-notify.spec.ts                   | 133 +++++++++
 tests/unit/use-project.spec.ts                     |  11 +
 158 files changed, 11778 insertions(+), 547 deletions(-)
```
