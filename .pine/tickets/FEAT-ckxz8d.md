---
id: FEAT-ckxz8d
title: No global job surface — once a modal closes, running work is invisible and unreachable
status: testing
priority: high
labels:
    - ux
    - jobs
deps:
    - FEAT-vh2bwz
parent: EPIC-zpa1nd
created: "2026-08-08T15:56:46Z"
updated: "2026-08-09T03:50:18Z"
---

## Current behavior

useJob.ts:200-209 documents itself as 'RESERVED, NOT YET WIRED … `uiStore.tasks`, which is currently WRITTEN but never READ by any component — the global job-queue/progress UI it was designed for doesn't exist yet.' `grep -rn "useJob("` finds zero component call sites (only two doc comments). Every progress surface is modal-local: ImportPanel.tsx:96-110, ExportPanel.tsx:430-435, ModelDownloadDialog's `busy` block. Batch export reports only `{done}/{total} exported · N failed` (ExportPanel.tsx:489-495) with no per-clip progress (`batch-export.ts:88 onClipProgress?` is never passed), no per-clip error text, and no 'Open folder' at the end.

## Desired behavior

A persistent status strip / job tray in the title bar listing every running and queued job with kind, stage, percent, and a per-job Cancel — visible from any view. A native OS notification plus dock badge on completion so the user can genuinely walk away. Batch export gets per-clip rows and a 'Reveal folder' at the end.

## Competitor precedent

OpusClip's 'we'll email you' promise (conclusionActions with EMAIL/webhook) — the desktop-native equivalent is a notification + dock badge, which is strictly better delivery of the same promise. LokaClip renders concurrent renders as a visible queue.

## Implementation sketch

The plumbing already exists and is dead code — wire it. Have import-controller, ExportPanel and ModelDownloadDialog all route through `useJob` (useJob.ts:210) so `uiStore.tasks` (uiStore.ts:29) is populated, then build `components/JobTray.tsx` reading that map and mount it in App.tsx's title bar. Add a `system:notify` channel calling Electron `Notification` + `app.dock.setBadge` on terminal `done`. For batch, pass `onClipProgress` through `batch-export.ts:88` and keep failure messages per clip instead of only counting them.

## Sizing

Impact: **high** · Effort: **medium**

## Provenance

Found by a multi-agent sweep of the codebase cross-referenced against OpusClip, Kapwing AI Clip Maker, LokaClip, yt-short-clipper and SupoClip. Every `file:line` above was read directly from the source tree.

## Done

The registry + the persistent bar landed with FEAT-vh2bwz (the spine). This
ticket finished the surface.

**Batch export has rows again.** `onClipProgress` had existed on
`runBatchExport` since it was written and was never passed. Each clip is now a
child task under the batch parent, so ten concurrent encodes show per-clip
progress and — the part that mattered — the per-clip FAILURE MESSAGE. "3 failed"
cannot be acted on; "clip-4: No space left on device" can. The parent settles
with a Reveal pointed at the first exported FILE rather than the folder, because
the main handler reveals a path inside its parent and handing it the directory
would open the directory's parent.

**Native completion delivery.** New `SYSTEM_NOTIFY` channel (additive to the
frozen `channels.ts`; `buildNamespace('system')` derives
`window.openclip.system.notify` at both type and runtime level, and
`preload-parity.spec` caught it immediately, which is the drift test doing its
job). The handler raises an Electron `Notification` and a dock badge.

Suppression is decided MAIN-SIDE, deliberately: only the main process knows
whether the window has focus, and notifying someone who is watching the bar
finish is noise. The dock badge clears on the next window focus — a badge that
outlives the user's attention is a stuck dot.

**Failures also toast.** `installJobNotifications` subscribes terminal
transitions and raises a `sonner` toast with a Retry action on failure. Successes
do NOT toast: the bar already showed them, and a toast per finished job is how
notification fatigue starts. Cancellations announce nothing at all — the user did
that themselves, seconds ago.

An id-keyed guard means a task announces once: settled tasks stay in the map
until dismissed, so without it every later store tick would re-fire. Child rows
are skipped so a batch announces once rather than once per clip.
