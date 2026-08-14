---
id: FEAT-26tkya
title: No renderer test harness — the two review regressions were both untestable
status: done
priority: high
labels:
    - test
    - infra
parent: EPIC-4sa5jb
created: "2026-08-08T18:22:47Z"
updated: "2026-08-14T11:00:11Z"
---

## Problem

There is no way to unit-test a React component or hook in this repo. `vitest.config.ts:15` is `environment: 'node'` and there is no `jsdom` / `@testing-library` in `devDependencies`.

The consequence is not theoretical. The EPIC-xzzpty review found two defects that **no existing test could have caught**, both in renderer wiring:

- The import controller became a module singleton and silently bound `onNeedModel` to the wrong component's ref, so the whisper-model dialog stopped opening entirely. The unit specs pass because they inject `onNeedModel` straight into the framework-free core; every E2E called `runImportPipeline` instead of driving the UI.
- `settingsStore.load()` had zero callers, so the store served `DEFAULT_SETTINGS` all session. Every unit test passes because it seeds the store directly.

Both were caught by human/agent review, not by the suite.

## Current coverage shape

Well covered: pure view-models (`readinessView`, `settingsView`, `clipView`, `Dashboard.view`, `timeline-math`, `formatBytes`) and framework-free cores (`import-controller`, `export-run`, `batch-export`). That split is deliberate and good.

Not covered at all: `useImportController` (singleton wiring), `useReadiness`, `ReadinessBar`, `TranscriptionSettings`, `SettingsPanel`, `ImportPanel` (incl. the drop handler), `ClipCard`, `ClipSidebar`, `Welcome`, `App`.

## What to do

Add `jsdom` + `@testing-library/react` and a second vitest project (or `environment: 'jsdom'` via a per-file docblock) so hooks and components can be rendered. The pure-core split stays — this is for the *wiring*, which is where both regressions lived.

First tests to write, in value order:

1. `useImportController` — two components calling it share one controller, and a child's `onNeedModel` is honoured even though the parent constructs it. This is the exact C1 regression.
2. `useReadiness` — an unresolved probe renders `unknown`, a failed probe does not permanently gate, and `refresh()` re-probes.
3. `SettingsPanel` — the model auto-fill effect does not clobber in-progress typing (`modelDraft` persists on blur, so a slow `/models` response can currently overwrite a half-typed id).
4. `ImportPanel` — drop with a path, drop with a non-video, drop while busy.

## Notes

`tests/e2e/model-gate.e2e.spec.ts` now guards the C1 *symptom* end to end, which is the highest-value single test — but E2E is slow and can only cover a handful of paths. The harness is what makes the rest affordable.

## Work Evidence

Closed by `pine close --evidence` on 2026-08-14.

- Base: `eb1be422` (last commit at or before ticket created 2026-08-08)
- Commits (2):
  - `e807f107` — feat(test): renderer test harness, and the job-port race it found (FEAT-26tkya, BUG-zcqyb7)
  - `c297147d` — fix(ai): exclusion-only OpenAI filter, honest test-connection, chip tooltips
- Files changed (base → working tree):

```
 .github/workflows/ci.yml                           |  18 +
 .pine/memory/ci.md                                 |  18 +
 .pine/memory/renderer.md                           |   5 +-
 .pine/tickets/BUG-jt3d62.md                        |  70 ++
 .pine/tickets/BUG-zcqyb7.md                        | 135 ++++
 .pine/tickets/EPIC-zpa1nd.md                       |  35 +-
 .pine/tickets/FEAT-26tkya.md                       |  44 ++
 .pine/tickets/FEAT-8559h1.md                       | 213 +++++-
 .pine/tickets/FEAT-azqfsv.md                       |  33 +
 .pine/tickets/FEAT-c0zn3j.md                       | 229 ++++++-
 .pine/tickets/FEAT-ckxz8d.md                       | 214 +++++-
 .pine/tickets/FEAT-ky1jfw.md                       | 219 ++++++-
 .pine/tickets/FEAT-vh2bwz.md                       | 120 +++-
 package-lock.json                                  | 730 +++++++++++++++++++--
 package.json                                       |   4 +
 src/main/index.ts                                  |  10 +
 src/main/ipc/ai.ts                                 |  36 +-
 src/main/ipc/job-start-validation.ts               |  15 +-
 src/main/ipc/system.ts                             |  31 +
 src/main/services/ai-client.ts                     | 216 ++++--
 src/main/services/jobs/export-runner.ts            |  25 +-
 src/main/services/jobs/generate-clips-runner.ts    | 133 ++++
 src/main/services/provider-models.ts               |  41 +-
 src/main/services/reframe-detect.ts                |  22 +-
 src/main/services/sidecar-manager.ts               |   5 +
 src/renderer/src/App.tsx                           |  26 +-
 src/renderer/src/components/ClipSidebar.tsx        |  51 +-
 src/renderer/src/components/ExportPanel.tsx        | 120 +++-
 src/renderer/src/components/ImportPanel.tsx        |   6 +-
 src/renderer/src/components/JobStatusBar.tsx       | 256 ++++++++
 .../src/components/ModelDownloadDialog.tsx         |  31 +-
 src/renderer/src/components/ReadinessBar.tsx       |   6 +-
 src/renderer/src/components/SettingsPanel.tsx      |  12 +-
 src/renderer/src/components/export-run.ts          |  14 +-
 src/renderer/src/components/generate-clips-run.ts  |  54 ++
 src/renderer/src/components/import-pipeline.ts     |  42 +-
 src/renderer/src/components/jobStatus.ts           | 322 +++++++++
 src/renderer/src/hooks/import-controller.ts        | 160 +++--
 src/renderer/src/hooks/jobPort.ts                  |  25 +-
 src/renderer/src/hooks/useImportController.ts      |  37 +-
 src/renderer/src/hooks/useJob.ts                   | 150 +----
 src/renderer/src/main.tsx                          |   8 +
 src/renderer/src/stores/jobNotifications.ts        |  90 +++
 src/renderer/src/stores/jobsStore.ts               | 249 +++++++
 src/renderer/src/stores/projectStore/autosave.ts   |  61 +-
 src/renderer/src/stores/projectStore/clipsSlice.ts |  88 ++-
 .../src/stores/projectStore/exportSlice.ts         |   4 +-
 src/renderer/src/stores/uiStore.ts                 |  37 +-
 src/shared/channels.ts                             |  49 +-
 src/shared/jobs.ts                                 |  83 ++-
 tests/e2e/export.e2e.spec.ts                       |  17 +-
 tests/e2e/integration-wave1.e2e.spec.ts            |  31 +-
 tests/e2e/job-status-bar.e2e.spec.ts               | 127 ++++
 tests/e2e/timeline.e2e.spec.ts                     |  14 +-
 tests/e2e/vertical-slice.e2e.spec.ts               |  75 ++-
 tests/fixtures/contract/index.ts                   |  19 +-
 tests/harness/fixtures.ts                          |  47 ++
 tests/harness/renderer-env.ts                      |  59 ++
 tests/mocks/openclip.ts                            |  38 +-
 tests/unit/ai-mapreduce.spec.ts                    | 112 ++++
 tests/unit/ai-stores.spec.ts                       | 162 +++--
 tests/unit/ass-captions.serial.spec.ts             |  21 +-
 tests/unit/autosave-subscriber.spec.ts             |  73 +++
 tests/unit/export-runner.spec.ts                   |  67 +-
 tests/unit/ffmpeg-export.serial.spec.ts            |  21 +-
 tests/unit/ffmpeg-version.serial.spec.ts           |  35 +-
 tests/unit/generate-clips-runner.spec.ts           | 188 ++++++
 tests/unit/import-controller.spec.ts               |  72 ++
 tests/unit/import-panel-drop.spec.tsx              | 136 ++++
 tests/unit/import-url.spec.ts                      |  21 +
 tests/unit/job-notifications.spec.ts               | 131 ++++
 tests/unit/job-port-window-delivery.spec.tsx       |  81 +++
 tests/unit/job-status.spec.ts                      | 220 +++++++
 tests/unit/jobs-store.spec.ts                      | 208 ++++++
 tests/unit/preload-parity.spec.ts                  |   1 +
 tests/unit/provider-models.spec.ts                 |  21 +
 tests/unit/settings-panel-model-draft.spec.tsx     | 141 ++++
 tests/unit/smoke-strict.spec.ts                    |  25 +-
 tests/unit/system-notify.spec.ts                   | 133 ++++
 tests/unit/use-import-controller.spec.tsx          | 145 ++++
 tests/unit/use-readiness.spec.tsx                  | 117 ++++
 tsconfig.test.json                                 |   1 +
 vitest.config.ts                                   |  12 +-
 83 files changed, 6639 insertions(+), 534 deletions(-)
```
