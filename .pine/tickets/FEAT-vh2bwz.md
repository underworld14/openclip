---
id: FEAT-vh2bwz
title: Job registry + persistent status bar (spine for EPIC-zpa1nd)
status: testing
priority: critical
labels:
    - ux
    - jobs
parent: EPIC-zpa1nd
created: "2026-08-08T18:19:42Z"
updated: "2026-08-08T18:19:58Z"
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
