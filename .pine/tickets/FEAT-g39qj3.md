---
id: FEAT-g39qj3
title: AI-generated social caption and hashtags are computed, persisted, and never shown to anyone
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

The AI returns `suggested_caption` and `hashtags` per clip; clipsSlice.ts:53-56 explicitly carries them onto the Clip ('audit fix openclip-5cd'), and schema.ts:172-174 persists them into the `.ocproj`. But `ClipViewModel` (clipView.ts:26-44) has no field for either, and `grep -rn "suggestedCaption|hashtags" src/renderer/src/components src/renderer/src/stores` matches only the mapper. The user pays for these tokens on every generation and never sees the output. Separately, `GENERATE_TITLES` (main/ipc/ai.ts:175-178) returns `{options: []}` unconditionally.

## Desired behavior

On each clip card (or its detail pane): the suggested caption and hashtag chips with a one-click 'Copy caption' button. This removes the last manual step before posting and costs zero extra inference — the data is already on disk.

## Competitor precedent

OpusClip generates per-clip title, description and hashtags tailored per destination platform, with copy affordances. Kapwing gives every clip an AI title. LokaClip returns a ready-to-use hook sentence per clip in the source video's language.

## Implementation sketch

Add `suggestedCaption?: string` and `hashtags?: string[]` to `ClipViewModel` and populate them in `clipViewModel()` (clipView.ts:57-76). Render in ClipCard.tsx below the virality bars — caption as a 2-line clamp, hashtags as small chips — with a copy button calling `navigator.clipboard.writeText`. Guard on `!== undefined` since both are optional on older projects.

## Sizing

Impact: **medium** · Effort: **small**

## Provenance

Found by a multi-agent sweep of the codebase cross-referenced against OpusClip, Kapwing AI Clip Maker, LokaClip, yt-short-clipper and SupoClip. Every `file:line` above was read directly from the source tree.
