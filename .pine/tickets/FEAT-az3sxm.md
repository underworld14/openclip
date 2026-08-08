---
id: FEAT-az3sxm
title: No cancel on a single-clip export, and closing the dialog orphans a running ffmpeg encode
status: todo
priority: high
labels:
    - ux
    - export
parent: EPIC-n6ndb8
created: "2026-08-08T15:56:46Z"
updated: "2026-08-08T15:56:46Z"
---

## Current behavior

ExportPanel.tsx:449-457 renders only an 'Export clip' button disabled while running — no cancel — while the batch path right below it has a working 'Cancel all' (ExportPanel.tsx:506-515). App.tsx:194 mounts the export dialog with default Radix dismiss behaviour, so Escape or an overlay click closes it; the progress bar (:430-435), the done state (:437-441) and the 'Open folder' button (:458-467) all unmount while the ffmpeg child keeps encoding to completion with no consumer.

## Desired behavior

A Cancel button next to 'Export clip' calling `jobs.cancel(jobId)` (the sidecar already SIGKILLs and cleans the `.part.mp4`). Guard dialog dismissal while a job is running — either block `onOpenChange` with a confirm, or let it close and keep the job visible in a persistent status strip so 'Open folder' is still reachable when it lands.

## Competitor precedent

OpusClip and Kapwing both run exports as server-side jobs you can navigate away from and return to; the artifact is always retrievable from the project page. SupoClip supports cooperative cancel at every pipeline stage.

## Implementation sketch

ExportPanel already captures the export jobId in its run path (same shape as `batchAbort.current`). Store it in a ref, render a `variant="destructive"` Cancel next to export-start (ExportPanel.tsx:449-468) calling `window.openclip.jobs.cancel({jobId})`. For dismissal: in App.tsx:194 pass `onInteractOutside`/`onEscapeKeyDown` handlers that `preventDefault()` while `phase === 'exporting'`, or lift export state into the export slice so it survives unmount (needed anyway for Gap #13).

## Sizing

Impact: **high** · Effort: **small**

## Provenance

Found by a multi-agent sweep of the codebase cross-referenced against OpusClip, Kapwing AI Clip Maker, LokaClip, yt-short-clipper and SupoClip. Every `file:line` above was read directly from the source tree.
