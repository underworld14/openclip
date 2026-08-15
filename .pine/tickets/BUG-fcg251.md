---
id: BUG-fcg251
title: A renderer exception blanks the window permanently — no error boundary, no crash handler, no Reload
status: doing
priority: high
labels:
    - resilience
parent: EPIC-k83ghw
phase: p0
created: "2026-08-15T11:28:11Z"
updated: "2026-08-15T12:18:17Z"
---

## Problem
Any uncaught React error leaves a dead black window with no way back.

## Evidence
- `grep -rn "ErrorBoundary|componentDidCatch" src/renderer/src/` → **zero hits**.
- `grep -rn "render-process-gone|unresponsive" src/main/index.ts` → **zero hits**.
- `src/main/menu.ts` View submenu has `togglefullscreen` and `toggleDevTools` but **no
  `role: 'reload'`**, and Cmd+R is not bound.

## Impact
The window goes blank and stays blank. No message, no reload button, no keyboard escape.
A non-technical user concludes the app is broken and quits; unsaved edits inside the
autosave debounce are lost with it.

## Fix
Add a top-level React error boundary that renders a recoverable "Something went wrong —
Reload" screen, handle `render-process-gone` in main, and add a Reload menu item.

## Acceptance Criteria
- [ ] A thrown render error shows a recovery screen, not a blank window
- [ ] `render-process-gone` is handled and surfaced
- [ ] A Reload command exists in the menu
