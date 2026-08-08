---
id: BUG-19bt2k
title: '''Auto Generate Clips'' can no-op silently; its P0 regression guard is red'
status: todo
priority: high
labels:
    - bug
    - ux
    - test
parent: EPIC-4sa5jb
created: "2026-08-08T15:32:35Z"
updated: "2026-08-08T15:32:35Z"
---

## Problem

Two defects, one symptom. `tests/e2e/generate-clips-button.e2e.spec.ts` — the regression guard added for the P0 "Auto Generate Clips button has no onClick" bug — **fails today**:

```
Error: expect(locator).toBeVisible() failed
Locator: getByTestId('clip-card').first()
Timeout: 15000ms
Error: element(s) not found
```

### Root cause (reproduced against the real app)

I drove the built app under Playwright and dumped the store around the click:

```
imported segments: 2
BEFORE click: { hasCurrentProject: false, composeProjectNull: true,
                transcriptSegs: 2, clips: 0, generating: false, generateError: null }
AFTER  click: { clips: 0, generating: false, generateError: null }
SIDEBAR TEXT: "CLIPS\n\nNo clips yet — run “Auto Generate Clips”."
```

The button's **enabled state and the handler's precondition disagree**:

- `src/renderer/src/App.tsx:153` enables the button on `!hasTranscript || generating` — i.e. a transcript is enough.
- `src/renderer/src/components/generateClips.ts` → `createGenerateClipsHandler` does `const project = deps.getProject(); if (!project) return` — and `getProject` is `composeProject()`, which returns `null` when there is no `currentProject` (`src/renderer/src/stores/projectStore/exportSlice.ts:162-166`).

So the click is a **silent no-op**: no error, no toast, no spinner, no state change. The UI's own empty state keeps telling the user to press the button they just pressed.

## Two separate things to fix

1. **The silent no-op is a real UX defect regardless of the test.** Any handler precondition that can fail must surface something. Either the button is disabled when it cannot run (gate on the same condition the handler requires), or the no-op path sets `generateError` so the sidebar explains itself. A dead-end click with zero feedback is the same class of bug as the original P0.
2. **The regression guard is currently worthless.** It fails for a setup reason (the harness's `runImportPipeline` never sets `currentProject`), so it no longer proves what it was written to prove. Fix the spec's setup so it exercises the real path, and keep it red-if-unwired.

## Reachability caveat — read before prioritising

In the normal app a real import sets `currentProject`, so `hasSource` and `currentProject` move together; I have **not** demonstrated a user-facing path that reaches the enabled-but-null state. Treat the silent no-op as a robustness/consistency fix (P2), and the broken regression guard as the P1 part — it is the guard for a bug that already shipped once.

## Acceptance criteria

- [ ] `npx playwright test tests/e2e/generate-clips-button.e2e.spec.ts` passes and still fails if the `onClick` is removed.
- [ ] The handler cannot no-op silently: either the button is disabled, or an actionable error renders in the clip rail.
- [ ] A unit test covers "handler invoked with no composable project" → user-visible error state.
