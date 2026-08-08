---
id: FEAT-5hnsby
title: forceCpu setting is severed from the encoder, and there is no GPU probe or CPU fallback
status: todo
priority: medium
labels:
    - perf
    - export
    - ffmpeg
parent: EPIC-c2gg45
created: "2026-08-08T15:58:26Z"
updated: "2026-08-08T15:58:26Z"
---

## Current behavior

PRD §14 promises: *"App probes capabilities at startup; Settings shows the active backend… All flows have a CPU fallback so the app always works."* None of it exists.

- **`forceCpu` is a severed setting.** It is declared in the schema (`src/shared/schema.ts:343`), defaulted in main (`src/main/ipc/settings.ts`) and in the renderer store (`settingsStore.ts:27`), and `codecArgs()` in `src/main/services/ffmpeg-export.ts:193-196` honours it — but it is **not a field of `JobParams['export']`**, so nothing ever passes it. `grep -rn forceCpu src/` finds only the declarations and the consumer, never a call site that connects them.
- **No capability probe.** `grep -rn "hwaccel|videotoolbox|nvenc|allow_sw" src` returns only the hard-coded encoder string at `ffmpeg-export.ts:196`.
- **No automatic fallback.** If `h264_videotoolbox` is unavailable or fails, there is no retry on `libx264`; the export just fails.

The `libx264 -preset medium -crf 18/23` path is fully written and unit-tested, and is exercised in the real-binary smoke — it works. It is simply unreachable from the UI.

## Why it matters

This is the difference between "the export failed" and "the export was slower". It also blocks cross-platform (PRD v0.2): `h264_videotoolbox` is macOS-only, so the encoder choice must become a decision rather than a constant before Windows/Linux is credible.

## Acceptance criteria

- [ ] `forceCpu` is added to `JobParams['export']` in `src/shared/jobs.ts` and threaded from the export slice through the runner into `codecArgs()`.
- [ ] A startup probe records which encoders the bundled ffmpeg actually offers (`ffmpeg -encoders`), cached for the session.
- [ ] An export that fails with a videotoolbox-specific error retries once on `libx264` and tells the user it fell back.
- [ ] Settings shows the active encoder backend and offers the "force CPU" toggle that already exists in the schema.

Note: the sibling claim that decode should also use `-hwaccel videotoolbox` was **tested and refuted** — it made 1080p exports ~2% slower. Do not add `-hwaccel` as part of this ticket. See `.pine/MEMORY.md`.
