---
id: FEAT-n762y6
title: No pre-flight panel for Generate Clips — no style picker, no length preset, no regenerate, no timeframe
status: todo
priority: high
labels:
    - ux
    - ai
    - editor
parent: EPIC-f953vk
created: "2026-08-08T15:58:26Z"
updated: "2026-08-08T15:58:26Z"
---

## Current behavior

"Auto Generate Clips" is a single button with **no configuration surface at all** (`App.tsx:148-157`). Clip count, style, platform and min/max duration are read silently from app Settings + project settings (`generateClips.ts:26-42`). Two PRD §6.3 acceptance criteria are therefore unreachable:

- **Clip style presets** (funny / educational / controversial / emotional / motivational / storytelling) — `clipStyle` is hardcoded to `'all'` at `src/renderer/src/hooks/useProject.ts:67` and has no picker anywhere.
- **Regenerate with a different prompt/style** — no affordance exists.

There is also no way to restrict analysis to part of a long video, so a 3-hour stream must be analysed whole.

## Desired behavior

A **pre-flight panel** shown when the user presses Generate — every field defaulted so the primary button is always immediately pressable:

- Number of clips (default from Settings)
- Clip length preset (Auto / 0-30s / 30-60s / 60-90s)
- Style / genre selector, which also nudges the caption preset
- Optional keyword or free-text prompt targeting
- **Processing timeframe**: a start/end range over the source, so a user can analyse only the part they care about
- A "Regenerate" action on the results rail that reopens this panel pre-filled

## Competitor precedent

This is OpusClip's core interaction. Its "submit panel" (branded CoPilot) has exactly these controls — processing timeframe range picker, clip-length buckets (`[0,30] [30,60] [60,90]`), an 18-value genre/curation-model dropdown, keyword + prompt targeting (`ClipBasic` vs `ClipAnything`), and source language — with **nothing mandatory**, so the primary button reads "Get clips with one click!".

LokaClip ships the same idea in a simpler form and it is instructive: one **content-type control** (Umum / Podcast / Gaming / Edukasi) that simultaneously swaps the AI prompt, the subtitle preset and the layout preset. One decision, three coordinated effects.

yt-short-clipper goes further on cost: Phase 1 downloads **only the subtitle track** (`yt-dlp --skip-download --write-auto-sub`) to find highlights, and only downloads video bytes for the spans the user actually ticks.

## Implementation sketch

The request shape already supports most of this — `buildGenerateClipsRequest` (`generateClips.ts`) already passes `clipStyle`, `numClips`, `targetPlatform`, `minDuration`, `maxDuration`. The work is a dialog that writes those fields plus persistence of the last-used values, not new backend plumbing. Add `range?: {start,end}` to `GenerateClipsRequest` in `src/shared/channels.ts` and slice the segments before chunking in `ai-client.ts`.

Sequence it after [[FEAT-c0zn3j]] (progress/cancel for generate), because a configurable generate that still freezes the UI is worse than a simple one.
