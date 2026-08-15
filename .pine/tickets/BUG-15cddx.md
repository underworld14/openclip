---
id: BUG-15cddx
title: Batch export discards the caption style and the framing the user chose — output does not match the preview
status: done
priority: high
labels:
    - wysiwyg
parent: EPIC-k83ghw
phase: p1
created: "2026-08-15T11:28:11Z"
updated: "2026-08-15T12:53:04Z"
---

## Problem
Single export honours the user's choices; batch export silently substitutes the preset's.

## Evidence
- **Single** — `src/renderer/src/components/ExportPanel.tsx:167,175` passes
  `captionStyle: resolveEffectiveCaptionStyle(captionTemplateId, …)` where
  `captionTemplateId` comes from `currentProject.settings` (`:108`), plus
  `settings: project.settings` (carrying `fitMode`) and `reframe`.
- **Batch** — `src/renderer/src/components/batch-export.ts:116` resolves the style from
  **`opts.preset.captionTemplateId`** instead, and `:148` builds params with
  `settings: { aspectRatio: opts.preset.aspectRatio }` only — **no `fitMode`, no
  `reframe`, no manual crop**.
- `platformPresets.ts:24,31,38,45` — TikTok forces `tiktok-bounce`, everything else
  forces `default`.

## Impact
The user picks "Hormozi" captions in the gallery next to the preview and "Follow speaker"
framing, watches the preview track the speaker, clicks "Export all approved" — and every
file comes out in a different caption style with a plain centre crop.

## Fix
Have `runBatchExport` build params from the same project settings the single-clip path
uses; let the platform preset supply aspect ratio and quality only.

## Acceptance Criteria
- [ ] A batch-exported clip is byte-comparable in style/framing to the same clip exported singly
- [ ] The caption style chosen in CaptionStylePanel is the one burned in a batch

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
 .pine/tickets/BUG-9v667j.md                        | 128 ++++++++++++++
 .pine/tickets/BUG-adfj3b.md                        | 119 +++++++++++++
 .pine/tickets/BUG-aryvgg.md                        |  38 +++++
 .pine/tickets/BUG-bxqmex.md                        | 134 +++++++++++++++
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
 src/renderer/src/components/ExportPanel.tsx        |  25 ++-
 .../src/components/GeneratePreflightDialog.tsx     |  39 ++++-
 src/renderer/src/components/PreviewPlayer.tsx      |  61 +++++++
 src/renderer/src/components/Timeline.tsx           |  65 +++++---
 src/renderer/src/components/batch-export.ts        |  37 ++++-
 src/renderer/src/components/timeline-math.ts       |  57 +++++++
 src/renderer/src/hooks/import-controller.ts        | 185 ++++++++++++++++++++-
 src/renderer/src/hooks/useGlobalShortcuts.ts       |   9 +-
 src/renderer/src/hooks/useImportController.ts      |   9 +-
 src/renderer/src/hooks/useProject.ts               |  58 ++++++-
 src/renderer/src/main.tsx                          |   5 +-
 src/renderer/src/stores/projectStore/clipsSlice.ts | 100 ++++++++---
 .../src/stores/projectStore/previewSlice.ts        |   8 +
 src/shared/channels.ts                             |   8 +
 src/shared/schema.ts                               |  12 +-
 src/shared/shortcuts.ts                            |  32 ++++
 tests/mocks/openclip.ts                            |   3 +
 tests/unit/ai-stores.spec.ts                       |  25 ++-
 tests/unit/app-menu.spec.ts                        |  23 +++
 tests/unit/batch-export.spec.ts                    |  62 +++++++
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
 tests/unit/use-project.spec.ts                     |  50 +++++-
 85 files changed, 4537 insertions(+), 133 deletions(-)
```
