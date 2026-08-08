---
id: FEAT-bd87vz
title: No letterbox/pad fit mode and no aspect-ratio picker — portrait sources get cropped
status: todo
priority: medium
labels:
    - ux
    - export
parent: EPIC-n6ndb8
created: "2026-08-08T15:59:08Z"
updated: "2026-08-08T15:59:08Z"
---

## Current behavior

The only fit strategies are center-crop and face-crop. `cropExpr` in `src/main/services/ffmpeg-export.ts:75-86` has no pad branch, and `ExportArgsOptions` has no fit/pad field.

PRD Appendix A documents the command that is missing (`docs/prd.md:885`):

```
scale=…:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2
```

Consequence: a source that is already portrait or square gets **cropped** when it should be letterboxed, silently cutting content out of frame.

Compounding this, PRD §6.5 promises 1:1 and 4:5 support to the *user*, but single-clip export reads `currentProject.settings.aspectRatio` (`ExportPanel.tsx:116`) — a field with **no UI writer**, permanently `'9:16'`. The only way to reach another ratio today is a batch-export platform preset.

## Desired behavior

An explicit fit control per export — **Fill (crop)** / **Fit (letterbox)** / **Fit (blurred bars)** / **Speaker focus** — and a real aspect-ratio picker in the single-clip export path.

## Competitor precedent

Kapwing: Resize Canvas → pick a ratio → choose one of three fill modes, named *Fit to Center*, *Fill and Crop*, *Speaker Focus*. LokaClip ships four layouts including *16:9 Fit black letterbox* and *16:9 Fit blur* — the blurred-bar variant is the one social audiences actually expect.

## Note

Ships naturally with [[BUG-y6y5mf]] (ASS PlayRes is hardcoded to 1080x1920, so captions are already wrong on any non-9:16 canvas). Fix the caption sizing first or new ratios will ship with mis-sized captions.
