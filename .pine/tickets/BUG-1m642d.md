---
id: BUG-1m642d
title: Uncommitted BUG-45xt77 work in the working tree is red and intermittently flaky
status: done
priority: high
labels:
    - hygiene
parent: EPIC-k83ghw
phase: p0
created: "2026-08-15T11:28:11Z"
updated: "2026-08-15T11:29:43Z"
---

## Problem
The working tree does not pass its own gates; HEAD does.

## Evidence
Measured, not assumed:
- `npm run typecheck:test` fails —
  `tests/unit/model-download-safety.spec.ts(186,7): error TS2353: 'expectedBytes' does not
  exist in type 'DownloadModelOptions'`.
- `npm run lint` — one prettier warning in the same file.
- Full-suite runs on the **working tree**: run 1 → 6 failures
  (`model-download-safety.spec.ts`, `model-manager.spec.ts`), run 2 → 1 failure in a
  *different* file (`model-download-dialog.spec.ts`), runs 3–4 → green. Run those two files
  alone and they pass. So the failures are order/parallelism dependent.
- Full-suite runs on **HEAD (8cf02c0)** in a clean worktree: **3/3 green**, 1433 passed.

Modified but uncommitted: `src/main/services/model-manager.ts`,
`src/renderer/src/components/model-download.ts`, `tests/unit/model-manager.spec.ts`;
untracked: `tests/unit/model-download-safety.spec.ts`.

## Impact
CI would fail on typecheck, and the new tests are flaky, which erodes trust in the suite.

## Fix
Finish or shelve the BUG-45xt77 change: add `expectedBytes` to `DownloadModelOptions`,
and isolate the shared state the two model specs contend over.

## Acceptance Criteria
- [ ] `npm run typecheck` passes on the working tree
- [ ] `npm test` is green across 3 consecutive full runs

## Resolution — already fixed during the audit

The WIP was completed and committed as `216f85f fix(models): every model installs, and
downloading one no longer destroys it (BUG-45xt77)` while this audit was running, so the
red/flaky state this ticket describes no longer exists.

Re-verified against `216f85f`:

| Gate | Result |
|---|---|
| `npm run typecheck` | pass (all four projects) |
| `npm run lint` | clean |
| `npm test` | **1457 passed, 10 skipped — 3/3 consecutive runs, no flakes** |

Filed and closed in the same pass; kept for the record because the flakiness was real when
measured (6 failures, then 1 in a different file, then green).
