---
id: FEAT-vh2bwz
title: Job registry + persistent status bar (spine for EPIC-zpa1nd)
status: done
priority: critical
labels:
    - ux
    - jobs
parent: EPIC-zpa1nd
created: "2026-08-08T18:19:42Z"
updated: "2026-08-09T03:57:41Z"
---

# Description

The shared spine the other four EPIC-zpa1nd tickets all need: ONE renderer-side
registry of running work, and ONE persistent surface that renders it regardless of
which view or modal is mounted.

Today the plumbing exists but is dead. `uiStore.tasks` (uiStore.ts:29) is WRITTEN by
the import controller and read by nobody; `useJob` (useJob.ts:200-209) documents
itself as "RESERVED, NOT YET WIRED … delete this + the `uiStore.tasks` map if the
queue UI is dropped from the roadmap" and has zero component call sites. Every
progress surface is modal-local, so any of them can unmount out from under a running
job.

## Design

Track at the ORCHESTRATOR level, not inside `drainJob`. Two reasons: `useJob.ts` is a
FROZEN trunk seam, and the unit a user cares about is the ACTIVITY ("Import
talk.mp4"), not the individual job — one import is `url-download` + probe + extract +
`transcribe`, i.e. three jobs and two invokes under a single bar. The five
orchestrators (`import-pipeline`, `export-run`, `batch-export`, `model-download`,
and the new `generate-clips-run`) already take `onProgress`/`onStart`, so that is
exactly where the activity boundary is.

# Acceptance Criteria
- [x] `stores/jobsStore.ts` holds every running activity keyed by task id, with
      `beginTask`/`updateTask`/`settleTask`/`dismissTask`, `activeTasks()`,
      `hasActiveKind()` and a `trackTask(spec, run)` wrapper
- [x] `components/jobStatus.ts` is a PURE view-model (STAGE_LABELS, describeTask,
      estimateEta, selectPrimaryTask) unit-tested in the node env with no DOM
- [x] `components/JobStatusBar.tsx` is mounted in App.tsx between the title bar and
      the body, so it renders in BOTH the Welcome and editor layouts
- [x] import / single export / batch export / model download all register a task
- [x] every task exposes a working per-task Cancel
- [x] `uiStore.tasks`, `upsertTask`, `clearTask` and the unused `useJob` hook are
      deleted; `jobEvents` + `drainJob` are untouched
- [x] `npm run typecheck && npm run lint && npm test` green (896 passed, 1 skipped)
- [ ] seen working in the real app — deferred to FEAT-ky1jfw, which is the slice
      that actually puts a long job on screen

# Implementation Plan

1. `stores/jobsStore.ts` — the `JobTask` record + actions + `trackTask`.
2. `components/jobStatus.ts` — pure labels/ETA/selection helpers.
3. `components/JobStatusBar.tsx` — collapsed primary row, `+N more` expansion,
   per-row Cancel, terminal states lingering ~8s with Retry / Reveal / dismiss.
   Testids: `job-status-bar`, `job-status-stage`, `job-status-cancel`,
   `job-status-retry`.
4. Wire the orchestrators through `trackTask`.
5. Delete `uiStore.tasks` + the `useJob` hook; trim `tests/unit/usejob.spec.ts` to
   the `jobEvents` + `drainJob` cases.

# Notes

ETA is derived renderer-side from `(now - startedAt) / pct` in `jobStatus.ts` — one
implementation for every kind, rather than threading the (never-set) optional
`JobEvent.etaMs` out of five separate runners.

Two behaviours worth not "fixing" later without reading why:

- A SUCCESS auto-dismisses after `DONE_DISMISS_MS`; a FAILURE or CANCELLATION stays
  until the user dismisses or retries it. An error that clears itself on a timer is
  the silent-failure bug this epic exists to kill, just slower.
- `trackTask(...).abandon()` drops the row instead of settling it, for work that
  turned out never to have started — an export whose save dialog was dismissed did
  not succeed and did not fail, and "clip.mp4 finished" for a file that was never
  written is the worse of the two lies.

## Commit provenance (bookkeeping)

`jobStatus.ts` and `jobsStore.ts` were first committed in `c297147`
("fix(ai): exclusion-only OpenAI filter, honest test-connection, chip tooltips")
by a CONCURRENT session working in the same worktree, which swept them up while
they were still uncommitted here. The code is this ticket's; only that commit's
subject is misleading. `git log --follow` on either file will land there first.

# Related Files

- src/renderer/src/stores/jobsStore.ts (new)
- src/renderer/src/components/jobStatus.ts (new)
- src/renderer/src/components/JobStatusBar.tsx (new)
- src/renderer/src/stores/uiStore.ts
- src/renderer/src/hooks/useJob.ts
- src/renderer/src/App.tsx

# Attachments

## Work Evidence

Closed by `pine close --evidence` on 2026-08-09.

- Base: `fadd41eb` (last commit at or before ticket created 2026-08-08)
- Commits (2):
  - `0a9d3058` — feat(jobs): a job surface that outlives the panel that started it (FEAT-vh2bwz)
  - `eb1be422` — fix(onboarding): address code review — two regressions plus readiness correctness
- Files changed (base → working tree):

```
 .pine/tickets/FEAT-26tkya.md                       |  44 +++
 .pine/tickets/FEAT-8559h1.md                       |  40 ++-
 .pine/tickets/FEAT-azqfsv.md                       |  33 +++
 .pine/tickets/FEAT-c0zn3j.md                       |  55 +++-
 .pine/tickets/FEAT-ckxz8d.md                       |  41 ++-
 .pine/tickets/FEAT-ky1jfw.md                       |  45 ++-
 .pine/tickets/FEAT-vh2bwz.md                       |  98 +++++++
 src/main/index.ts                                  |   9 +
 src/main/ipc/ai.ts                                 |  36 ++-
 src/main/ipc/job-start-validation.ts               |  15 +-
 src/main/ipc/model.ts                              |  20 +-
 src/main/ipc/system.ts                             |  31 ++
 src/main/services/ai-client.ts                     | 216 +++++++++++---
 src/main/services/jobs/export-runner.ts            |  25 +-
 src/main/services/jobs/generate-clips-runner.ts    | 133 +++++++++
 src/main/services/provider-models.ts               |  41 +--
 src/main/services/reframe-detect.ts                |  22 +-
 src/main/services/sidecar-manager.ts               |   5 +
 src/renderer/src/App.tsx                           |  62 +++-
 src/renderer/src/components/ClipSidebar.tsx        |  51 +++-
 src/renderer/src/components/ExportPanel.tsx        | 120 ++++++--
 src/renderer/src/components/ImportPanel.tsx        |   6 +-
 src/renderer/src/components/JobStatusBar.tsx       | 256 ++++++++++++++++
 .../src/components/ModelDownloadDialog.tsx         |  43 ++-
 src/renderer/src/components/ReadinessBar.tsx       |   6 +-
 src/renderer/src/components/SettingsPanel.tsx      |  34 ++-
 .../src/components/TranscriptionSettings.tsx       |  30 +-
 src/renderer/src/components/export-run.ts          |  14 +-
 src/renderer/src/components/generate-clips-run.ts  |  54 ++++
 src/renderer/src/components/import-pipeline.ts     |  42 ++-
 src/renderer/src/components/jobStatus.ts           | 322 +++++++++++++++++++++
 src/renderer/src/components/readinessView.ts       |  38 ++-
 src/renderer/src/components/settingsView.ts        |  30 +-
 src/renderer/src/hooks/import-controller.ts        | 160 +++++++---
 src/renderer/src/hooks/importControllerHost.ts     |  42 +++
 src/renderer/src/hooks/useImportController.ts      |  39 ++-
 src/renderer/src/hooks/useJob.ts                   | 150 ++--------
 src/renderer/src/hooks/useReadiness.ts             |   4 +-
 src/renderer/src/main.tsx                          |   8 +
 src/renderer/src/stores/jobNotifications.ts        |  90 ++++++
 src/renderer/src/stores/jobsStore.ts               | 249 ++++++++++++++++
 src/renderer/src/stores/projectStore/autosave.ts   |  61 +++-
 src/renderer/src/stores/projectStore/clipsSlice.ts |  88 +++++-
 .../src/stores/projectStore/exportSlice.ts         |   4 +-
 src/renderer/src/stores/uiStore.ts                 |  37 +--
 src/shared/channels.ts                             |  49 ++--
 src/shared/jobs.ts                                 |  83 +++++-
 tests/e2e/integration-wave1.e2e.spec.ts            |  31 +-
 tests/e2e/job-status-bar.e2e.spec.ts               | 127 ++++++++
 tests/e2e/model-gate.e2e.spec.ts                   |  53 ++++
 tests/e2e/ping.e2e.spec.ts                         |   9 +-
 tests/mocks/openclip.ts                            |  16 +
 tests/unit/ai-components.spec.ts                   |  20 +-
 tests/unit/ai-mapreduce.spec.ts                    | 112 +++++++
 tests/unit/ai-stores.spec.ts                       | 162 ++++++++---
 tests/unit/autosave-subscriber.spec.ts             |  73 +++++
 tests/unit/export-runner.spec.ts                   |  67 ++++-
 tests/unit/generate-clips-runner.spec.ts           | 188 ++++++++++++
 tests/unit/import-controller-host.spec.ts          |  56 ++++
 tests/unit/import-controller.spec.ts               |  72 +++++
 tests/unit/import-url.spec.ts                      |  21 ++
 tests/unit/job-notifications.spec.ts               | 131 +++++++++
 tests/unit/job-status.spec.ts                      | 220 ++++++++++++++
 tests/unit/jobs-store.spec.ts                      | 208 +++++++++++++
 tests/unit/preload-parity.spec.ts                  |   8 +-
 tests/unit/provider-models.spec.ts                 |  21 ++
 tests/unit/readiness-view.spec.ts                  |  29 ++
 tests/unit/system-notify.spec.ts                   | 133 +++++++++
 68 files changed, 4375 insertions(+), 463 deletions(-)
```
