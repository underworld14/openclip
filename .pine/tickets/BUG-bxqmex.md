---
id: BUG-bxqmex
title: Space is dead when the timeline has focus, and the global Space binding breaks keyboard activation of every button
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
Two handlers fight over the spacebar, and the global one breaks native button semantics.

## Evidence
- `src/renderer/src/components/Timeline.tsx:111-114` — the timeline's own keydown handler
  does `e.preventDefault(); setPlaying(!isPlaying)`.
- `src/renderer/src/hooks/useGlobalShortcuts.ts:62` — the document-level listener maps
  `' '` to `play-pause` and also toggles. `preventDefault()` does not stop propagation, so
  **both fire and cancel each other out**: Space does nothing once the timeline is focused
  (which is exactly what clicking the timeline to seek does).
- The same `e.preventDefault()` at `:74` runs whenever a shortcut matches and the target is
  not a text field — so Tab to any `<button>`, press Space, and the button is **not**
  activated (browsers activate buttons on Space keyup only if keydown's default stands);
  the video plays instead.

## Impact
The single most-used control in a video editor is dead where the user expects it. And the
app is not keyboard-operable: Space, the standard button activation key, silently does the
wrong thing everywhere (WCAG 2.1.1).

## Fix
Delete the Timeline's local Space case and let the global shortcut own playback; scope the
global Space binding so it does not preventDefault when the focused element is a
button/link/checkbox.

## Acceptance Criteria
- [ ] Space toggles playback with the timeline focused
- [ ] Space activates a focused button and does not start playback
