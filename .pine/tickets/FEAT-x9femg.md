---
id: FEAT-x9femg
title: 'No auto-update: CHECK_UPDATE is a stub, electron-updater is absent, and bundled yt-dlp rots'
status: todo
priority: high
labels:
    - distribution
parent: EPIC-k83ghw
phase: p0
created: "2026-08-15T11:28:11Z"
updated: "2026-08-15T11:28:11Z"
---

## Problem
Once installed, the app can never update itself — and it bundles a component that breaks
on a schedule set by YouTube.

## Evidence
- `electron-updater` is not in `package.json` dependencies.
- `src/main/ipc/video.ts:232` — the `CHECK_UPDATE` handler unconditionally returns
  `{ updateAvailable: false }`; its own comment says "electron-updater is not wired yet".
- `grep -rn "checkUpdate" src/` — exposed on the bridge, **called by no UI**. There is no
  "Check for Updates…" menu item (`src/main/menu.ts`).
- `dist/latest-mac.yml` and `Contents/Resources/app-update.yml` **are** generated and point
  at `provider: github, owner: underworld14, repo: openclip` — a private repo, so even a
  wired updater would 404.
- Bundled yt-dlp is pinned at package time (`2026.03.17`, verified via
  `npm run verify:package`).

## Impact
When YouTube changes and yt-dlp breaks, URL import stops working for every installed user
with no recourse. There is also no way to ship a fix for anything else in this epic.

## Fix
Wire `electron-updater`, point `app-update.yml` at a public release feed, add a
"Check for Updates…" item to the app menu, and make the stub handler real.

## Acceptance Criteria
- [ ] A published release is offered to an older installed build
- [ ] `CHECK_UPDATE` reports real availability
- [ ] There is a user-reachable way to trigger an update check
