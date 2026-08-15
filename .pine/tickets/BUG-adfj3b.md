---
id: BUG-adfj3b
title: Quitting or closing the window during a job kills it instantly with no confirmation
status: todo
priority: high
labels:
    - data-loss
parent: EPIC-k83ghw
phase: p0
created: "2026-08-15T11:28:11Z"
updated: "2026-08-15T11:28:11Z"
---

## Problem
`before-quit` protects the autosave but not the work.

## Evidence
- `src/main/index.ts:295-310` — `wireQuitAutosaveFlush` holds the quit only to flush the
  debounced save, then calls `app.quit()`. There is no check for running jobs.
- `grep -n "showMessageBox" src/main/index.ts` → **zero hits**; no confirm dialog exists.
- `SidecarManager` then SIGTERMs every child on quit.

## Impact
Cmd+Q out of habit, or clicking the red close button (which on macOS normally means "put
it away"), destroys a 15-minute transcription or a 10-clip batch export with no dialog,
no warning and no trace.

## Fix
On `before-quit` / `close`, if `activeTasks()` is non-empty, show a confirm naming what is
running ("An export of 10 clips is still running. Quit anyway?").

## Acceptance Criteria
- [ ] Quitting with a running job asks first
- [ ] Closing the window with a running job asks first
- [ ] Quitting with no running job is unchanged
