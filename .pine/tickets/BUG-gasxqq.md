---
id: BUG-gasxqq
title: Rejecting the selected clip leaves the preview, timeline and Export dialog pointed at it; and clips can only ever be batch-exported once
status: doing
priority: high
labels:
    - dead-control
parent: EPIC-k83ghw
phase: p1
created: "2026-08-15T11:28:11Z"
updated: "2026-08-15T11:49:22Z"
---

## Problem
Clip status transitions leave every downstream consumer stale.

## Evidence
- `src/renderer/src/stores/projectStore/clipsSlice.ts:145` — `rejectClip` flips `status`
  but never clears `selectedClipId`, so the preview and timeline keep showing and
  trimming a clip the user just rejected.
- `src/renderer/src/components/ExportPanel.tsx:95` — the export target stays the rejected
  clip while the picker renders nothing selected.
- `clipsSlice.ts:148` — `markExported` sets `status:'exported'`, and
  `ExportPanel.tsx:240` computes `approvedClips = clips.filter(c => c.status === 'approved')`.
  After one batch the button reads **"Export all approved (0)" forever**.

## Impact
The natural second pass — export everything to TikTok 9:16, then re-export the same clips
as Reels 4:5, or re-export after changing the caption style — is impossible without
manually re-approving every clip.

## Fix
Clear/advance the selection on reject; treat `exported` as still-approved for batch
selection (or add an explicit "include already exported" toggle).

## Acceptance Criteria
- [ ] Rejecting the selected clip moves the selection somewhere valid
- [ ] The same approved set can be batch-exported twice
