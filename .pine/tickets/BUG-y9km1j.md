---
id: BUG-y9km1j
title: The shipped .dmg is adhoc-signed — Gatekeeper rejects it and nothing documents the workaround
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
The `.dmg` that exists today cannot be opened by a normal user.

## Evidence
```
$ codesign -dv --verbose=2 dist/mac-arm64/OpenClip.app
Signature=adhoc
TeamIdentifier=not set
Sealed Resources=none

$ spctl -a -vvv -t install dist/mac-arm64/OpenClip.app
dist/mac-arm64/OpenClip.app: code has no resources but signature indicates they must be present
```
- `grep -i "gatekeeper|xattr|quarantine|damaged|Open Anyway" README.md` → **zero hits**.

## Impact
Double-clicking gives "OpenClip is damaged and can't be opened" or "the developer cannot
be verified". The persona has no way past this, and the repo never mentions it.

## Fix
Ship via the signed+notarized path (`npm run build:mac` + `build/notarize.cjs`, which
already exists and is gated on Apple creds). Until that is wired into a release job,
document the `xattr -dr com.apple.quarantine` escape hatch for unsigned builds.

## Acceptance Criteria
- [ ] The released artifact passes `spctl -a -t install`
- [ ] `codesign -dv` reports a real Team ID, not `adhoc`
- [ ] README documents what a user sees on first launch and how to proceed
