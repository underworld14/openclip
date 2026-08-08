---
id: FEAT-26tkya
title: No renderer test harness — the two review regressions were both untestable
status: todo
priority: high
labels:
    - test
    - infra
parent: EPIC-4sa5jb
created: "2026-08-08T18:22:47Z"
updated: "2026-08-08T18:22:47Z"
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
