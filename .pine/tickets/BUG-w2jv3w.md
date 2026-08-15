---
id: BUG-w2jv3w
title: Retry on a failed import stacks a duplicate row instead of replacing the one being retried
status: doing
priority: high
labels:
    - copy
parent: EPIC-k83ghw
phase: p1
created: "2026-08-15T11:48:59Z"
updated: "2026-08-15T11:49:22Z"
---

## Problem
Clicking "Retry" on a failed import job never removes the row it is retrying —
every call to `importUrl`/`importFile` mints a fresh `taskId` via `genId()` and
`beginTask()`s it, regardless of whether it was invoked directly or via
`retry: () => importUrl(u)`.

## Evidence
- `src/renderer/src/hooks/import-controller.ts:427-451` (importUrl) and the
  mirror `importFile` path: `const taskId = genId()` then
  `deps.ui?.beginTask?.({ id: taskId, ..., retry: () => importUrl(u) })` — a
  brand new id every call, old task never dismissed.
- Reproduced against the real yt-dlp: paste a URL that 403s (YouTube blocking
  without cookies/PO token — increasingly common), the status bar shows
  "Importing <url> failed / url-download failed [SIDECAR_CRASH]: unable to
  download video data: HTTP Error 403: Forbidden" with an expandable "1 more"
  — press Retry, it 403s again, and now there are TWO identical failed rows
  stacked (JobStatusBar's primary + expanded list), confirmed via a live
  screenshot from the user.

## Impact
Every retry (of any import, any failure reason) accumulates another
identical dead row in the status bar instead of replacing the one being
retried. On a flaky network a user could stack a dozen identical error rows.

## Fix
`retry` should reuse the original `taskId` (or dismiss it before starting the
new one) so a retried import replaces its own row instead of appending a new
one.

## Acceptance Criteria
- [ ] Retrying a failed import replaces its own status-bar row, not a new one
- [ ] A regression test covers two consecutive failures via Retry
