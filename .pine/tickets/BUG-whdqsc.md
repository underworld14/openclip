---
id: BUG-whdqsc
title: Raw ffmpeg and whisper stderr reaches the user — up to 2000 characters in a toast and an OS notification
status: done
priority: high
labels:
    - copy
parent: EPIC-k83ghw
phase: p1
created: "2026-08-15T11:28:11Z"
updated: "2026-08-15T14:05:50Z"
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
- [x] A full disk during export produces a plain-language message
- [x] No user-facing toast or notification contains raw stderr by default
- [x] Error codes are not prefixed onto user-facing text

## Resolution
- `main/services/sidecar-errors.ts` (new): `describeSidecarFailure(err)` — the sidecar-side
  companion to `ai-errors.humanTransportError`. Classifies disk-full, permission/read-only,
  unplugged-volume/IO, missing-input, out-of-memory (newly wires the previously-dead
  `OUT_OF_MEMORY` job code), codec/format failure, hardware-encoder failure, and the yt-dlp
  cases from the scope note (403, 429, video unavailable, private, age-restricted, network)
  to plain sentences. An unrecognised shape gets a short GENERIC fallback with NO raw text
  at all — deliberately not "quote the raw message" like the provider-error classifier,
  since ffmpeg/whisper stderr is internal logging, not something worth relocating into a
  toast.
- `main/services/sidecar-manager.ts`: the generic per-job catch (the ONE place every
  unclassified runner throw — transcribe, export, extract-audio, url-download,
  model-download — already funnelled through) now runs the error through
  `describeSidecarFailure` before emitting the terminal event. `generate-clips` is
  unaffected — it already throws a classified `JobError` via
  `ai-errors.describeProviderFailure`, checked first.
- `components/jobStatus.ts`: new `stripJobErrorPrefix(message)` removes `drainJob`'s
  internal `` `${kind} failed [${code}]:` `` prefix. `isCancellation` is untouched — it
  keeps sniffing the bracket on the ORIGINAL thrown error, before this runs — so cancel
  detection and prefix-stripping don't collide. Wired at every user-facing consumer of a
  job-plane error: `import-controller.ts`'s `asMessage`, `jobsStore.ts`'s `trackTask`,
  `batch-export.ts`'s per-clip catch, `ExportPanel.tsx`'s single-export catch,
  `clipsSlice.ts`'s `generateError`, `model-download.ts`'s `onError` (covers all 3 of its
  callers: App.tsx, TranscriptionSettings, ModelDownloadDialog).

## Scope note follow-through
The screenshot behind this ticket's scope note (`url-download failed [SIDECAR_CRASH]:
unable to download video data: HTTP Error 403: Forbidden`, duplicated in the status bar)
is now: "This video refused the download. It may be region-locked, private, or the
platform is temporarily blocking automated downloads." — no prefix, no HTTP jargon, one
row (the duplicate-row half of that screenshot was BUG-w2jv3w, already fixed earlier in
this epic).

## Verification
- `tests/unit/sidecar-errors.spec.ts` (15 tests): every named failure class, including the
  EXACT reproduced 403 text; the generic fallback proven to never contain "libx264" or
  "exited with code"; a non-Error thrown value doesn't crash the classifier.
- `tests/unit/sidecar-manager.spec.ts`: new integration test — a raw
  `ffmpeg exited with code 1\n[libx264...]...No space left on device` throw from a
  registered runner, driven through the REAL `SidecarManager.startJob` over a real port,
  arrives at the terminal event already classified (`SIDECAR_CRASH`, "Your disk is full…"),
  never the raw stderr.
- `tests/unit/job-status.spec.ts`: new `stripJobErrorPrefix` tests (removes the prefix;
  leaves a non-job-plane message unchanged).
- Full suite unaffected otherwise (no test asserted on the OLD raw/prefixed shape) —
  `npm run typecheck` (all 4), `npm run lint`, `npm test`: 1549 passed / 10 skipped, run
  twice for determinism, clean.
- **Live, against the real packaged app**: drove the REAL `jobsStore` (a plain module, not
  behind contextBridge) to settle a `url-download` task with exactly the message this
  pipeline now produces for the reproduced 403 case. Screenshot: both the status-bar row
  and the toast show the plain sentence, with no `[SIDECAR_CRASH]` prefix and no `HTTP
  Error`/`403` jargon anywhere on screen.

## Scope note (added)
Confirmed the same raw-message path also carries **yt-dlp** failures, not just
ffmpeg/whisper: `url-download failed [SIDECAR_CRASH]: unable to download video
data: HTTP Error 403: Forbidden` reached the status bar verbatim (live
screenshot). `src/main/services/url-download.ts:ytdlpErrorMessage` already
extracts the real yt-dlp `ERROR:` line (good), but that extracted line is
still yt-dlp's own technical wording, then re-wrapped in the generic
`${kind} failed [${code}]:` prefix by `useJob.ts:160`. The classifier this
ticket adds must also map common yt-dlp failure lines (403/429 rate-limited,
"Video unavailable", "Private video", "Sign in to confirm your age",
network/DNS) to plain sentences, in addition to ffmpeg/whisper.

## Work Evidence

Closed by `pine close --evidence` on 2026-08-15.

- Base: `216f85f1` (last commit at or before ticket created 2026-08-15)
- Commits (2):
  - `6f7d338c` — fix(data-integrity): project-scope job writes, preserve clips on regenerate, close project-lifecycle gaps (BUG-93txd0, BUG-vv87d6, BUG-tdgtfb, BUG-5jwaxf, BUG-4c3gj3, FEAT-vz5vya, BUG-w2jv3w)
  - `0ab7f99d` — chore(pine): file the production-readiness & UX audit (EPIC-k83ghw)
- Files changed (base → working tree):

```
 .pine/MEMORY.md                                    |   2 +
 .pine/memory/renderer.md                           |   4 +-
 .pine/memory/testing.md                            |   3 +-
 .pine/tickets/BUG-08sb0x.md                        |  36 +++
 .pine/tickets/BUG-12bxbk.md                        |  33 +++
 .pine/tickets/BUG-15cddx.md                        | 138 ++++++++++
 .pine/tickets/BUG-1m642d.md                        |  59 ++++
 .pine/tickets/BUG-44fgyv.md                        |  38 +++
 .pine/tickets/BUG-4c3gj3.md                        | 118 ++++++++
 .pine/tickets/BUG-5jwaxf.md                        | 118 ++++++++
 .pine/tickets/BUG-8kgcxs.md                        | 129 +++++++++
 .pine/tickets/BUG-93txd0.md                        | 126 +++++++++
 .pine/tickets/BUG-9v667j.md                        | 128 +++++++++
 .pine/tickets/BUG-adfj3b.md                        | 119 +++++++++
 .pine/tickets/BUG-aryvgg.md                        | 214 +++++++++++++++
 .pine/tickets/BUG-bxqmex.md                        | 134 ++++++++++
 .pine/tickets/BUG-fcg251.md                        | 119 +++++++++
 .pine/tickets/BUG-gasxqq.md                        | 122 +++++++++
 .pine/tickets/BUG-hfwbeb.md                        | 133 +++++++++
 .pine/tickets/BUG-hkmsng.md                        |  34 +++
 .pine/tickets/BUG-hqbett.md                        |  40 +++
 .pine/tickets/BUG-phta04.md                        | 127 +++++++++
 .pine/tickets/BUG-prkcq1.md                        |  33 +++
 .pine/tickets/BUG-qcvhcn.md                        |  44 +++
 .pine/tickets/BUG-sg6kqg.md                        | 203 ++++++++++++++
 .pine/tickets/BUG-t19z5j.md                        | 186 +++++++++++++
 .pine/tickets/BUG-tdgtfb.md                        | 125 +++++++++
 .pine/tickets/BUG-vv87d6.md                        | 120 +++++++++
 .pine/tickets/BUG-w2jv3w.md                        | 106 ++++++++
 .pine/tickets/BUG-whdqsc.md                        | 105 ++++++++
 .pine/tickets/BUG-y9km1j.md                        |  60 +++++
 .pine/tickets/EPIC-k83ghw.md                       |  66 +++++
 .pine/tickets/FEAT-azvb5c.md                       |  57 ++++
 .pine/tickets/FEAT-rmgkee.md                       |  51 ++++
 .pine/tickets/FEAT-vz5vya.md                       | 118 ++++++++
 .pine/tickets/FEAT-x9femg.md                       | 125 +++++++++
 README.md                                          |  45 +++-
 package-lock.json                                  | 100 ++++++-
 package.json                                       |   1 +
 src/main/index.ts                                  | 120 ++++++++-
 src/main/ipc/audio.ts                              |  50 ++--
 src/main/ipc/job-start-validation.ts               |  13 +-
 src/main/ipc/media.ts                              |  15 +-
 src/main/ipc/system.ts                             |  20 +-
 src/main/ipc/video.ts                              |   8 +-
 src/main/menu.ts                                   |  24 +-
 src/main/services/ffmpeg-extract.ts                |   6 +
 src/main/services/jobs/extract-audio-runner.ts     |  93 +++++++
 src/main/services/media-store.ts                   |  29 ++
 src/main/services/sidecar-manager.ts               |  54 +++-
 src/main/services/updater.ts                       |  59 ++++
 src/main/utils/ffprobe.ts                          |  26 +-
 src/preload/api/audio.ts                           |  12 -
 src/preload/index.ts                               |   4 -
 src/renderer/src/App.tsx                           | 130 +++++++--
 src/renderer/src/assets/index.css                  |  36 +++
 src/renderer/src/components/ErrorBoundary.tsx      |  86 ++++++
 src/renderer/src/components/ExportPanel.tsx        |  30 ++-
 .../src/components/GeneratePreflightDialog.tsx     |  39 ++-
 src/renderer/src/components/ImportPanel.tsx        |  28 +-
 src/renderer/src/components/PreviewPlayer.tsx      | 297 +++++++++++++++++++--
 src/renderer/src/components/Timeline.tsx           |  65 +++--
 src/renderer/src/components/batch-export.ts        |  42 ++-
 src/renderer/src/components/caption-css.ts         |  40 ++-
 src/renderer/src/components/import-pipeline.ts     |  90 ++++++-
 src/renderer/src/components/jobStatus.ts           |  15 ++
 src/renderer/src/components/model-download.ts      |   5 +-
 src/renderer/src/components/preview-crop.ts        |  49 +++-
 src/renderer/src/components/timeline-math.ts       |  57 ++++
 src/renderer/src/hooks/import-controller.ts        | 219 ++++++++++++++-
 src/renderer/src/hooks/useGlobalShortcuts.ts       |   9 +-
 src/renderer/src/hooks/useImportController.ts      |   9 +-
 src/renderer/src/hooks/useProject.ts               |  58 +++-
 src/renderer/src/main.tsx                          |   5 +-
 src/renderer/src/stores/jobsStore.ts               |  11 +-
 src/renderer/src/stores/projectStore/clipsSlice.ts | 110 ++++++--
 .../src/stores/projectStore/previewSlice.ts        |   8 +
 src/shared/channels.ts                             |  17 +-
 src/shared/jobs.ts                                 |  26 ++
 src/shared/schema.ts                               |  12 +-
 src/shared/shortcuts.ts                            |  32 +++
 tests/e2e/vertical-slice.e2e.spec.ts               |  78 +++++-
 tests/harness/renderer-env.ts                      |  25 ++
 tests/mocks/openclip.ts                            |  11 +-
 tests/unit/ai-stores.spec.ts                       |  25 +-
 tests/unit/app-menu.spec.ts                        |  23 ++
 tests/unit/batch-export.spec.ts                    |  62 +++++
 tests/unit/caption-css.spec.ts                     |  16 +-
 tests/unit/clip-reject-undo.spec.tsx               |  29 ++
 tests/unit/dialog-handlers.spec.ts                 |  10 +-
 tests/unit/error-boundary.spec.tsx                 |  64 +++++
 tests/unit/export-cancel.spec.tsx                  |  26 ++
 tests/unit/extract-audio-runner.spec.ts            | 100 +++++++
 tests/unit/ffprobe.spec.ts                         |  24 +-
 tests/unit/generate-preflight-dialog.spec.tsx      |  37 ++-
 tests/unit/global-shortcuts.spec.tsx               |  44 +++
 tests/unit/import-controller.spec.ts               |  16 +-
 tests/unit/import-pipeline.spec.ts                 |  93 ++++++-
 tests/unit/import-url.spec.ts                      |  35 ++-
 tests/unit/ipc-media.spec.ts                       |  25 +-
 tests/unit/job-start-validation.spec.ts            |  55 ++++
 tests/unit/job-status.spec.ts                      |  24 ++
 tests/unit/onboarding-handlers.spec.ts             |  58 +++-
 tests/unit/preload-parity.spec.ts                  |   6 +-
 tests/unit/preview-crop.spec.ts                    |  72 ++++-
 tests/unit/preview-fitmode.spec.tsx                | 201 ++++++++++++++
 tests/unit/reframe-visibility.spec.tsx             |  15 +-
 tests/unit/shortcuts.spec.ts                       |  25 ++
 tests/unit/sidecar-manager.spec.ts                 |  63 +++++
 tests/unit/timeline-math.spec.ts                   |  80 ++++++
 tests/unit/updater.spec.ts                         |  88 ++++++
 tests/unit/use-project.spec.ts                     |  50 +++-
 112 files changed, 6759 insertions(+), 298 deletions(-)
```
