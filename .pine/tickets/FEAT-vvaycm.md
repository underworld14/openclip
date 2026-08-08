---
id: FEAT-vvaycm
title: Keyboard support is one focus-scoped group; there are no app-wide shortcuts and no application menu
status: todo
priority: medium
labels:
    - ux
    - a11y
    - keyboard
parent: EPIC-f953vk
created: "2026-08-08T15:56:46Z"
updated: "2026-08-08T15:56:46Z"
---

## Current behavior

Timeline.tsx:95-117 is the only key handler with app semantics (I / O / Space) and it only fires when the timeline div itself holds focus (`tabIndex={0}` at Timeline.tsx:139, with the key list buried in an aria-label at :141 — nothing tells the user). `grep -rn "addEventListener('keydown'" src/renderer/src` returns nothing; `grep -rn "setApplicationMenu|Menu.buildFromTemplate" src/main` returns nothing, so the app runs on Electron's default menu with no Cmd+, Cmd+E, Cmd+N or Cmd+O. The trim handles are `<button aria-label="Trim in">` with no keyboard adjustment (pointer only). PRD §11.3 specifies ~9 MVP shortcuts; 3 exist.

## Desired behavior

A real macOS application menu (File: New/Open/Import…, Edit: Undo/Redo, Clip: Approve/Reject/Export, View, Window) whose items carry the accelerators, so shortcuts work globally and are discoverable in the menu bar. Space plays/pauses from anywhere, J/K/L shuttle, arrow keys nudge trim by a frame, +/- zoom the timeline, Cmd+E exports the selected clip, Cmd+, opens Settings. A '?' shortcut sheet.

## Competitor precedent

OpusClip publishes an NLE-conventional hotkey set (D or Cmd+B split, Backspace delete, arrows step one frame, ±zoom, Home/End, with J/K/L announced). This is precisely where a desktop app should beat a browser tool — no browser chrome stealing keystrokes.

## Implementation sketch

Build a menu template in a new `src/main/menu.ts`, install it from `src/main/index.ts` after `whenReady`, and route items to the renderer over a one-way `lifecycle:`-prefixed channel (the same trick channels.ts:106-113 already uses for FLUSH_BEFORE_QUIT so `buildNamespace` doesn't auto-expose it). Renderer side: a `useGlobalShortcuts()` hook in App.tsx with a document-level keydown listener that bails when the event target is an input/textarea. Add arrow-key handlers to the trim handle buttons in Timeline.tsx.

## Sizing

Impact: **medium** · Effort: **medium**

## Provenance

Found by a multi-agent sweep of the codebase cross-referenced against OpusClip, Kapwing AI Clip Maker, LokaClip, yt-short-clipper and SupoClip. Every `file:line` above was read directly from the source tree.
