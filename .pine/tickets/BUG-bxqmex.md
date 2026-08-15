---
id: BUG-bxqmex
title: Space is dead when the timeline has focus, and the global Space binding breaks keyboard activation of every button
status: done
priority: high
labels:
    - dead-control
parent: EPIC-k83ghw
phase: p1
created: "2026-08-15T11:28:11Z"
updated: "2026-08-15T12:43:19Z"
---

## Problem
Two handlers fight over the spacebar, and the global one breaks native button semantics.

## Evidence
- `src/renderer/src/components/Timeline.tsx:111-114` — the timeline's own keydown handler
  does `e.preventDefault(); setPlaying(!isPlaying)`.
- `src/renderer/src/hooks/useGlobalShortcuts.ts:62` — the document-level listener maps
  `' '` to `play-pause` and also toggles. `preventDefault()` does not stop propagation, so
  **both fire and cancel each other out**: Space does nothing once the timeline is focused
  (which is exactly what clicking the timeline to seek does).
- The same `e.preventDefault()` at `:74` runs whenever a shortcut matches and the target is
  not a text field — so Tab to any `<button>`, press Space, and the button is **not**
  activated (browsers activate buttons on Space keyup only if keydown's default stands);
  the video plays instead.

## Impact
The single most-used control in a video editor is dead where the user expects it. And the
app is not keyboard-operable: Space, the standard button activation key, silently does the
wrong thing everywhere (WCAG 2.1.1).

## Fix
Delete the Timeline's local Space case and let the global shortcut own playback; scope the
global Space binding so it does not preventDefault when the focused element is a
button/link/checkbox.

## Acceptance Criteria
- [ ] Space toggles playback with the timeline focused
- [ ] Space activates a focused button and does not start playback

## Work Evidence

Closed by `pine close --evidence` on 2026-08-15.

- Base: `216f85f1` (last commit at or before ticket created 2026-08-15)
- Commits (1):
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
 .pine/tickets/BUG-4c3gj3.md                        | 118 +++++++++++++
 .pine/tickets/BUG-5jwaxf.md                        | 118 +++++++++++++
 .pine/tickets/BUG-8kgcxs.md                        |  31 ++++
 .pine/tickets/BUG-93txd0.md                        | 126 ++++++++++++++
 .pine/tickets/BUG-9v667j.md                        |  35 ++++
 .pine/tickets/BUG-adfj3b.md                        | 119 +++++++++++++
 .pine/tickets/BUG-aryvgg.md                        |  38 +++++
 .pine/tickets/BUG-bxqmex.md                        |  41 +++++
 .pine/tickets/BUG-fcg251.md                        | 119 +++++++++++++
 .pine/tickets/BUG-gasxqq.md                        | 122 ++++++++++++++
 .pine/tickets/BUG-hfwbeb.md                        | 133 +++++++++++++++
 .pine/tickets/BUG-hkmsng.md                        |  34 ++++
 .pine/tickets/BUG-hqbett.md                        |  40 +++++
 .pine/tickets/BUG-phta04.md                        | 127 ++++++++++++++
 .pine/tickets/BUG-prkcq1.md                        |  33 ++++
 .pine/tickets/BUG-qcvhcn.md                        |  44 +++++
 .pine/tickets/BUG-sg6kqg.md                        |  35 ++++
 .pine/tickets/BUG-t19z5j.md                        |  39 +++++
 .pine/tickets/BUG-tdgtfb.md                        | 125 ++++++++++++++
 .pine/tickets/BUG-vv87d6.md                        | 120 +++++++++++++
 .pine/tickets/BUG-w2jv3w.md                        | 106 ++++++++++++
 .pine/tickets/BUG-whdqsc.md                        |  52 ++++++
 .pine/tickets/BUG-y9km1j.md                        |  60 +++++++
 .pine/tickets/EPIC-k83ghw.md                       |  66 ++++++++
 .pine/tickets/FEAT-azvb5c.md                       |  57 +++++++
 .pine/tickets/FEAT-rmgkee.md                       |  51 ++++++
 .pine/tickets/FEAT-vz5vya.md                       | 118 +++++++++++++
 .pine/tickets/FEAT-x9femg.md                       | 125 ++++++++++++++
 README.md                                          |  45 ++++-
 package-lock.json                                  | 100 ++++++++++-
 package.json                                       |   1 +
 src/main/index.ts                                  | 120 ++++++++++++-
 src/main/ipc/media.ts                              |  15 +-
 src/main/ipc/system.ts                             |  20 ++-
 src/main/ipc/video.ts                              |   8 +-
 src/main/menu.ts                                   |  24 ++-
 src/main/services/media-store.ts                   |  29 ++++
 src/main/services/sidecar-manager.ts               |  35 +++-
 src/main/services/updater.ts                       |  59 +++++++
 src/renderer/src/App.tsx                           |  79 ++++++++-
 src/renderer/src/components/ErrorBoundary.tsx      |  86 ++++++++++
 src/renderer/src/components/ExportPanel.tsx        |  11 +-
 .../src/components/GeneratePreflightDialog.tsx     |  39 ++++-
 src/renderer/src/components/PreviewPlayer.tsx      |  61 +++++++
 src/renderer/src/components/Timeline.tsx           |  65 +++++---
 src/renderer/src/components/timeline-math.ts       |  57 +++++++
 src/renderer/src/hooks/import-controller.ts        | 185 ++++++++++++++++++++-
 src/renderer/src/hooks/useGlobalShortcuts.ts       |   9 +-
 src/renderer/src/hooks/useImportController.ts      |   9 +-
 src/renderer/src/hooks/useProject.ts               |  50 +++++-
 src/renderer/src/main.tsx                          |   5 +-
 src/renderer/src/stores/projectStore/clipsSlice.ts | 100 ++++++++---
 src/shared/channels.ts                             |   8 +
 src/shared/shortcuts.ts                            |  32 ++++
 tests/mocks/openclip.ts                            |   3 +
 tests/unit/ai-stores.spec.ts                       |  25 ++-
 tests/unit/app-menu.spec.ts                        |  23 +++
 tests/unit/clip-reject-undo.spec.tsx               |  29 ++++
 tests/unit/dialog-handlers.spec.ts                 |  10 +-
 tests/unit/error-boundary.spec.tsx                 |  64 +++++++
 tests/unit/export-cancel.spec.tsx                  |  26 +++
 tests/unit/generate-preflight-dialog.spec.tsx      |  37 ++++-
 tests/unit/global-shortcuts.spec.tsx               |  44 +++++
 tests/unit/import-controller.spec.ts               |  16 +-
 tests/unit/ipc-media.spec.ts                       |  25 ++-
 tests/unit/onboarding-handlers.spec.ts             |  58 +++++--
 tests/unit/preload-parity.spec.ts                  |   2 +-
 tests/unit/reframe-visibility.spec.tsx             |  15 +-
 tests/unit/shortcuts.spec.ts                       |  25 +++
 tests/unit/sidecar-manager.spec.ts                 |  25 +++
 tests/unit/timeline-math.spec.ts                   |  80 +++++++++
 tests/unit/updater.spec.ts                         |  88 ++++++++++
 80 files changed, 4169 insertions(+), 124 deletions(-)
```
