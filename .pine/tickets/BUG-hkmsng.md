---
id: BUG-hkmsng
title: A generation that returns zero clips wipes the list and says nothing
status: todo
priority: medium
labels:
    - copy
parent: EPIC-k83ghw
phase: p1
created: "2026-08-15T11:28:11Z"
updated: "2026-08-15T11:28:11Z"
---

## Problem
The empty result is indistinguishable from the button not working.

## Evidence
- `src/main/services/ai-client.ts:705` — a run whose candidates are all clamped or dropped
  returns an empty array, and `clipsSlice` replaces `clips` with it.
- For most videos the progress bar stays at 0% with "Analyzing transcript…" for the whole
  run, so the app already looks frozen before the empty result lands.

## Impact
The user picks a length preset, presses Generate, waits, pays for the API call — and the
sidebar returns to "No clips yet", exactly as before they pressed anything. They have no
idea whether it ran, failed, or found nothing.

## Fix
Distinguish "ran, found nothing" from "never ran": keep the previous clips, and explain
why zero came back (e.g. "No moment matched 60–90s — try a wider length range").

## Acceptance Criteria
- [ ] A zero-clip run shows an explanation and does not clear existing clips
- [ ] Generate progress advances visibly during a run
