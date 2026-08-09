---
id: EPIC-zpa1nd
title: 'EPIC: Job feedback — never leave the user without progress, cancel, or an error they can act on'
status: done
priority: critical
labels:
    - ux
    - jobs
created: "2026-08-08T15:31:22Z"
updated: "2026-08-08T15:31:22Z"
---

# Description

# Goals

# Outcome

All 5/5 children done. One spine ticket (FEAT-vh2bwz) was added during planning:
the other four all needed the same thing — one registry of running work and one
surface that renders it — so building it once was cheaper than four times.

The shape: `stores/jobsStore` tracks user-visible ACTIVITIES (an import is a
url-download job, two invokes and a transcribe job, but ONE row) at the
orchestrator level rather than inside the frozen `drainJob` seam;
`components/jobStatus` holds every decision as a pure, node-testable view-model;
`JobStatusBar` mounts between the title bar and the body so it belongs to neither
layout. `uiStore.tasks` and the never-called `useJob` hook are gone, exactly as
`useJob`'s own doc note asked.

## Verified

- 932 unit tests, 12 E2E (1 skipped: url-import needs live yt-dlp).
- `tests/e2e/job-status-bar.e2e.spec.ts` drives the built app and asserts the bar
  and a WORKING Cancel survive the Welcome→editor swap, and that a failure stays
  on screen with its message — the two regressions this epic is named for.
- `generate-clips-button.e2e` now exercises the new job end to end: click → job →
  real main process → registered runner → cards.

## NOT verified by machine — worth a human pass

- An actual macOS notification + dock badge appearing (the handler's suppression
  logic is unit-tested against a mocked Electron, but nothing asserts the OS
  really drew it).
- A real multi-minute transcription, to watch the autosave suspension on disk
  (expect ONE .ocproj write at the end, not one per debounce window).
- A real slow provider tripping the 120s `AI_REQUEST_TIMEOUT_MS`.
  `google/gemma-4-31b-it` on OpenRouter is the model that originally hung.
