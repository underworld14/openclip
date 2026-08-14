---
id: FEAT-kzej8t
title: Auto-reframe is an invisible, unpreviewable, un-overridable on/off switch
status: testing
priority: medium
labels:
    - ux
    - reframe
parent: EPIC-f953vk
created: "2026-08-08T15:56:46Z"
updated: "2026-08-14T14:29:47Z"
---

## Current behavior

PreviewPlayer's crop is CSS-only (PreviewPlayer.tsx:168-175); when reframe is on, the preview does not change at all — it just shows a badge reading 'Auto-reframe on export' (PreviewPlayer.tsx:217-224). The user cannot see the face-follow plan, cannot correct a wrong-speaker track, and cannot letterbox instead of crop (pad/fit mode from PRD Appendix A is unimplemented — ffmpeg-export.ts:75-86 `cropExpr` has no pad branch). Detection failure silently degrades to center-crop (export-runner.ts:161 wraps each analysis pass in its own try/catch) with no user-visible signal.

## Desired behavior

Named modes in one control — 'Fill (center crop)', 'Fit (blurred/letterbox background)', 'Follow speaker', 'Split screen' — with the computed plan drawn on the timeline as crop keyframes the user can nudge or delete, and a manual crop box draggable over the preview frame. When detection fails or finds no reliable face, say so and fall back to Fit rather than silently center-cropping.

## Competitor precedent

Kapwing offers three explicit fill modes ('Fit to Center' / 'Fill and Crop' / 'Speaker Focus'). OpusClip names Fill / Fit / Split / Screenshare / Gameplay, applicable per-scene, with a Manual Reframe window on double-click. openshorts falls back from TRACK to a blurred-background GENERAL mode when no face dominates.

## Implementation sketch

Step 1 (small, high value): implement the pad/fit branch in `cropExpr` (ffmpeg-export.ts:75-86) using `scale=…:force_original_aspect_ratio=decrease,pad=…` plus a blurred `split`+`gblur` background, and add it to the reframe select at ExportPanel.tsx:397-409. Step 2: return the `ReframePlan` (already a pure structure in `src/shared/reframe-plan.ts`) to the renderer from a new `video:plan-reframe` channel and render its keyframes as dots on the Timeline track. Step 3: let the preview apply the plan's `crop x` at the current playhead via CSS `object-position`, so face-follow is actually visible. Note reframe planning currently has no cache (docs/auto-reframe-design.md:50 asks for one) — add plan caching keyed on clip id + bounds first, or step 2 re-pays full analysis on every preview.

## Sizing

Impact: **medium** · Effort: **large**

## Provenance

Found by a multi-agent sweep of the codebase cross-referenced against OpusClip, Kapwing AI Clip Maker, LokaClip, yt-short-clipper and SupoClip. Every `file:line` above was read directly from the source tree.

## Delivered (2026-08-14)

- `video:plan-reframe` channel; preview follows the plan's crop at the playhead
  (`cropXAt`, interpolating like the burn). Shares the export plan cache, so the
  preview and the export read one plan.
- `ReframePlan` carries pan `keyframes` (the `xExpr` is unevaluable in the
  renderer, which is why the plan could never be previewed or drawn).
- Detection failure is NAMED in the badge with the cause in its tooltip, instead
  of degrading to a centre crop in silence. Failures are not cached.
- ONE framing control — Fill / Follow speaker / Split screen / Fit (bars) /
  Fit (blur) — replacing the two that interacted and needed a warning.
- Timeline draws a dot per pan keyframe, rebased onto the source timeline.

## NOT delivered, deliberately

- **Auto-switch to Fit on detection failure.** The "say so" half is done;
  silently letterboxing an export the user configured as "Follow speaker" trades
  one surprise for another. The merged control puts Fit one click away and the
  badge says why they might want it.
- **Draggable manual crop box over the preview.** Not started.
- **Nudge/delete individual crop keyframes.** The dots are read-only.

Sequenced after FEAT-bd87vz (pad/fit — Step 1) and FEAT-rmh08k (plan cache —
Step 2's prerequisite), both closed.
