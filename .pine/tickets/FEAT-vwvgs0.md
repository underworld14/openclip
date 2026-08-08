---
id: FEAT-vwvgs0
title: 'The transcript is inert: no click-to-seek, no create-clip-from-selection, and no export as SRT/VTT'
status: todo
priority: high
labels:
    - ux
    - transcript
parent: EPIC-f953vk
created: "2026-08-08T15:56:46Z"
updated: "2026-08-08T15:56:46Z"
---

## Current behavior

TranscriptPanel.tsx:62-73 renders plain `<li>` rows with a timestamp span and a text span — no `onClick`, no `role`, no keyboard affordance. There is no way to seek from the transcript, no way to select words and make a clip from them, and no way to delete words to cut the video. `grep -rniE "srt|webvtt|\.vtt" src/ -l` returns zero matches across the whole tree, so transcript export (a PRD §6.2 acceptance criterion) does not exist in any form.

## Desired behavior

Minimum: clicking a segment seeks the preview to its start and highlights the active line during playback. Next: drag-select across segments → 'Create clip from selection', producing a clip with bounds snapped to the selected word timings. Plus a 'Download transcript' menu offering SRT / VTT / plain text, and always writing a sidecar `.srt` next to every exported MP4.

## Competitor precedent

OpusClip's editor is transcript-first: select words and press Delete to cut the video; 'Add a section' extends the clip into adjacent transcript. Kapwing's Transcript panel is a peer of the timeline and deleting text deletes video. Both ship SRT/VTT export as data, not just burned pixels.

## Implementation sketch

Seek first (small): make each `<li>` in TranscriptPanel.tsx:62-73 a `<button>` calling `setPlayhead(seg.start)` + `seekTo`, with `aria-current` on the active segment derived from the existing `playhead` subscription. Clip-from-selection: use `window.getSelection()` anchored to `data-segment-id` attributes, map to `transcript.words` timings, and call the existing clip-creation path in clipsSlice. SRT/VTT: a pure `src/shared/subtitle-export.ts` serializer over `transcript.segments`/`words` (fully unit-testable, no ffmpeg), surfaced via `system:save-dialog` and additionally written alongside each export in export-runner.ts.

## Sizing

Impact: **high** · Effort: **medium**

## Provenance

Found by a multi-agent sweep of the codebase cross-referenced against OpusClip, Kapwing AI Clip Maker, LokaClip, yt-short-clipper and SupoClip. Every `file:line` above was read directly from the source tree.
