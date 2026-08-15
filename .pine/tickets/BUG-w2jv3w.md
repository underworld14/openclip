---
id: BUG-w2jv3w
title: Retry on a failed import stacks a duplicate row instead of replacing the one being retried
status: done
priority: high
labels:
    - copy
parent: EPIC-k83ghw
phase: p1
created: "2026-08-15T11:48:59Z"
updated: "2026-08-15T12:30:11Z"
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

## Work Evidence

Closed by `pine close --evidence` on 2026-08-15.

- Base: `0ab7f99d` (last commit at or before ticket created 2026-08-15)
- Commits (1):
  - `6f7d338c` — fix(data-integrity): project-scope job writes, preserve clips on regenerate, close project-lifecycle gaps (BUG-93txd0, BUG-vv87d6, BUG-tdgtfb, BUG-5jwaxf, BUG-4c3gj3, FEAT-vz5vya, BUG-w2jv3w)
- Files changed (base → working tree):

```
 .pine/tickets/BUG-4c3gj3.md                        |  88 +++++++++-
 .pine/tickets/BUG-5jwaxf.md                        |  88 +++++++++-
 .pine/tickets/BUG-93txd0.md                        |  88 +++++++++-
 .pine/tickets/BUG-adfj3b.md                        |   4 +-
 .pine/tickets/BUG-fcg251.md                        |   4 +-
 .pine/tickets/BUG-gasxqq.md                        |   4 +-
 .pine/tickets/BUG-tdgtfb.md                        |  88 +++++++++-
 .pine/tickets/BUG-vv87d6.md                        |  88 +++++++++-
 .pine/tickets/BUG-w2jv3w.md                        |  45 +++++
 .pine/tickets/BUG-whdqsc.md                        |  12 ++
 .pine/tickets/BUG-y9km1j.md                        |  23 ++-
 .pine/tickets/FEAT-azvb5c.md                       |  23 ++-
 .pine/tickets/FEAT-vz5vya.md                       |  88 +++++++++-
 .pine/tickets/FEAT-x9femg.md                       |   4 +-
 README.md                                          |  45 ++++-
 package-lock.json                                  | 100 ++++++++++-
 package.json                                       |   1 +
 src/main/index.ts                                  | 120 ++++++++++++-
 src/main/ipc/media.ts                              |  15 +-
 src/main/ipc/video.ts                              |   8 +-
 src/main/menu.ts                                   |  24 ++-
 src/main/services/media-store.ts                   |  29 ++++
 src/main/services/sidecar-manager.ts               |  35 +++-
 src/main/services/updater.ts                       |  59 +++++++
 src/renderer/src/App.tsx                           |  36 +++-
 src/renderer/src/components/ErrorBoundary.tsx      |  86 ++++++++++
 src/renderer/src/components/ExportPanel.tsx        |  11 +-
 .../src/components/GeneratePreflightDialog.tsx     |  39 ++++-
 src/renderer/src/components/PreviewPlayer.tsx      |  61 +++++++
 src/renderer/src/hooks/import-controller.ts        | 185 ++++++++++++++++++++-
 src/renderer/src/hooks/useImportController.ts      |   9 +-
 src/renderer/src/hooks/useProject.ts               |  50 +++++-
 src/renderer/src/main.tsx                          |   5 +-
 src/renderer/src/stores/projectStore/clipsSlice.ts | 100 ++++++++---
 src/shared/channels.ts                             |   8 +
 tests/mocks/openclip.ts                            |   3 +
 tests/unit/ai-stores.spec.ts                       |  25 ++-
 tests/unit/app-menu.spec.ts                        |  23 +++
 tests/unit/clip-reject-undo.spec.tsx               |  29 ++++
 tests/unit/dialog-handlers.spec.ts                 |  10 +-
 tests/unit/error-boundary.spec.tsx                 |  64 +++++++
 tests/unit/export-cancel.spec.tsx                  |  26 +++
 tests/unit/generate-preflight-dialog.spec.tsx      |  37 ++++-
 tests/unit/import-controller.spec.ts               |  16 +-
 tests/unit/ipc-media.spec.ts                       |  25 ++-
 tests/unit/preload-parity.spec.ts                  |   2 +-
 tests/unit/sidecar-manager.spec.ts                 |  25 +++
 tests/unit/updater.spec.ts                         |  88 ++++++++++
 48 files changed, 1947 insertions(+), 99 deletions(-)
```
