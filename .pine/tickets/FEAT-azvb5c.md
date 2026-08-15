---
id: FEAT-azvb5c
title: Ship an installable release — today the only documented install path is git clone + npm
status: done
priority: critical
labels:
    - distribution
parent: EPIC-k83ghw
phase: p0
created: "2026-08-15T11:28:11Z"
updated: "2026-08-15T15:11:16Z"
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
- [x] A non-developer can download and run the app without Node.js or a terminal
- [x] README's first install path is a download, not `git clone`
- [x] The repo is reachable at the URL the README advertises

## Progress

Done (earlier this session):
- README Quickstart led with an honest callout: no pre-built download
  exists yet, and pointed at the build-from-source steps + the new
  "Distributing a built app" section instead of silently implying `git
  clone` is the only intended path forever.
- `electron-updater` fully wired (FEAT-x9femg) and ready to check against a
  real release feed the moment one exists.

Done (this session, follow-up — the repo's visibility changed): re-checked
`gh repo view underworld14/openclip --json isPrivate` and found it now
**`false`** (public) — the repo-visibility half of this ticket's blocker,
which was a business decision not mine to make, has been resolved outside
this session. With that unblocked:
- Confirmed with the user before publishing anything externally (a GitHub
  Release is a visible, semi-permanent, external action).
- Built `openclip-desktop-2.0.0-arm64.dmg` (`npm run build:mac:unsigned`,
  no Apple credentials needed), verified it (`scripts/verify-package.mjs`),
  tagged `v2.0.0`, and published it as a real GitHub Release with the
  Gatekeeper workaround (BUG-y9km1j) given top billing in the release notes:
  https://github.com/underworld14/openclip/releases/tag/v2.0.0
- Rewrote the README Quickstart: step 1 is now "download the .dmg from
  Releases", with the Gatekeeper warning called out immediately below it;
  build-from-source moved to a secondary path pointing at
  `CONTRIBUTING.md`. The "Distributing a built app" section and the stale
  "no auto-update feed until a release exists" note were both updated to
  match the now-real release.
- Added `electron-builder.yml`'s `publish: {provider: github}` block so a
  packaged build's `app-update.yml` points electron-updater at the real
  feed — confirmed via context7 (electron-builder v26.8.1, this repo's
  version) that a `publish:` config alone does not trigger an upload without
  an explicit `--publish` flag or CI/token context, neither of which this
  repo's build scripts or environment set; publishing stays the explicit
  `gh release create` step taken above, never a build side effect.

A non-developer's actual path is now: download → drag to Applications →
right-click → Open past the (expected, documented) Gatekeeper warning — no
Node.js, no npm, no terminal required (the `xattr` command remains an
alternative, not a requirement).

Not fully resolved, and correctly so — tracked separately in BUG-y9km1j: the
release is adhoc-signed, not signed-and-notarized, because that requires an
Apple Developer account's credentials only the project owner has. That
ticket stays open for exactly that reason; this one's own acceptance
criteria (download path, README, repo reachability) are all now genuinely
met.

## Work Evidence

Closed by `pine close --evidence` on 2026-08-15.

- Base: `216f85f1` (last commit at or before ticket created 2026-08-15)
- Commits (4):
  - `e8e653be` — docs+build(release): lead the Quickstart with a download, wire the update feed (FEAT-azvb5c)
  - `7635b7de` — chore(pine): close 11 completed p0 tickets with evidence
  - `267155a8` — docs(readme): honest install path, Gatekeeper workaround for unsigned builds (BUG-y9km1j, FEAT-azvb5c)
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
 .pine/tickets/BUG-hkmsng.md                        | 209 +++++++++++++++
 .pine/tickets/BUG-hqbett.md                        |  40 +++
 .pine/tickets/BUG-phta04.md                        | 127 +++++++++
 .pine/tickets/BUG-prkcq1.md                        |  33 +++
 .pine/tickets/BUG-qcvhcn.md                        |  44 +++
 .pine/tickets/BUG-sg6kqg.md                        | 203 ++++++++++++++
 .pine/tickets/BUG-t19z5j.md                        | 186 +++++++++++++
 .pine/tickets/BUG-tdgtfb.md                        | 125 +++++++++
 .pine/tickets/BUG-vv87d6.md                        | 120 +++++++++
 .pine/tickets/BUG-w2jv3w.md                        | 106 ++++++++
 .pine/tickets/BUG-whdqsc.md                        | 231 ++++++++++++++++
 .pine/tickets/BUG-y9km1j.md                        |  73 +++++
 .pine/tickets/EPIC-k83ghw.md                       |  66 +++++
 .pine/tickets/FEAT-azvb5c.md                       |  86 ++++++
 .pine/tickets/FEAT-rmgkee.md                       | 234 ++++++++++++++++
 .pine/tickets/FEAT-vz5vya.md                       | 118 ++++++++
 .pine/tickets/FEAT-x9femg.md                       | 125 +++++++++
 README.md                                          |  61 ++++-
 electron-builder.yml                               |  19 +-
 package-lock.json                                  | 100 ++++++-
 package.json                                       |   1 +
 src/main/index.ts                                  | 120 ++++++++-
 src/main/ipc/audio.ts                              |  50 ++--
 src/main/ipc/job-start-validation.ts               |  13 +-
 src/main/ipc/media.ts                              |  15 +-
 src/main/ipc/system.ts                             |  20 +-
 src/main/ipc/video.ts                              |   8 +-
 src/main/menu.ts                                   |  24 +-
 src/main/services/ai-client.ts                     |  26 +-
 src/main/services/ffmpeg-extract.ts                |   6 +
 src/main/services/jobs/extract-audio-runner.ts     |  93 +++++++
 src/main/services/jobs/generate-clips-runner.ts    |  26 ++
 src/main/services/media-store.ts                   |  29 ++
 src/main/services/sidecar-errors.ts                | 172 ++++++++++++
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
 src/renderer/src/components/SettingsPanel.tsx      | 121 +++++++--
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
 src/renderer/src/stores/projectStore/clipsSlice.ts | 121 +++++++--
 .../src/stores/projectStore/previewSlice.ts        |   8 +
 src/shared/ai-providers.ts                         |  39 +++
 src/shared/channels.ts                             |  17 +-
 src/shared/jobs.ts                                 |  26 ++
 src/shared/schema.ts                               |  12 +-
 src/shared/shortcuts.ts                            |  32 +++
 tests/e2e/vertical-slice.e2e.spec.ts               |  78 +++++-
 tests/harness/renderer-env.ts                      |  25 ++
 tests/mocks/openclip.ts                            |  11 +-
 tests/unit/ai-mapreduce.spec.ts                    |  75 ++++++
 tests/unit/ai-providers-meta.spec.ts               |  49 ++++
 tests/unit/ai-stores.spec.ts                       |  93 ++++++-
 tests/unit/app-menu.spec.ts                        |  23 ++
 tests/unit/batch-export.spec.ts                    |  62 +++++
 tests/unit/caption-css.spec.ts                     |  16 +-
 tests/unit/clip-reject-undo.spec.tsx               |  29 ++
 tests/unit/dialog-handlers.spec.ts                 |  10 +-
 tests/unit/error-boundary.spec.tsx                 |  64 +++++
 tests/unit/export-cancel.spec.tsx                  |  26 ++
 tests/unit/extract-audio-runner.spec.ts            | 100 +++++++
 tests/unit/ffprobe.spec.ts                         |  24 +-
 tests/unit/generate-clips-runner.spec.ts           |  87 ++++++
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
 tests/unit/settings-panel-copy.spec.tsx            | 120 +++++++++
 tests/unit/settings-tabs.spec.tsx                  |   4 +-
 tests/unit/shortcuts.spec.ts                       |  25 ++
 tests/unit/sidecar-errors.spec.ts                  | 142 ++++++++++
 tests/unit/sidecar-manager.spec.ts                 |  63 +++++
 tests/unit/timeline-math.spec.ts                   |  80 ++++++
 tests/unit/updater.spec.ts                         |  88 ++++++
 tests/unit/use-project.spec.ts                     |  50 +++-
 124 files changed, 8211 insertions(+), 347 deletions(-)
```
