---
id: FEAT-k28j7h
title: 'No undo, no confirmations: Reject permanently deletes a clip and Brand Delete fires instantly'
status: todo
priority: high
labels:
    - ux
    - editor
    - safety
parent: EPIC-f953vk
created: "2026-08-08T15:56:46Z"
updated: "2026-08-08T15:56:46Z"
---

## Current behavior

clipsSlice.ts:71 `rejectClip: (id) => set((s) => ({ clips: s.clips.filter((c) => c.id !== id) }))` — the clip is spliced out of the store, and autosave.ts:92-106 persists that on any `clips` reference change 800ms later. BrandKitEditor.tsx:269-271 calls `onDelete()` directly from the button. `grep -rn "window.confirm|AlertDialog" src/renderer/src` returns nothing — there is not a single confirmation or undo path in the app. There is also no delete-clip action at all (`grep -rn "deleteClip|removeClip" src/renderer/src` → zero), so Reject is doing double duty as both 'hide' and 'destroy'.

## Desired behavior

Reject should set `status:'rejected'` and hide the card behind an 'N hidden — show' affordance, not delete it. Every destructive action gets an undo toast ('Clip rejected — Undo') and brand delete gets an AlertDialog confirm. Cmd+Z for the last store mutation.

## Competitor precedent

OpusClip's dislike hides the clip (reversible) and like builds a shortlist. Kapwing ships Version History alongside undo/redo — 'revert to or duplicate from any prior project state'. SupoClip's cleanup edits are all previewed before commit and reversible.

## Implementation sketch

Add `'rejected'` to `ClipStatus` in `src/shared/schema.ts` (it's a `looseObject` for persistence, so old projects still load). Change clipsSlice.ts:71 to a status update instead of a filter; update `sortClipsForSidebar` (clipView.ts:85) and ClipSidebar.tsx:41 to exclude rejected, with a footer 'N hidden — show'. Wire the existing `sonner` Toaster (already mounted at App.tsx:219) for an undo toast. Adopt the unused `components/ui/alert-dialog` pattern (or add one) for BrandKitEditor.tsx:269.

## Sizing

Impact: **high** · Effort: **medium**

## Provenance

Found by a multi-agent sweep of the codebase cross-referenced against OpusClip, Kapwing AI Clip Maker, LokaClip, yt-short-clipper and SupoClip. Every `file:line` above was read directly from the source tree.
