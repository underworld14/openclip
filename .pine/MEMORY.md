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
