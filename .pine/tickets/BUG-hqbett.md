---
id: BUG-hqbett
title: Test and E2E env overrides are honoured in the packaged app, and Electron fuses are left permissive
status: todo
priority: medium
labels:
    - security
parent: EPIC-k83ghw
phase: p2
created: "2026-08-15T11:28:11Z"
updated: "2026-08-15T11:28:11Z"
---

## Problem
Development affordances ship enabled in production.

## Evidence
- `OPENCLIP_FFMPEG`, `OPENCLIP_FFPROBE`, `OPENCLIP_WHISPER_CLI`, `OPENCLIP_FONTS_DIR` and
  the **fake-sidecar** switch are read in `src/main/utils/paths.ts` with **no
  `app.isPackaged` gate** — verified: they are the first branch in each resolver
  (`paths.ts:76,86,137,157,216`).
- Electron fuses are not flipped in the packaged build — `RunAsNode` and Node CLI/inspect
  are at their permissive defaults.
- `src/main/menu.ts` ships `{ role: 'toggleDevTools' }` in the production View menu.
- Project ids are interpolated into `.ocproj` paths without the single-segment check that
  `assertSafeProjectId` applies elsewhere (`paths.ts:329`).

## Impact
Anything that can set an environment variable for the app can redirect every sidecar to an
arbitrary executable, or switch the app into fake-sidecar mode.

## Fix
Gate all `OPENCLIP_*` overrides on `!app.isPackaged`, flip `RunAsNode` /
`EnableNodeCliInspectArguments` / `OnlyLoadAppFromAsar` fuses, and apply
`assertSafeProjectId` on the project-document path.

## Acceptance Criteria
- [ ] Env overrides are ignored in a packaged build
- [ ] Fuses are flipped in the release build
- [ ] The `.ocproj` path rejects a non-single-segment project id
