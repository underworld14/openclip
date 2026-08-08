---
id: FEAT-51hnwx
title: Autosave is completely silent, so the user never learns their trims and approvals persist
status: todo
priority: medium
labels:
    - ux
    - editor
parent: EPIC-f953vk
created: "2026-08-08T15:56:46Z"
updated: "2026-08-08T15:56:46Z"
---

## Current behavior

autosave.ts:126-133 — the only user-visible signal in the entire persistence path is `toast.error('Autosave failed', …)`. Success produces nothing. There is no 'Saving…' / 'Saved' indicator, no last-saved timestamp, and no manual save. Worse, the store exposes `load`/`save` as live-looking actions with empty bodies (projectStore/index.ts:74-82 `load: async (id) => { void id; void get }`), so any future caller silently no-ops. Compounding it, autosave rewrites the *entire* document including `transcript.words` on every clip reference change, and a trim drag fires `dragClipHandle` per pointermove (Timeline.tsx:66-73) — a single drag schedules a stream of multi-MB JSON writes.

## Desired behavior

A small 'Saved · 2s ago' / 'Saving…' indicator in the title bar, and a project name that is visible and editable. Throttle trim drags to rAF with a single commit on pointerup so autosave fires once per drag rather than per pixel.

## Competitor precedent

Kapwing shows save state plus Version History; every cloud editor in this category makes persistence legible because users have been trained to distrust unsaved local work.

## Implementation sketch

Add `saveState: 'idle'|'saving'|'saved'|'error'` and `lastSavedAt` to `uiStore`, set from the autosave subscriber's success/error paths (autosave.ts:135-142). Render in the title bar next to the project name. Separately: in Timeline.tsx:66-73 keep drag position in local component state and only call `dragClipHandle` on `pointerup` (or coalesce with `requestAnimationFrame`). Either delete the stub `load`/`save` from projectStore/index.ts:74-82 or point them at the real implementations in hooks/useProject.ts.

## Sizing

Impact: **medium** · Effort: **small**

## Provenance

Found by a multi-agent sweep of the codebase cross-referenced against OpusClip, Kapwing AI Clip Maker, LokaClip, yt-short-clipper and SupoClip. Every `file:line` above was read directly from the source tree.
