---
id: FEAT-0s2tnc
title: Caption templates are bare text chips with a hover tooltip — the most visible output differentiator has no visual preview
status: todo
priority: high
labels:
    - ux
    - captions
parent: EPIC-f953vk
created: "2026-08-08T15:56:46Z"
updated: "2026-08-08T15:56:46Z"
---

## Current behavior

ExportPanel.tsx:332-352 renders 13 `TemplateChip`s. `TemplateChip` (ExportPanel.tsx:47-69) is a `<button>` whose only description is a raw HTML `title` attribute (:58) — there are no tooltips anywhere in the app (`components/ui/tooltip.tsx` has zero importers). The names ('Hormozi', 'MrBeast', 'Beast Pop', 'Captionate') mean nothing without seeing them, and the gallery lives buried inside the Export dialog rather than being a design surface.

## Desired behavior

A scrollable strip of live thumbnails, each rendering the same real 3-word phrase from the user's own transcript in that template's font/fill/outline/highlight — plus the active template applied instantly in the PreviewPlayer's existing DOM caption overlay. Move the gallery out of the Export dialog into a caption panel next to the preview.

## Competitor precedent

Kapwing ships 100+ named presets ('Pop Art', 'Typewriter', 'Handwriting') as a visual picker, each a full bundle. SupoClip's named templates (default / hormozi / mrbeast) are the primary caption UI with font/size/color as an advanced drawer. OpusClip's Brand Templates are picked visually and applied by id.

## Implementation sketch

The renderer already approximates ASS styling in CSS (`caption-css.ts` drives the PreviewPlayer karaoke overlay at PreviewPlayer.tsx:183-214). Reuse it: render each `CAPTION_PRESETS` entry as a small div with the preset's CSS applied to three real words pulled from `transcript.words`. No ffmpeg needed. Extract the gallery from ExportPanel.tsx:332-352 into `components/CaptionStylePanel.tsx` and mount it beside PreviewPlayer in App.tsx:168-172, keeping `captionTemplateId` on project settings so export and preview stay in agreement.

## Sizing

Impact: **high** · Effort: **medium**

## Provenance

Found by a multi-agent sweep of the codebase cross-referenced against OpusClip, Kapwing AI Clip Maker, LokaClip, yt-short-clipper and SupoClip. Every `file:line` above was read directly from the source tree.
