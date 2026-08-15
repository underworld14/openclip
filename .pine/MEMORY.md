# Project memory

Stable preferences, conventions, and rules for this repository.
Agents: prefer appending here (or a topic under memory/) over creating new LRN-* files.
Ticket-scoped one-shots still use `pine learn --scope ticket`.

## Preferences

## Conventions

## Gotchas

## Log
- 2026-08-14: A live probe of the packaged app catches wiring gaps that green unit tests, typecheck and lint all miss — twice in one run a feature was fully implemented and tested with the final render never wired up (the clip poster <img> was never added to ClipCard; the plain -vf export path never passed fitMode through). Drive the built app with Playwright and MEASURE the result before calling a UI feature done.
- 2026-08-14: window.openclip is frozen by contextBridge, so a Playwright probe cannot stub bridge methods from inside the renderer — the assignment silently does nothing. Stub at the main-process boundary (env overrides like OPENCLIP_FFMPEG) or assert against the real IPC.
- 2026-08-15: A provider/enum list hand-copied out of Zod (job-start-validation.AI_PROVIDERS) compiles fine while rejecting every job for a newly added member at runtime — and generate-clips params had no test at all. Derive from AIProvider.options. The enum's real tripwires, which a new member SHOULD hit at compile time, are createTransport's 'const exhaustive: never' and settingsView's total PROVIDER_LABELS Record.
- 2026-08-15: Download straight to the FINAL path and every failure path becomes a destructor: createWriteStream truncates an existing file on open, so 'start a download' destroyed an installed 148 MB model before a byte was verified, and cleanup() then deleted it — reachable from cancel, Escape, backdrop, renderer reload and app quit. Always temp+rename (url-download.ts, ffmpeg-export.ts, project-store.ts already did). The tests missed it because every failure case asserted existsSync(dest)===false against a FRESH EMPTY temp dir — seed the pre-existing state or the test proves nothing.
- 2026-08-15: utils/paths.ts does NOT throw for a missing binary in the packaged branch — ffmpegPath/ffprobePath/whisperCliPath/ytDlpPath each end in an unconditional join(process.resourcesPath, ...). ipc/system.ts probe() only maps a throw or empty string to {ok:false}, and its comment claiming 'paths.ts throws' is wrong, so the readiness bar can never go red for a damaged install (BUG-phta04).
- 2026-08-15: Single-clip and batch export build ffmpeg params from DIFFERENT sources: ExportPanel passes project.settings (fitMode) + reframe + project captionTemplateId; batch-export.ts uses opts.preset.captionTemplateId and settings:{aspectRatio} only. Thread any new export option through BOTH or batch output silently diverges from the preview (BUG-15cddx).
