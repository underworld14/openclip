---
id: BUG-qcvhcn
title: 'Accessibility: unreadable focus ring, no reduced-motion, unannounced progress, unselectable transcript'
status: done
priority: medium
labels:
    - a11y
parent: EPIC-k83ghw
phase: p2
created: "2026-08-15T11:28:11Z"
updated: "2026-08-15T16:24:20Z"
---

## Problem
A cluster of confirmed accessibility defects, each cheap to fix.

## Evidence
- Focus ring is a translucent grey at **~1.9:1** against the dark ground — below the 3:1
  minimum for a focus indicator.
- `prefers-reduced-motion` is never honoured: per-word caption animations, auto-playing
  hover videos, spinners and dialog zooms all run regardless.
- The job status bar — the app's only progress surface — has no live region, its progress
  bars are unnamed, and it is hidden from assistive tech.
- Every transcript sentence is a `<button>`: thousands of tab stops with no bypass, and the
  transcript text cannot be selected or copied.
- The preview scrub bar is a 4px-tall hairline; several controls are under the 24px minimum
  target size.
- Bare-letter shortcuts (a / x / i / o) are not suppressed while a modal is open, so a stray
  keystroke hides a clip or rewrites its trim.
- The light/dark toggle resets to dark on every launch — the choice is never saved.

## Fix
Raise the focus-ring contrast, add a `prefers-reduced-motion` block, give the status bar
`role="status"` + named progress bars, make transcript lines selectable (click-to-seek via
a wrapper, not a button per sentence), enlarge the scrub bar and small targets, gate
bare-letter shortcuts on no-open-modal, persist the theme.

## Acceptance Criteria
- [x] Focus indicator meets 3:1
- [x] Reduced-motion is respected
- [x] Job progress is announced
- [x] Transcript text is selectable
- [x] Shortcuts do not fire while a dialog is open
- [x] Theme choice survives a restart

## Resolution

All 6 ACs closed (commit `0248146`):

- `--ring` token (assets/index.css, both themes) darkened/lightened so the
  blended `ring-ring/50` render clears 3:1 — verified by hand-deriving OKLCH→
  sRGB→relative-luminance→WCAG contrast (dark: ~3.76:1, light: ~3.43:1;
  measured the CURRENT broken value first and got ~1.9:1 against the dark
  ground, matching the ticket's own evidence number, before fixing it).
- Global `@media (prefers-reduced-motion: reduce)` block (assets/index.css)
  plus a JS-level `usePrefersReducedMotion()` check for ClipCard's
  autoPlay/loop hover `<video>` (CSS alone cannot stop that).
- `JobStatusBar`: `role="status" aria-live="polite" aria-atomic` on the
  container; `aria-label={view.title}` on the `<Progress>` (Radix already
  supplies `role="progressbar"` + `aria-valuenow/max`).
- `TranscriptPanel`: each row is now `role="button" tabIndex={0}` with an
  explicit Enter/Space handler, not a native `<button>` — the UA stylesheet
  suppression of text selection on `<button>` is gone, keyboard parity is not.
- `useGlobalShortcuts` already had an (untested, unused) `enabled` param;
  App.tsx now derives `anyModalOpen` from every dialog it can open (Import/
  Export/Settings, the model-download dialog, the shortcut sheet, the
  generate-preflight dialog) and passes `!anyModalOpen`.
- Theme choice persists to `localStorage` (`theme.ts`) — a renderer-local UI
  preference, deliberately not added to the frozen `Settings` document.

Also widened the preview scrub bar 4px→8px (real improvement, not a full
custom-track redesign).

**Deliberately deferred** (present in Evidence, not in the checked AC list —
noted here rather than silently dropped):
- "Thousands of tab stops with no bypass": fixing the `<button>`→`role=button`
  selection issue does not by itself reduce the per-segment tab-stop count. A
  real fix needs a roving-tabindex / arrow-key-navigation redesign of the
  transcript list — a bigger, separate change.
- "Several controls under the 24px minimum target size": only the scrub bar
  was touched (4px→8px, still short of a guaranteed 24px pointer target,
  which needs custom `::-webkit-slider-thumb`/`::-moz-range-thumb` styling).
  No inventory was taken of every other undersized control.

## Work Evidence

Closed by `pine close --evidence` on 2026-08-15.

- Base: `216f85f1` (last commit at or before ticket created 2026-08-15)
- Commits (2):
  - `02481468` — fix(a11y): focus ring contrast, reduced-motion, live progress, selectable transcript, shortcut gating, persisted theme
  - `0ab7f99d` — chore(pine): file the production-readiness & UX audit (EPIC-k83ghw)
- Files changed (base → working tree):

```
 .pine/MEMORY.md                                    |   2 +
 .pine/memory/renderer.md                           |   4 +-
 .pine/memory/testing.md                            |   3 +-
 .pine/tickets/BUG-08sb0x.md                        | 194 +++++++++++++
 .pine/tickets/BUG-12bxbk.md                        | 191 +++++++++++++
 .pine/tickets/BUG-15cddx.md                        | 138 ++++++++++
 .pine/tickets/BUG-1m642d.md                        |  59 ++++
 .pine/tickets/BUG-44fgyv.md                        |  38 +++
 .pine/tickets/BUG-4c3gj3.md                        | 118 ++++++++
 .pine/tickets/BUG-4tscfq.md                        | 183 ++++++++++++-
 .pine/tickets/BUG-5jwaxf.md                        | 118 ++++++++
 .pine/tickets/BUG-8kgcxs.md                        | 129 +++++++++
 .pine/tickets/BUG-93txd0.md                        | 126 +++++++++
 .pine/tickets/BUG-9v667j.md                        | 128 +++++++++
 .pine/tickets/BUG-adfj3b.md                        | 119 ++++++++
 .pine/tickets/BUG-aryvgg.md                        | 214 +++++++++++++++
 .pine/tickets/BUG-bxqmex.md                        | 134 +++++++++
 .pine/tickets/BUG-fcg251.md                        | 119 ++++++++
 .pine/tickets/BUG-gasxqq.md                        | 122 +++++++++
 .pine/tickets/BUG-hfwbeb.md                        | 133 +++++++++
 .pine/tickets/BUG-hkmsng.md                        | 209 ++++++++++++++
 .pine/tickets/BUG-hqbett.md                        | 199 ++++++++++++++
 .pine/tickets/BUG-phta04.md                        | 127 +++++++++
 .pine/tickets/BUG-prkcq1.md                        | 191 +++++++++++++
 .pine/tickets/BUG-qcvhcn.md                        |  83 ++++++
 .pine/tickets/BUG-sg6kqg.md                        | 203 ++++++++++++++
 .pine/tickets/BUG-t19z5j.md                        | 186 +++++++++++++
 .pine/tickets/BUG-tdgtfb.md                        | 125 +++++++++
 .pine/tickets/BUG-v4phgj.md                        | 183 ++++++++++++-
 .pine/tickets/BUG-vh7vwp.md                        | 183 ++++++++++++-
 .pine/tickets/BUG-vv87d6.md                        | 120 ++++++++
 .pine/tickets/BUG-w2jv3w.md                        | 106 +++++++
 .pine/tickets/BUG-whdqsc.md                        | 231 ++++++++++++++++
 .pine/tickets/BUG-y9km1j.md                        |  73 +++++
 .pine/tickets/EPIC-k83ghw.md                       |  66 +++++
 .pine/tickets/FEAT-azvb5c.md                       | 226 +++++++++++++++
 .pine/tickets/FEAT-rmgkee.md                       | 234 ++++++++++++++++
 .pine/tickets/FEAT-vz5vya.md                       | 118 ++++++++
 .pine/tickets/FEAT-x9femg.md                       | 125 +++++++++
 README.md                                          |  74 +++--
 electron-builder.yml                               |  35 ++-
 package-lock.json                                  | 100 ++++++-
 package.json                                       |   1 +
 src/main/index.ts                                  | 120 +++++++-
 src/main/ipc/ai.ts                                 |  24 +-
 src/main/ipc/audio.ts                              |  50 ++--
 src/main/ipc/job-start-validation.ts               |  13 +-
 src/main/ipc/media.ts                              |  15 +-
 src/main/ipc/project.ts                            |  32 ++-
 src/main/ipc/settings.ts                           |  17 +-
 src/main/ipc/system.ts                             |  20 +-
 src/main/ipc/video.ts                              |  15 +-
 src/main/menu.ts                                   |  30 +-
 src/main/services/ai-client.ts                     | 193 ++++++++++++-
 src/main/services/ai-emoji.ts                      |  10 +-
 src/main/services/ass-captions.ts                  |  13 +-
 src/main/services/ffmpeg-extract.ts                |   6 +
 src/main/services/jobs/extract-audio-runner.ts     | 100 +++++++
 src/main/services/jobs/generate-clips-runner.ts    |  84 ++++--
 src/main/services/jobs/transcribe-runner.ts        |  16 +-
 src/main/services/media-store.ts                   |  29 ++
 src/main/services/project-store.ts                 |  16 +-
 src/main/services/sidecar-errors.ts                | 172 ++++++++++++
 src/main/services/sidecar-manager.ts               |  54 +++-
 src/main/services/updater.ts                       |  59 ++++
 src/main/utils/ffprobe.ts                          |  26 +-
 src/main/utils/paths.ts                            |  50 +++-
 src/preload/api/audio.ts                           |  12 -
 src/preload/index.ts                               |   4 -
 src/renderer/src/App.tsx                           | 253 ++++++++++++-----
 src/renderer/src/assets/index.css                  |  79 +++++-
 src/renderer/src/components/ClipCard.tsx           |  12 +-
 src/renderer/src/components/Dashboard.tsx          |  12 +-
 src/renderer/src/components/ErrorBoundary.tsx      |  86 ++++++
 src/renderer/src/components/ExportPanel.tsx        |  30 +-
 .../src/components/GeneratePreflightDialog.tsx     |  39 ++-
 src/renderer/src/components/ImportPanel.tsx        |  28 +-
 src/renderer/src/components/JobStatusBar.tsx       |  14 +
 src/renderer/src/components/PreviewPlayer.tsx      | 303 +++++++++++++++++++--
 src/renderer/src/components/SettingsPanel.tsx      | 128 ++++++---
 src/renderer/src/components/Timeline.tsx           |  65 +++--
 src/renderer/src/components/TranscriptPanel.tsx    |  27 +-
 src/renderer/src/components/batch-export.ts        |  42 ++-
 src/renderer/src/components/caption-css.ts         |  40 ++-
 src/renderer/src/components/import-pipeline.ts     |  90 +++++-
 src/renderer/src/components/jobStatus.ts           |  15 +
 src/renderer/src/components/model-download.ts      |   5 +-
 src/renderer/src/components/preview-crop.ts        |  49 +++-
 src/renderer/src/components/readinessView.ts       |   2 +-
 src/renderer/src/components/theme.ts               |  38 +++
 src/renderer/src/components/timeline-math.ts       |  57 ++++
 src/renderer/src/hooks/import-controller.ts        | 219 ++++++++++++++-
 src/renderer/src/hooks/useGlobalShortcuts.ts       |   9 +-
 src/renderer/src/hooks/useImportController.ts      |   9 +-
 src/renderer/src/hooks/usePrefersReducedMotion.ts  |  29 ++
 src/renderer/src/hooks/useProject.ts               | 115 +++++++-
 src/renderer/src/main.tsx                          |   5 +-
 src/renderer/src/stores/jobsStore.ts               |  11 +-
 src/renderer/src/stores/projectStore/clipsSlice.ts | 121 ++++++--
 .../src/stores/projectStore/previewSlice.ts        |   8 +
 src/shared/ai-providers.ts                         |  39 +++
 src/shared/channels.ts                             |  17 +-
 src/shared/jobs.ts                                 |  26 ++
 src/shared/schema.ts                               |  12 +-
 src/shared/shortcuts.ts                            |  32 +++
 tests/e2e/vertical-slice.e2e.spec.ts               |  78 +++++-
 tests/harness/renderer-env.ts                      |  54 ++++
 tests/mocks/openclip.ts                            |  12 +-
 tests/unit/ai-mapreduce.spec.ts                    |  75 +++++
 tests/unit/ai-providers-meta.spec.ts               |  49 ++++
 tests/unit/ai-providers.spec.ts                    | 111 ++++++++
 tests/unit/ai-stores.spec.ts                       |  93 ++++++-
 tests/unit/app-menu.spec.ts                        |  23 ++
 tests/unit/ass-captions.spec.ts                    |  16 ++
 tests/unit/batch-export.spec.ts                    |  62 +++++
 tests/unit/caption-css.spec.ts                     |  16 +-
 tests/unit/clip-card-preview.spec.tsx              |  22 ++
 tests/unit/clip-reject-undo.spec.tsx               |  29 ++
 tests/unit/dialog-handlers.spec.ts                 |  10 +-
 tests/unit/error-boundary.spec.tsx                 |  64 +++++
 tests/unit/export-cancel.spec.tsx                  |  26 ++
 tests/unit/extract-audio-runner.spec.ts            | 100 +++++++
 tests/unit/ffprobe.spec.ts                         |  24 +-
 tests/unit/generate-clips-runner.spec.ts           | 117 ++++++++
 tests/unit/generate-preflight-dialog.spec.tsx      |  37 ++-
 tests/unit/global-shortcuts.spec.tsx               |  76 ++++++
 tests/unit/import-controller.spec.ts               |  16 +-
 tests/unit/import-pipeline.spec.ts                 |  93 ++++++-
 tests/unit/import-url.spec.ts                      |  35 ++-
 tests/unit/ipc-media.spec.ts                       |  25 +-
 tests/unit/ipc-project.spec.ts                     |  51 +++-
 tests/unit/job-start-validation.spec.ts            |  55 ++++
 tests/unit/job-status-bar-a11y.spec.tsx            |  56 ++++
 tests/unit/job-status.spec.ts                      |  24 ++
 tests/unit/onboarding-handlers.spec.ts             |  58 +++-
 tests/unit/paths-prod.spec.ts                      |  35 +++
 tests/unit/preload-parity.spec.ts                  |   6 +-
 tests/unit/preview-crop.spec.ts                    |  72 ++++-
 tests/unit/preview-fitmode.spec.tsx                | 201 ++++++++++++++
 tests/unit/project-management.spec.tsx             |  11 +
 tests/unit/project-store.spec.ts                   |  34 +++
 tests/unit/reframe-visibility.spec.tsx             |  15 +-
 tests/unit/settings-panel-copy.spec.tsx            | 130 +++++++++
 tests/unit/settings-tabs.spec.tsx                  |   4 +-
 tests/unit/shortcuts.spec.ts                       |  25 ++
 tests/unit/sidecar-errors.spec.ts                  | 142 ++++++++++
 tests/unit/sidecar-manager.spec.ts                 |  63 +++++
 tests/unit/theme.spec.ts                           |  66 +++++
 tests/unit/timeline-math.spec.ts                   |  80 ++++++
 tests/unit/transcript-seek.spec.tsx                |  32 ++-
 tests/unit/trunk-infra.spec.ts                     |  30 ++
 tests/unit/updater.spec.ts                         |  88 ++++++
 tests/unit/use-project.spec.ts                     | 134 ++++++++-
 153 files changed, 10888 insertions(+), 503 deletions(-)
```
