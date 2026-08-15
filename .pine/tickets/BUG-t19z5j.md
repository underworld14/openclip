---
id: BUG-t19z5j
title: The preview always centre-crops, so Fit (bars), Fit (blur) and Split screen show a picture the export will not produce
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
The preview renders one framing mode regardless of which is selected.

## Evidence
- `src/renderer/src/components/PreviewPlayer.tsx:267` — the crop transform is applied for
  every mode; there is no letterbox or blur-pad branch and no split-screen composition.
- Burned captions sit at ~4% from the bottom while the preview places them at 8%
  (caption layout vs `caption-css.ts`).
- `src/renderer/src/components/caption-css.ts:47` — preset thumbnails and the live preview
  render in the system font; the preset fonts exist only for libass at burn time, so all
  14 caption templates preview in San Francisco and differ only by colour.

## Impact
A user whose source is already vertical picks "Fit (bars)" precisely so nothing is cut
off — and the preview keeps showing heads cropped out of frame, so they cannot tell the
setting worked. The caption gallery exists specifically to let them see the difference
between templates, and it cannot show it.

## Fix
Implement letterbox / blur-pad / split-screen in the preview, align the caption baseline
with the ASS output, and embed the preset fonts (or a close web equivalent) for preview.

## Acceptance Criteria
- [ ] Each framing mode previews as it exports
- [ ] Caption vertical position matches between preview and burn
- [ ] Caption template thumbnails render in their own typeface
