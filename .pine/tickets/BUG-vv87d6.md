---
id: BUG-vv87d6
title: Regenerate wipes approvals, trims and manual crops with no warning and no undo
status: todo
priority: high
labels:
    - data-loss
parent: EPIC-k83ghw
phase: p0
created: "2026-08-15T11:28:11Z"
updated: "2026-08-15T11:28:11Z"
---

## Problem
"Regenerate" reads as "give me more suggestions" and behaves as "discard all my work".

## Evidence
- `src/renderer/src/stores/projectStore/clipsSlice.ts:194` — the `done` branch replaces the
  entire `clips` array; approvals (`status:'approved'`), hand-trimmed bounds, manual crops
  and generated thumbnails are all discarded.
- `GeneratePreflightDialog.tsx` contains no warning about replacement.
- There is no undo: the only undo in the app is the Reject toast
  (`ClipCard.tsx:251`), and `src/main/menu.ts` documents that "the renderer has no undo
  stack of its own".

## Impact
A creator who spends 20 minutes trimming and approving five clips, then clicks Regenerate
to try another style, loses all of it irreversibly.

## Fix
Warn in the pre-flight dialog when clips already exist and name what will be lost; offer
"add to existing" as well as "replace"; preserve approved/edited clips by default.

## Acceptance Criteria
- [ ] Regenerating with existing clips requires an explicit confirm that names the loss
- [ ] Approved and manually-trimmed clips survive a regenerate, or the user opted out
