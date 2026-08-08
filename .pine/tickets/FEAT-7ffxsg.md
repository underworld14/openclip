---
id: FEAT-7ffxsg
title: Export and Settings dialogs cannot scroll — controls become physically unreachable at the app's minimum window height
status: todo
priority: high
labels:
    - ux
    - a11y
parent: EPIC-f953vk
created: "2026-08-08T15:56:46Z"
updated: "2026-08-08T15:56:46Z"
---

## Current behavior

ui/dialog.tsx:53-56 sets `fixed top-[50%] left-[50%] … grid w-full max-w-[calc(100%-2rem)] … sm:max-w-lg` with no `max-h` and no `overflow`. SettingsPanel.tsx:181-408 stacks provider + model input + a 224px model list + key field + a whole emoji provider block + the full BrandKitEditor + language picker. ExportPanel is comparably dense (captions toggle :318, 13-chip gallery :332-352, emoji control :357-384, silence :387, reframe :397-409, clip picker, progress, batch block :472-517). main/index.ts:159-160 sets `minHeight: 600`.

## Desired behavior

`max-h-[85vh] overflow-y-auto` on DialogContent as a baseline, with the header pinned. Better: split Settings into tabs (AI / Transcription / Brand / Advanced) and Export into Style / Output sections so neither is a single long scroll.

## Competitor precedent

Kapwing splits its caption panel into three shallow tabs (Style / Animation / Text) rather than one 20-control scroll; OpusClip uses a sidebar with per-tab panels in the editor.

## Implementation sketch

One-line fix in `src/renderer/src/components/ui/dialog.tsx:54`: append `max-h-[85vh] overflow-y-auto` to the DialogContent class string. Then adopt the already-bundled-but-unused `components/ui/tabs.tsx` (currently zero importers) to section SettingsPanel.tsx:181-408.

## Sizing

Impact: **high** · Effort: **small**

## Provenance

Found by a multi-agent sweep of the codebase cross-referenced against OpusClip, Kapwing AI Clip Maker, LokaClip, yt-short-clipper and SupoClip. Every `file:line` above was read directly from the source tree.
