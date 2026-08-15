---
id: BUG-45xt77
title: 'Whisper model downloads: only tiny verifiable, turbo 404s, and downloading destroys the installed model'
status: done
priority: medium
created: "2026-08-15T10:47:56Z"
updated: "2026-08-15T10:47:56Z"
---

# Description

Four defects found by testing the packaged app, each with a proven root cause.

1. **Only `tiny` could be installed.** `downloadModel` took its expected hash from the
   `x-linked-etag` header, but that header exists ONLY on HuggingFace's 302 redirect;
   `fetch` follows redirects by default, so the headers a caller sees are the CDN's
   (which send a Xet `etag` that is not a sha256). `KNOWN_SHA256` pinned only `tiny`, so
   `base`/`small`/`medium`/`large-v3` downloaded in full and were then refused as
   unverifiable. Reproduced with `curl -D -`.
2. **`turbo` could never install** — `modelUrl('turbo')` built `ggml-turbo.bin` (404);
   the published asset is `ggml-large-v3-turbo.bin`. Offered in the UI regardless.
3. **Downloading destroyed the model you already had.** `dest` WAS the final path, so
   `createWriteStream` truncated an installed model on open, and all six failure paths
   `rmSync`d it — reachable from Cancel, Escape, backdrop, renderer reload and app quit.
   This is why an installed `base` (148 MB) vanished and left an empty models dir.
4. **The picker re-asked an answered question, and dismissing it killed the download.**
   All three entry points already carried a concrete model into `initialModel`;
   `dismiss()` called `jobs.cancel` on every exit; and both dialogs are Radix `modal`,
   so the status bar was visible but click-inert underneath.

# Acceptance Criteria
- [x] Every offered model installs and verifies
- [x] `turbo` resolves to the file that actually exists
- [x] An installed model survives a failed/cancelled/quit-interrupted download
- [x] Downloading a model you already have is a no-op, not a demolition
- [x] A truncated file no longer reports as "Installed"
- [x] Settings row / readiness chip download directly — no second prompt
- [x] Dismissing the gate dialog leaves the transfer running; cancel is explicit
- [x] The status bar is usable while a dialog is open
- [x] A failed download offers Retry

# Implementation Plan

Full plan: `~/.claude/plans/please-plan-to-support-drifting-blanket.md`

# Verification

- `npm run typecheck` / `npm run lint` clean; `npm test` 1457 passed.
- 11 new safety tests + 7 new UX tests, each written FIRST and confirmed failing
  against the old code (8 of them reproduced the exact production symptoms).
- `OPENCLIP_CHECK_MODEL_URLS=1` smoke: all six URLs return 302 and their published
  `x-linked-etag`/`x-linked-size` match the pinned manifest exactly.
- REAL 148 MB download of `base` from HuggingFace: completed, hash-verified, and a
  second download over the installed file was a no-op that preserved the bytes.

# Notes

Authoritative values, cross-verified from the HF API (`lfs.oid`) and a `curl` 302 probe:
tiny 77,691,713 / base 147,951,465 / small 487,601,967 / medium 1,533,763,059 /
turbo (large-v3-turbo) 1,624,555,275 / large-v3 3,095,033,483.

The existing suite PINNED the destructive behaviour: every failure case asserted
`existsSync(dest) === false` while running against an empty temp dir, so
"download over an existing install" was invisible. The etag test synthesised a
header a redirect-following fetch never produces.

Deliberately NOT done (user decision): HTTP Range resume. A cancelled 3 GB download
still restarts from zero — but nothing you already have is ever lost.

# Related Files
- src/main/services/model-manager.ts
- src/renderer/src/components/model-download.ts
- src/renderer/src/components/TranscriptionSettings.tsx
- src/renderer/src/components/ModelDownloadDialog.tsx
- src/renderer/src/components/JobStatusBar.tsx
- src/renderer/src/App.tsx

# Attachments
