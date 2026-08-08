---
id: FEAT-ybhdhz
title: Clip cards nest real buttons inside a role="button", and the 'exported' status renders no badge at all
status: todo
priority: medium
labels:
    - ux
    - a11y
parent: EPIC-f953vk
created: "2026-08-08T15:56:46Z"
updated: "2026-08-08T15:56:46Z"
---

## Current behavior

ClipCard.tsx:36-57 makes the card `role="button" tabIndex={0} aria-pressed={selected}` with an Enter/Space handler, and then nests real `<Button>` elements for Approve (:100-110) and Reject (:115-126) inside it — invalid interactive nesting that makes AT announcement ambiguous and traps Space. Separately, `clipView.ts:69-71` derives only `isApproved: status === 'approved'`, so a clip with `status:'exported'` has `isApproved` false, `canApprove` false and `canReject` false — it renders no badge and no actions, appearing broken. Export history is recorded (exportSlice.ts:160 `addExportRecord`) but `grep -rn exportHistory src/renderer/src/components` returns nothing, so the user can never tell which clips they already shipped.

## Desired behavior

Make the card a non-interactive container with an explicit clickable title region (or use a full-card `<button>` with the actions moved to an adjacent toolbar outside it). Add an 'Exported' badge and a 'Reveal in Finder' action for exported clips, and an Export History panel listing every render with its path, settings, and a reveal button that marks entries whose file has moved.

## Competitor precedent

Kapwing keeps a persistent export history so previous renders remain retrievable rather than being one-shot downloads. OpusClip's cards carry per-clip state (liked/hidden/downloaded) and distinct per-clip actions.

## Implementation sketch

ClipCard.tsx: drop `role`/`tabIndex`/`aria-pressed`/`onKeyDown` from the outer div; wrap the title+meta block in a `<button className="text-left">` that calls `selectClip`, leaving the action row as siblings. clipView.ts:69-71: add `isExported: clip.status === 'exported'` and render a green 'Exported' badge next to the existing 'Approved' one (ClipCard.tsx:112-114). New `components/ExportHistoryPanel.tsx` reading `exportHistory` from the store, with `system:open-folder` per row.

## Sizing

Impact: **medium** · Effort: **small**

## Provenance

Found by a multi-agent sweep of the codebase cross-referenced against OpusClip, Kapwing AI Clip Maker, LokaClip, yt-short-clipper and SupoClip. Every `file:line` above was read directly from the source tree.
