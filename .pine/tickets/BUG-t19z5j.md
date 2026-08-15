---
id: BUG-t19z5j
title: The preview always centre-crops, so Fit (bars), Fit (blur) and Split screen show a picture the export will not produce
status: done
priority: high
labels:
    - wysiwyg
parent: EPIC-k83ghw
phase: p1
created: "2026-08-15T11:28:11Z"
updated: "2026-08-15T13:18:40Z"
---

## Problem
The preview renders one framing mode regardless of which is selected.

## Evidence
- `src/renderer/src/components/PreviewPlayer.tsx:267` — the crop transform is applied for
  every mode; there is no letterbox or blur-pad branch and no split-screen composition.
- Burned captions sit at ~4% from the bottom while the preview places them at 8%
  (caption layout vs `caption-css.ts`).
- `src/renderer/src/components/caption-css.ts:47` — preset thumbnails and the live preview
  render in the system font; the preset fonts exist only for libass at burn time, so all
  14 caption templates preview in San Francisco and differ only by colour.

## Impact
A user whose source is already vertical picks "Fit (bars)" precisely so nothing is cut
off — and the preview keeps showing heads cropped out of frame, so they cannot tell the
setting worked. The caption gallery exists specifically to let them see the difference
between templates, and it cannot show it.

## Fix
Implement letterbox / blur-pad / split-screen in the preview, align the caption baseline
with the ASS output, and embed the preset fonts (or a close web equivalent) for preview.

## Acceptance Criteria
- [x] Each framing mode previews as it exports
- [x] Caption vertical position matches between preview and burn
- [x] Caption template thumbnails render in their own typeface

## Resolution
- `preview-crop.ts`: new `coverFitTransform(source, region, tile)` — the same COVER-fit
  math the split-screen export uses, applied per-tile in the preview. 4 unit tests pin
  the geometry (centering, non-shrink guarantee, degenerate zero-area, aspect-matched
  no-overflow).
- `PreviewPlayer.tsx`: reworked to render a `primary` + `shadow` video layer pair,
  ALWAYS mounted (styles vary via `useMemo`, never structural branching) so React never
  remounts and drops `currentTime`/playback state. Four branches: fill (historical,
  byte-identical), letterbox (`object-fit: contain`), blur (COVER-scaled+blurred
  background composited behind a CONTAIN-scaled foreground), split (two
  `coverFitTransform`-positioned tiles via a live `ResizeObserver` on the frame).
- `caption-css.ts`: vertical margin now derived from the SAME `MarginV=80` /
  `PlayResY(aspect)` formula `ass-captions.ts` uses for the real burn, replacing a
  hardcoded 8%/6% that didn't match any aspect ratio.
- `assets/index.css`: 5 `@font-face` rules for the caption-template fonts (DejaVu Sans,
  Bebas Neue, Anton, Archivo Black, Poppins ExtraBold), bundled by Vite's CSS `url()`
  resolution from `build/fonts/` — so the gallery previews the same typeface libass
  burns, not a San Francisco fallback.

## Verification
- Letterbox and blur: visually confirmed against the real packaged app (Playwright
  driving `out/main/index.js`) with a real 1920×1080 source — screenshots show correct
  pillarboxing and blurred-background compositing respectively.
- Split-screen: the pure tile math is unit-verified (`preview-crop.spec.ts`, 4 tests,
  hand-computed expected values). The end-to-end wiring (ResizeObserver → tile
  size/position → two non-degenerate, non-overlapping `<video>` elements) is verified
  in `preview-fitmode.spec.tsx` by firing a real `ResizeObserver` callback through a
  mutable mock bridge. A live Playwright visual check was attempted but is not viable
  with this harness: Electron's `contextBridge` deep-freezes `window.openclip`, so
  reassigning `bridge.video.planReframe` from the probe script silently no-ops — the
  probe ends up exercising genuine YuNet face detection against a faceless test
  pattern, which legitimately reports "detect-failed". This is a probe-methodology
  limitation, not a gap in coverage; the mocked-bridge unit test is the correct tool for
  this path (same approach `reframe-visibility.spec.tsx` already uses).
- Caption vertical position: `caption-css.spec.ts` updated to the mathematically-derived
  percentages (was hardcoded 8%/6%), plus a new test proving the percentage tracks
  aspect ratio correctly.
- Font loading: visually confirmed via `document.fonts.check()` probe + screenshot of
  the caption gallery — 14 templates render in genuinely distinct typefaces.
- Full suite: `npm run typecheck` (all 4 projects), `npm run lint`, `npm test` — 1513
  passed / 10 skipped (real-binary `@serial` smokes, self-skip without local binaries),
  run twice for determinism, both clean.

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
 .pine/tickets/BUG-08sb0x.md                        |  36 +++
 .pine/tickets/BUG-12bxbk.md                        |  33 +++
 .pine/tickets/BUG-15cddx.md                        | 138 ++++++++++
 .pine/tickets/BUG-1m642d.md                        |  59 ++++
 .pine/tickets/BUG-44fgyv.md                        |  38 +++
 .pine/tickets/BUG-4c3gj3.md                        | 118 ++++++++
 .pine/tickets/BUG-5jwaxf.md                        | 118 ++++++++
 .pine/tickets/BUG-8kgcxs.md                        | 129 +++++++++
 .pine/tickets/BUG-93txd0.md                        | 126 +++++++++
 .pine/tickets/BUG-9v667j.md                        | 128 +++++++++
 .pine/tickets/BUG-adfj3b.md                        | 119 +++++++++
 .pine/tickets/BUG-aryvgg.md                        |  38 +++
 .pine/tickets/BUG-bxqmex.md                        | 134 ++++++++++
 .pine/tickets/BUG-fcg251.md                        | 119 +++++++++
 .pine/tickets/BUG-gasxqq.md                        | 122 +++++++++
 .pine/tickets/BUG-hfwbeb.md                        | 133 +++++++++
 .pine/tickets/BUG-hkmsng.md                        |  34 +++
 .pine/tickets/BUG-hqbett.md                        |  40 +++
 .pine/tickets/BUG-phta04.md                        | 127 +++++++++
 .pine/tickets/BUG-prkcq1.md                        |  33 +++
 .pine/tickets/BUG-qcvhcn.md                        |  44 +++
 .pine/tickets/BUG-sg6kqg.md                        |  35 +++
 .pine/tickets/BUG-t19z5j.md                        |  82 ++++++
 .pine/tickets/BUG-tdgtfb.md                        | 125 +++++++++
 .pine/tickets/BUG-vv87d6.md                        | 120 +++++++++
 .pine/tickets/BUG-w2jv3w.md                        | 106 ++++++++
 .pine/tickets/BUG-whdqsc.md                        |  52 ++++
 .pine/tickets/BUG-y9km1j.md                        |  60 +++++
 .pine/tickets/EPIC-k83ghw.md                       |  66 +++++
 .pine/tickets/FEAT-azvb5c.md                       |  57 ++++
 .pine/tickets/FEAT-rmgkee.md                       |  51 ++++
 .pine/tickets/FEAT-vz5vya.md                       | 118 ++++++++
 .pine/tickets/FEAT-x9femg.md                       | 125 +++++++++
 README.md                                          |  45 +++-
 package-lock.json                                  | 100 ++++++-
 package.json                                       |   1 +
 src/main/index.ts                                  | 120 ++++++++-
 src/main/ipc/media.ts                              |  15 +-
 src/main/ipc/system.ts                             |  20 +-
 src/main/ipc/video.ts                              |   8 +-
 src/main/menu.ts                                   |  24 +-
 src/main/services/media-store.ts                   |  29 ++
 src/main/services/sidecar-manager.ts               |  35 ++-
 src/main/services/updater.ts                       |  59 ++++
 src/renderer/src/App.tsx                           |  79 +++++-
 src/renderer/src/assets/index.css                  |  36 +++
 src/renderer/src/components/ErrorBoundary.tsx      |  86 ++++++
 src/renderer/src/components/ExportPanel.tsx        |  25 +-
 .../src/components/GeneratePreflightDialog.tsx     |  39 ++-
 src/renderer/src/components/PreviewPlayer.tsx      | 297 +++++++++++++++++++--
 src/renderer/src/components/Timeline.tsx           |  65 +++--
 src/renderer/src/components/batch-export.ts        |  37 ++-
 src/renderer/src/components/caption-css.ts         |  40 ++-
 src/renderer/src/components/preview-crop.ts        |  49 +++-
 src/renderer/src/components/timeline-math.ts       |  57 ++++
 src/renderer/src/hooks/import-controller.ts        | 185 ++++++++++++-
 src/renderer/src/hooks/useGlobalShortcuts.ts       |   9 +-
 src/renderer/src/hooks/useImportController.ts      |   9 +-
 src/renderer/src/hooks/useProject.ts               |  58 +++-
 src/renderer/src/main.tsx                          |   5 +-
 src/renderer/src/stores/projectStore/clipsSlice.ts | 100 +++++--
 .../src/stores/projectStore/previewSlice.ts        |   8 +
 src/shared/channels.ts                             |   8 +
 src/shared/schema.ts                               |  12 +-
 src/shared/shortcuts.ts                            |  32 +++
 tests/harness/renderer-env.ts                      |  25 ++
 tests/mocks/openclip.ts                            |   3 +
 tests/unit/ai-stores.spec.ts                       |  25 +-
 tests/unit/app-menu.spec.ts                        |  23 ++
 tests/unit/batch-export.spec.ts                    |  62 +++++
 tests/unit/caption-css.spec.ts                     |  16 +-
 tests/unit/clip-reject-undo.spec.tsx               |  29 ++
 tests/unit/dialog-handlers.spec.ts                 |  10 +-
 tests/unit/error-boundary.spec.tsx                 |  64 +++++
 tests/unit/export-cancel.spec.tsx                  |  26 ++
 tests/unit/generate-preflight-dialog.spec.tsx      |  37 ++-
 tests/unit/global-shortcuts.spec.tsx               |  44 +++
 tests/unit/import-controller.spec.ts               |  16 +-
 tests/unit/ipc-media.spec.ts                       |  25 +-
 tests/unit/onboarding-handlers.spec.ts             |  58 +++-
 tests/unit/preload-parity.spec.ts                  |   2 +-
 tests/unit/preview-crop.spec.ts                    |  72 ++++-
 tests/unit/reframe-visibility.spec.tsx             |  15 +-
 tests/unit/shortcuts.spec.ts                       |  25 ++
 tests/unit/sidecar-manager.spec.ts                 |  25 ++
 tests/unit/timeline-math.spec.ts                   |  80 ++++++
 tests/unit/updater.spec.ts                         |  88 ++++++
 tests/unit/use-project.spec.ts                     |  50 +++-
 91 files changed, 5218 insertions(+), 165 deletions(-)
```
