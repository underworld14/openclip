---
id: BUG-whdqsc
title: Raw ffmpeg and whisper stderr reaches the user — up to 2000 characters in a toast and an OS notification
status: todo
priority: high
labels:
    - copy
parent: EPIC-k83ghw
phase: p1
created: "2026-08-15T11:28:11Z"
updated: "2026-08-15T11:28:11Z"
---

## Problem
`ai-errors.ts` humanises provider failures beautifully. The sidecar path has no equivalent.

## Evidence
- `src/main/services/ffmpeg-core.ts:190` — the failure carries an exit-code line plus a
  ~2 KB stderr tail.
- `src/renderer/src/hooks/useJob.ts:160` — that string is rendered verbatim in the failure
  toast and forwarded to the macOS notification.
- Messages are additionally prefixed with the raw job kind and error code, e.g.
  `export failed [SIDECAR_CRASH]: ffmpeg exited with code 1` and
  `url-download failed [SIDECAR_CRASH]: …`.

## Impact
The most likely failure of the app's core action greets a content creator with a wall of
`[libx264 @ 0x…]` log text. The one actionable phrase — "No space left on device" — is
buried in the middle of it.

## Fix
Add a sidecar-error classifier mirroring `ai-errors.humanTransportError`: map disk-full,
read-only destination, missing/moved input, unplugged volume, codec failure and
cancellation to plain sentences. Keep the raw tail behind a "Details" disclosure. Drop the
`kind failed [CODE]:` prefix from user-facing strings.

## Acceptance Criteria
- [ ] A full disk during export produces a plain-language message
- [ ] No user-facing toast or notification contains raw stderr by default
- [ ] Error codes are not prefixed onto user-facing text
