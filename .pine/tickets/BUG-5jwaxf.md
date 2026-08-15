---
id: BUG-5jwaxf
title: A new project exists only in memory until the import settles — a quit or crash mid-transcription loses everything
status: done
priority: high
labels:
    - data-loss
parent: EPIC-k83ghw
phase: p0
created: "2026-08-15T11:28:11Z"
updated: "2026-08-15T12:30:11Z"
---

## Problem
The most-likely moment to quit is the long one, and it is exactly the unprotected window.

## Evidence
- `src/renderer/src/stores/projectStore/autosave.ts:157,248` — the project is first written
  when the import settles, not when it is created.
- A URL-imported video already downloaded into `userData/media/<projectId>/` is then
  reclaimed by the launch-time orphan sweeper, because no `.ocproj` references it.

## Impact
Paste a YouTube link, wait ten minutes for the download plus transcription, then quit
(or the Mac restarts, or the app crashes): the project is absent from Recent Projects and
the downloaded video is deleted on next launch. Nothing survives.

## Fix
Persist the project document as soon as ffprobe returns and the project is committed —
the same moment `hasSource` flips and the editor appears.

## Acceptance Criteria
- [ ] A project appears in Recent Projects before transcription starts
- [ ] Killing the app mid-transcription leaves a loadable project and its media intact

## Work Evidence

Closed by `pine close --evidence` on 2026-08-15.

- Base: `216f85f1` (last commit at or before ticket created 2026-08-15)
- Commits (2):
  - `6f7d338c` — fix(data-integrity): project-scope job writes, preserve clips on regenerate, close project-lifecycle gaps (BUG-93txd0, BUG-vv87d6, BUG-tdgtfb, BUG-5jwaxf, BUG-4c3gj3, FEAT-vz5vya, BUG-w2jv3w)
  - `0ab7f99d` — chore(pine): file the production-readiness & UX audit (EPIC-k83ghw)
- Files changed (base → working tree):

```
 .pine/MEMORY.md                                    |   2 +
 .pine/memory/renderer.md                           |   3 +-
 .pine/memory/testing.md                            |   3 +-
 .pine/tickets/BUG-08sb0x.md                        |  36 ++++
 .pine/tickets/BUG-12bxbk.md                        |  33 ++++
 .pine/tickets/BUG-15cddx.md                        |  40 +++++
 .pine/tickets/BUG-1m642d.md                        |  59 +++++++
 .pine/tickets/BUG-44fgyv.md                        |  38 +++++
 .pine/tickets/BUG-4c3gj3.md                        |  34 ++++
 .pine/tickets/BUG-5jwaxf.md                        |  34 ++++
 .pine/tickets/BUG-8kgcxs.md                        |  31 ++++
 .pine/tickets/BUG-93txd0.md                        | 126 ++++++++++++++
 .pine/tickets/BUG-9v667j.md                        |  35 ++++
 .pine/tickets/BUG-adfj3b.md                        |  35 ++++
 .pine/tickets/BUG-aryvgg.md                        |  38 +++++
 .pine/tickets/BUG-bxqmex.md                        |  41 +++++
 .pine/tickets/BUG-fcg251.md                        |  35 ++++
 .pine/tickets/BUG-gasxqq.md                        |  38 +++++
 .pine/tickets/BUG-hfwbeb.md                        |  40 +++++
 .pine/tickets/BUG-hkmsng.md                        |  34 ++++
 .pine/tickets/BUG-hqbett.md                        |  40 +++++
 .pine/tickets/BUG-phta04.md                        |  34 ++++
 .pine/tickets/BUG-prkcq1.md                        |  33 ++++
 .pine/tickets/BUG-qcvhcn.md                        |  44 +++++
 .pine/tickets/BUG-sg6kqg.md                        |  35 ++++
 .pine/tickets/BUG-t19z5j.md                        |  39 +++++
 .pine/tickets/BUG-tdgtfb.md                        | 125 ++++++++++++++
 .pine/tickets/BUG-vv87d6.md                        | 120 +++++++++++++
 .pine/tickets/BUG-w2jv3w.md                        |  45 +++++
 .pine/tickets/BUG-whdqsc.md                        |  52 ++++++
 .pine/tickets/BUG-y9km1j.md                        |  60 +++++++
 .pine/tickets/EPIC-k83ghw.md                       |  66 ++++++++
 .pine/tickets/FEAT-azvb5c.md                       |  57 +++++++
 .pine/tickets/FEAT-rmgkee.md                       |  51 ++++++
 .pine/tickets/FEAT-vz5vya.md                       |  34 ++++
 .pine/tickets/FEAT-x9femg.md                       |  41 +++++
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
 70 files changed, 2933 insertions(+), 77 deletions(-)
```
