---
id: BUG-hfwbeb
title: Cmd+G bypasses the readiness gate, and the disabled Generate button's explanation can never render
status: todo
priority: medium
labels:
    - dead-control
parent: EPIC-k83ghw
phase: p1
created: "2026-08-15T11:28:11Z"
updated: "2026-08-15T11:28:11Z"
---

## Problem
The keyboard path skips the check the button enforces, and the button's own explanation is
unreachable.

## Evidence
- `src/renderer/src/App.tsx:233` — the `generate-clips` shortcut calls `openPreflight`
  directly, while the header button at `:484` is gated on
  `!hasTranscript || generating || !readiness.canGenerate`. Cmd+G therefore runs with no
  key or a blank model and surfaces a raw SDK/Zod error.
- `App.tsx:486-489` puts `readiness.blockingReason` in a `title` on a **disabled** Button;
  `ui/button.tsx:8` includes `disabled:pointer-events-none`, so the browser never fires the
  hover and the tooltip never appears. `ReadinessBar.tsx:42-45` documents this exact
  behaviour as the reason its own chips use `aria-disabled` — the fix was not applied here.
- `readinessView.ts:136-141` computes perfectly good copy ("Add an API key for OpenAI in
  Settings.") that nothing can display.

## Impact
The user is told to press the button the app has been pointing them at, hovers it for an
explanation, and gets nothing.

## Fix
Apply the same readiness gate to the shortcut and the menu item; render `blockingReason`
as visible text, or use `aria-disabled` + an onClick that opens Settings.

## Acceptance Criteria
- [ ] Cmd+G with no key opens Settings (or shows the same block reason) instead of erroring
- [ ] The reason Generate is disabled is visible without hovering
