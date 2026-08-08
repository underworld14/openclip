---
id: FEAT-1k76hk
title: Whisper model management is invisible, and the persisted whisperModel setting is ignored
status: todo
priority: medium
labels:
    - ux
    - models
parent: EPIC-xzzpty
created: "2026-08-08T15:56:46Z"
updated: "2026-08-08T15:56:46Z"
---

## Current behavior

`settingsStore.ts:22 whisperModel: 'base'` exists in the schema and the store, but SettingsPanel.tsx contains no whisper control at all (grepping the file for 'whisper' matches only the language help copy at :404). Meanwhile import-controller.ts:38 hardcodes `const DEFAULT_MODEL: WhisperModelSize = 'base'` and :137 resolves `deps.model ?? DEFAULT_MODEL` — the user's setting is never read. So a user who downloads `large-v3` gets `base` transcription anyway, and there is no way to see installed models, switch models, or reclaim the multiple gigabytes they occupy.

## Desired behavior

A Transcription section in Settings: a row per model with size, speed/accuracy, an Installed/Download badge, a Delete button to free disk, and a radio to select the active one — which the import path actually honors. Show total disk used by models and by the WAV cache.

## Competitor precedent

YT-Short-Clipper's Library page lists each dependency with per-item status and a one-click Download, flipping to 'Installed'. LokaClip surfaces storage management showing disk usage with a cache-clear button.

## Implementation sketch

Reuse `WHISPER_MODEL_TABLE` from ModelDownloadDialog.tsx into a new `components/TranscriptionSettings.tsx` mounted in SettingsPanel. Data comes from the existing `model.status({model})` bridge call (used at import-controller.ts:173) — widen it to return size-on-disk. Add a `MODEL_DELETE` channel in channels.ts backed by `model-manager.ts`. Critically, change import-controller.ts:137 to read `settings.whisperModel` instead of the hardcoded `DEFAULT_MODEL`. Note model-manager.ts also has no resume (:109 deletes the partial on cancel) — worth pairing, since restarting a 2.9GB download from zero is the other half of this pain.

## Sizing

Impact: **medium** · Effort: **medium**

## Provenance

Found by a multi-agent sweep of the codebase cross-referenced against OpusClip, Kapwing AI Clip Maker, LokaClip, yt-short-clipper and SupoClip. Every `file:line` above was read directly from the source tree.
