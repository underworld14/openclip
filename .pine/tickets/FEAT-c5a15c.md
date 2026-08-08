---
id: FEAT-c5a15c
title: 'No first-run preflight: nothing tells the user they need an API key, a model id, or a whisper model until it fails'
status: todo
priority: critical
labels:
    - ux
    - onboarding
parent: EPIC-xzzpty
created: "2026-08-08T15:56:46Z"
updated: "2026-08-08T15:56:46Z"
---

## Current behavior

Welcome.tsx:22-63 renders only a hero + ImportPanel + recents — no setup step, no status, no requirements. 'Auto Generate Clips' is enabled on transcript presence alone (App.tsx:148-157: `disabled={!hasTranscript || generating}`) with no key/model guard; `grep -rn hasKey src/renderer/src/components` finds it only inside SettingsPanel's own status label (settingsView.ts:27). There is no capability probe in main either (`grep -nE "probe|gpu|encoder" src/main/index.ts` finds only the reframe ONNX diagnostic).

## Desired behavior

A persistent readiness strip in the title bar with clickable chips: 'Transcription model: base ✓ / not installed', 'AI provider: OpenAI · key set ✓ / no key', 'FFmpeg ✓'. Each chip deep-links to the exact settings pane that fixes it. 'Auto Generate Clips' stays disabled with a tooltip naming the missing piece rather than firing a doomed request. On first launch the Welcome card shows the same three rows as a green-check checklist.

## Competitor precedent

YT-Short-Clipper (jipraks) puts two persistent status chips ('Library', 'API') in the header, red on a fresh install, each clickable straight into its fix-it page, and keeps the primary 'Find Highlights' button greyed until URL + libs + API are all valid. autoclip ships a `doctor` diagnostics command for the same purpose.

## Implementation sketch

New `src/renderer/src/components/ReadinessBar.tsx` + a pure `readinessView.ts` view-model. Data sources already exist: `window.openclip.model.status({model})` (used by import-controller.ts:172-179), `settingsStore.keyStatus` ({provider,hasKey,last4}), and `settings.model`. Add a `system:preflight` channel in `src/shared/channels.ts` returning `{ffmpeg,ffprobe,whisperCli,onnx}` resolved from `src/main/utils/paths.ts` (which already resolves every binary — it just never reports the result). Mount the bar in App.tsx next to the gear icon; gate the generate button on `readiness.canGenerate`.

## Sizing

Impact: **critical** · Effort: **medium**

## Provenance

Found by a multi-agent sweep of the codebase cross-referenced against OpusClip, Kapwing AI Clip Maker, LokaClip, yt-short-clipper and SupoClip. Every `file:line` above was read directly from the source tree.
