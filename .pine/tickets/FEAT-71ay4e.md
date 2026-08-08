---
id: FEAT-71ay4e
title: Results are text-only cards — no thumbnail, no playable preview, no transcript excerpt
status: todo
priority: high
labels:
    - ux
    - editor
parent: EPIC-f953vk
created: "2026-08-08T15:56:46Z"
updated: "2026-08-08T15:56:46Z"
---

## Current behavior

ClipCard.tsx:36-127 renders title, ⭐score/10, time range, hook-type chip, hook sentence, and four amber bars. There is no image and no video. Thumbnail generation is implemented but completely unwired: `thumbnailArgs`/`generateThumbnail` exist at ffmpeg-export.ts:652,780 with zero callers, and `Clip.thumbnailPath` (schema.ts:164) is never written. The clip's actual spoken words are never shown — `clipViewModel` (clipView.ts:57-76) doesn't surface any transcript text, so the user must click each card and scrub to judge it.

## Desired behavior

Each card gets (a) a poster frame extracted at the clip's IN point, (b) a muted looping preview that plays on hover (capped to 2-3 concurrent `<video>` elements via IntersectionObserver, served over the existing `openclip-media://` scheme with a `#t=start,end` fragment), and (c) a 2-line excerpt of the actual transcript text inside the span. Triage becomes a two-second glance instead of a scrub.

## Competitor precedent

OpusClip's results screen is a grid of vertical 9:16 preview cards with captions already burned in. Kapwing returns finished, previewable clips each in its own inline player. YT-Short-Clipper's highlight-selection list shows a 300-char excerpt of the *actual transcript* for each span next to the AI's pitch — the single cheapest credibility win here.

## Implementation sketch

Excerpt first (small, no pipeline work): add `excerpt: string` to `ClipViewModel` in clipView.ts, derived by slicing `transcript.segments` between `editedStart ?? startTime` and `editedEnd ?? endTime`; render it in ClipCard.tsx under the hook line. Then thumbnails: call the already-written `generateThumbnail` (ffmpeg-export.ts:780) from a new lightweight path after `generateClips` resolves, writing into `cacheDirFor(projectId)` and setting `clip.thumbnailPath`; grant the path via `mediaAccess` so `openclip-media://` can serve it. Hover preview last: a `<video muted loop preload="metadata">` in ClipCard pointed at the source with a time-fragment, mounted only while hovered.

## Sizing

Impact: **high** · Effort: **medium**

## Provenance

Found by a multi-agent sweep of the codebase cross-referenced against OpusClip, Kapwing AI Clip Maker, LokaClip, yt-short-clipper and SupoClip. Every `file:line` above was read directly from the source tree.
