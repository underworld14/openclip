---
id: FEAT-azvb5c
title: Ship an installable release — today the only documented install path is git clone + npm
status: todo
priority: critical
labels:
    - distribution
parent: EPIC-k83ghw
phase: p0
created: "2026-08-15T11:28:11Z"
updated: "2026-08-15T11:28:11Z"
---

## Problem
The target user is a content creator who has never opened a terminal. There is nothing
for them to download.

## Evidence
- `gh repo view underworld14/openclip --json isPrivate` → `true`, **0 releases, 0 stars**.
- `README.md` calls the project open-source and gives
  `git clone https://github.com/underworld14/openclip.git` — a stranger gets a 404.
- `README.md:63` Quickstart prerequisites are "Node.js 20+ and npm"; the steps are
  `git clone && npm install && npm run dev`.
- No Releases link, no `.dmg` download, no install instructions anywhere in the repo.

## Impact
The persona the product is designed for cannot obtain it at all. Every other finding in
this epic is downstream of this one.

## Fix
Publish a GitHub release with the signed `.dmg` (or make the repo public and add a
Releases section). Rewrite the README Quickstart so step 1 is "download the .dmg",
and move the build-from-source instructions into a Contributing section.

## Acceptance Criteria
- [ ] A non-developer can download and run the app without Node.js or a terminal
- [ ] README's first install path is a download, not `git clone`
- [ ] The repo is reachable at the URL the README advertises
