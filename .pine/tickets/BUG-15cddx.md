---
id: BUG-15cddx
title: Batch export discards the caption style and the framing the user chose — output does not match the preview
status: todo
priority: high
labels:
    - wysiwyg
parent: EPIC-k83ghw
phase: p1
created: "2026-08-15T11:28:11Z"
updated: "2026-08-15T11:28:11Z"
---

## Problem
Single export honours the user's choices; batch export silently substitutes the preset's.

## Evidence
- **Single** — `src/renderer/src/components/ExportPanel.tsx:167,175` passes
  `captionStyle: resolveEffectiveCaptionStyle(captionTemplateId, …)` where
  `captionTemplateId` comes from `currentProject.settings` (`:108`), plus
  `settings: project.settings` (carrying `fitMode`) and `reframe`.
- **Batch** — `src/renderer/src/components/batch-export.ts:116` resolves the style from
  **`opts.preset.captionTemplateId`** instead, and `:148` builds params with
  `settings: { aspectRatio: opts.preset.aspectRatio }` only — **no `fitMode`, no
  `reframe`, no manual crop**.
- `platformPresets.ts:24,31,38,45` — TikTok forces `tiktok-bounce`, everything else
  forces `default`.

## Impact
The user picks "Hormozi" captions in the gallery next to the preview and "Follow speaker"
framing, watches the preview track the speaker, clicks "Export all approved" — and every
file comes out in a different caption style with a plain centre crop.

## Fix
Have `runBatchExport` build params from the same project settings the single-clip path
uses; let the platform preset supply aspect ratio and quality only.

## Acceptance Criteria
- [ ] A batch-exported clip is byte-comparable in style/framing to the same clip exported singly
- [ ] The caption style chosen in CaptionStylePanel is the one burned in a batch
