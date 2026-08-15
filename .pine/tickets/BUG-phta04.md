---
id: BUG-phta04
title: The readiness bar can never report a missing sidecar — paths.ts never throws in a packaged build
status: todo
priority: high
labels:
    - dead-control
parent: EPIC-k83ghw
phase: p1
created: "2026-08-15T11:28:11Z"
updated: "2026-08-15T11:28:11Z"
---

## Problem
The preflight's whole purpose is to catch a broken install, and it structurally cannot.

## Evidence
- `src/main/ipc/system.ts:28` — `probe()` returns `{ok:false}` only on a throw or an empty
  string, and its comment asserts "`paths.ts` throws when it cannot locate a binary".
- That is false for the production path. `src/main/utils/paths.ts:78,88,142,174` all end in
  an unconditional `return join(process.resourcesPath, …)` with **no `existsSync` check and
  no throw**. The dev branches check; the packaged branch does not.

## Impact
On any damaged install — an incomplete copy off the dmg, a quarantined or antivirus-stripped
sidecar — all three readiness chips show green, and the user only discovers the problem as a
raw spawn error partway through an import they have already committed to.

## Fix
`existsSync`-guard the packaged branches (or have `probe()` stat the returned path).

## Acceptance Criteria
- [ ] Deleting a bundled sidecar from a packaged .app turns its readiness chip red
- [ ] A test asserts `probe()` reports `ok:false` for a non-existent path
