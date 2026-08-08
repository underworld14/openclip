---
id: BUG-19bt2k
title: '''Auto Generate Clips'' can no-op silently; its P0 regression guard is red'
status: done
priority: high
labels:
    - bug
    - ux
    - test
parent: EPIC-4sa5jb
created: "2026-08-08T15:32:35Z"
updated: "2026-08-08T16:35:08Z"
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

## Work Evidence

Closed by `pine close --evidence` on 2026-08-08.

- Base: `3ea7b027` (last commit at or before ticket created 2026-08-08)
- Commits (2):
  - `6cd55fc7` — fix(e2e): make both red specs green and make them actually guard (BUG-j8pbj9, BUG-19bt2k)
  - `3c7d68c2` — chore(pine): adopt pine issue tracking + file the multi-agent audit backlog
- Files changed (base → working tree):

```
 .agents/skills/pine/SKILL.md                  | 145 ++++++++++++++++
 .claude/settings.json                         |  15 +-
 .claude/skills/pine/SKILL.md                  | 145 ++++++++++++++++
 .codex/hooks.json                             |  14 ++
 .codex/hooks/pine-learn-reminder.sh           |   6 +
 .cursor/hooks.json                            |  10 ++
 .cursor/hooks/pine-learn-reminder.sh          |   6 +
 .github/ISSUE_TEMPLATE/bug_report.md          |  30 ++++
 .github/ISSUE_TEMPLATE/feature_request.md     |  15 ++
 .github/pull_request_template.md              |  24 +++
 .github/workflows/ci.yml                      |  82 +++++++++
 .pine/.gitignore                              |   4 +
 .pine/MEMORY.md                               |  13 ++
 .pine/board.json                              |   1 +
 .pine/config.json                             |   1 +
 .pine/memory/competitor-precedent.md          |  10 ++
 .pine/memory/perf-refuted.md                  |  11 ++
 .pine/prompts/fix.md                          |  22 +++
 .pine/templates/bug.md                        |  14 ++
 .pine/templates/epic.md                       |   3 +
 .pine/templates/feature.md                    |  12 ++
 .pine/tickets/BUG-19bt2k.md                   |  58 +++++++
 .pine/tickets/BUG-2hjt1x.md                   | 226 +++++++++++++++++++++++++
 .pine/tickets/BUG-2smqpv.md                   |  31 ++++
 .pine/tickets/BUG-88mac4.md                   | 210 +++++++++++++++++++++++
 .pine/tickets/BUG-e06a9d.md                   | 122 ++++++++++++++
 .pine/tickets/BUG-ery7v7.md                   | 233 ++++++++++++++++++++++++++
 .pine/tickets/BUG-g6zq2t.md                   | 104 ++++++++++++
 .pine/tickets/BUG-j8pbj9.md                   | 146 ++++++++++++++++
 .pine/tickets/BUG-t1xj4d.md                   | 134 +++++++++++++++
 .pine/tickets/BUG-y6y5mf.md                   |  78 +++++++++
 .pine/tickets/BUG-yq6qbw.md                   | 187 +++++++++++++++++++++
 .pine/tickets/BUG-yxvrwx.md                   |  80 +++++++++
 .pine/tickets/EPIC-4sa5jb.md                  |  14 ++
 .pine/tickets/EPIC-9gkehb.md                  |  15 ++
 .pine/tickets/EPIC-c2gg45.md                  |  14 ++
 .pine/tickets/EPIC-f953vk.md                  |  15 ++
 .pine/tickets/EPIC-n6ndb8.md                  |  15 ++
 .pine/tickets/EPIC-xzzpty.md                  |  15 ++
 .pine/tickets/EPIC-zpa1nd.md                  |  15 ++
 .pine/tickets/FEAT-0s2tnc.md                  |  36 ++++
 .pine/tickets/FEAT-1k76hk.md                  |  36 ++++
 .pine/tickets/FEAT-51hnwx.md                  |  36 ++++
 .pine/tickets/FEAT-56bxyh.md                  |  35 ++++
 .pine/tickets/FEAT-5hnsby.md                  |  36 ++++
 .pine/tickets/FEAT-6v92dk.md                  |  50 ++++++
 .pine/tickets/FEAT-71ay4e.md                  |  36 ++++
 .pine/tickets/FEAT-7ffxsg.md                  |  36 ++++
 .pine/tickets/FEAT-8559h1.md                  |  36 ++++
 .pine/tickets/FEAT-905vk4.md                  |  36 ++++
 .pine/tickets/FEAT-az3sxm.md                  |  36 ++++
 .pine/tickets/FEAT-bd87vz.md                  |  38 +++++
 .pine/tickets/FEAT-c0zn3j.md                  |  37 ++++
 .pine/tickets/FEAT-c5a15c.md                  |  36 ++++
 .pine/tickets/FEAT-ckxz8d.md                  |  36 ++++
 .pine/tickets/FEAT-d8b6bj.md                  |  44 +++++
 .pine/tickets/FEAT-et1gxc.md                  |  36 ++++
 .pine/tickets/FEAT-g39qj3.md                  |  36 ++++
 .pine/tickets/FEAT-hmsg5h.md                  |  36 ++++
 .pine/tickets/FEAT-k28j7h.md                  |  37 ++++
 .pine/tickets/FEAT-kncqxf.md                  |  46 +++++
 .pine/tickets/FEAT-ks4yy4.md                  |  43 +++++
 .pine/tickets/FEAT-ky1jfw.md                  |  49 ++++++
 .pine/tickets/FEAT-kzej8t.md                  |  36 ++++
 .pine/tickets/FEAT-n762y6.md                  |  47 ++++++
 .pine/tickets/FEAT-rmh08k.md                  |  34 ++++
 .pine/tickets/FEAT-vvaycm.md                  |  37 ++++
 .pine/tickets/FEAT-vwvgs0.md                  |  36 ++++
 .pine/tickets/FEAT-ybhdhz.md                  |  36 ++++
 AGENTS.md                                     |  26 +++
 CLAUDE.md                                     |  26 +++
 src/main/services/ffmpeg-export.ts            |  50 +++++-
 src/main/services/silence-detect.ts           |   4 +
 src/renderer/src/App.tsx                      |   6 +-
 src/renderer/src/components/generateClips.ts  |  12 +-
 src/renderer/src/hooks/import-controller.ts   |  16 +-
 src/renderer/src/hooks/useImportController.ts |  13 +-
 src/renderer/src/hooks/useProject.ts          |   5 +
 tests/e2e/generate-clips-button.e2e.spec.ts   |  30 ++++
 tests/e2e/ping.e2e.spec.ts                    |  64 ++++---
 tests/unit/ffmpeg-export.serial.spec.ts       |  44 ++++-
 tests/unit/ffmpeg-export.spec.ts              |  56 ++++++-
 tests/unit/generate-clips-view.spec.ts        |  23 +++
 tests/unit/import-controller.spec.ts          |  25 ++-
 tests/unit/silence-detect.spec.ts             |  11 ++
 tests/unit/use-project.spec.ts                |  12 ++
 86 files changed, 3781 insertions(+), 46 deletions(-)
```
