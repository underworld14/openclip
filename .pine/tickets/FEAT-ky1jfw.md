---
id: FEAT-ky1jfw
title: Mid-transcribe the whole screen swaps, destroying the progress bar, Cancel, and the only error surface
status: done
priority: critical
labels:
    - ux
    - jobs
    - bug
deps:
    - FEAT-vh2bwz
parent: EPIC-zpa1nd
created: "2026-08-08T15:56:46Z"
updated: "2026-08-09T03:57:41Z"
---

## Current behavior

App.tsx:56 `const showEditor = hasSource || hasTranscript || hasClips`, where `hasTranscript` (App.tsx:54) counts `transcript.segments.length > 0`. Transcript segments arrive as streamed job partials (transcribe-runner.ts:113-115 `emit.partial({words, segments})`), so the first closed sentence — not any user action — unmounts Welcome→ImportPanel, which owns the only progress bar (ImportPanel.tsx:96), Cancel (ImportPanel.tsx:105) and error slot (ImportPanel.tsx:115). The controller lives in a `useMemo([])` with no teardown (useImportController.ts), so the promise chain keeps running and writes state to a subscriber nobody renders. A transcribe failure at 80% is therefore completely silent.

## Desired behavior

Progress, stage, cancel, and error must be owned by app-level chrome that survives the layout switch. Either keep the user on Welcome until the transcribe job emits `done`, or (better) hoist a persistent progress strip into the title bar/status bar that renders for any active job regardless of which view is mounted.

## Competitor precedent

OpusClip's project stage machine (IMPORT→CURATE→REFINE→RENDER) is dashboard-level state you can navigate away from and back to; completion arrives by email/webhook. Kapwing's processing view is a page you own until it finishes.

## Verified in the real built app

Confirmed with high confidence by an adversarial verifier driving a real Electron run.
The observed sequence for a first-run import: for ~1-2 s the user sees a progress bar, a
stage label and a Cancel button. The moment whisper closes its first sentence — roughly 1%
of the way into a 10-minute transcription — the Welcome screen unmounts and takes the
progress bar, the Cancel button and the only error surface with it.

Because `useImportController` builds the controller in a `useMemo` with `[]` deps and has no
teardown, the async import work keeps running against an unmounted subscriber: a transcribe
failure at 80% sets an error nobody renders. **The failure is completely silent.**

## Implementation sketch

Two-part. (1) Change App.tsx:56 to `const showEditor = (hasSource || hasClips) && !importBusy` — or gate on an explicit `importComplete` flag the controller sets after `stage:'done'` (import-controller.ts sets `set({stage:'done'})` at the end of importFile). (2) Promote the import controller out of `useImportController`'s `useMemo` into a module-level singleton (or a Zustand slice) so state survives unmount, and render the progress/cancel/error row from App.tsx so it is present in both layouts. This also unblocks Gap #13 (global job surface).

## What was actually done

The sketch's part (2) — promoting the controller to a module singleton — had already
landed separately, so the in-flight state did survive unmount. What was still missing
was anything RENDERING it, and a layout rule that stopped fighting the import.

Rather than the sketch's `&& !importBusy` (which keeps the user staring at a Welcome
screen for ten minutes), the project is now committed at **probe** time:

1. `runImportPipeline` gained an awaited `onProbed(sourceVideo)`, fired right after
   ffprobe and before audio extraction.
2. The controller's commit block — flush-save the outgoing project, `hydrateProject`,
   `markCommitted`, `setView('editor')` — moved into that callback, unchanged in
   order. It used to run after `runImport` resolved, i.e. after transcription.
3. `App.showEditor` dropped `hasTranscript`. `hasSource` now flips about a second
   into an import (EARLIER than the old predicate, not later) and flips exactly once,
   on a real event, instead of mid-stream on a streamed partial.
4. Progress / stage / Cancel / error live in `JobStatusBar` (FEAT-vh2bwz), which is
   mounted between the title bar and the body and belongs to neither layout.

The user now watches the video and the transcript filling in live, instead of a bar.

### Consequences handled

- **Autosave storm.** `currentProject` used to be null during transcription, so the
  autosave subscriber short-circuited. With an early commit, every streamed partial
  changes the `transcript` ref — a full `.ocproj` write every debounce window for the
  whole transcription. `startAutosave` gained `isSuspended` + `resume()`;
  `installAutosave` suspends while `hasActiveKind('import')` and writes once when the
  import settles, so the terminal `hydrateTranscript` still reaches disk.
- **A cancelled/failed transcription now leaves a real project** holding a real video.
  That is the honest outcome — the import DID happen — and the media reclaim correctly
  does not fire, since the user can see the project.
- **`integration-wave1.e2e`** drove `runImportPipeline` directly and never committed a
  project, so it relied on the buggy `hasTranscript` gate; it now commits in `onProbed`
  like the controller does. Its `getByText('Hello world!')` also had to be scoped to
  the transcript list: the preview player is live during the import now, so the same
  words legitimately appear in the karaoke overlay too.

## Sizing

Impact: **critical** · Effort: **medium**

## Provenance

Found by a multi-agent sweep of the codebase cross-referenced against OpusClip, Kapwing AI Clip Maker, LokaClip, yt-short-clipper and SupoClip. Every `file:line` above was read directly from the source tree.

## Work Evidence

Closed by `pine close --evidence` on 2026-08-09.

- Base: `3ea7b027` (last commit at or before ticket created 2026-08-08)
- Commits (4):
  - `05e3a480` — fix(import): the editor arrives when the video does, not when whisper finishes (FEAT-ky1jfw)
  - `eb1be422` — fix(onboarding): address code review — two regressions plus readiness correctness
  - `02246459` — fix(onboarding): the model dialog is no longer a trap, and resumes your import (FEAT-kncqxf)
  - `3c7d68c2` — chore(pine): adopt pine issue tracking + file the multi-agent audit backlog
- Files changed (base → working tree):

```
 .agents/skills/pine/SKILL.md                       | 145 ++++++++++
 .claude/settings.json                              |  15 +-
 .claude/skills/pine/SKILL.md                       | 145 ++++++++++
 .codex/hooks.json                                  |  14 +
 .codex/hooks/pine-learn-reminder.sh                |   6 +
 .cursor/hooks.json                                 |  10 +
 .cursor/hooks/pine-learn-reminder.sh               |   6 +
 .github/ISSUE_TEMPLATE/bug_report.md               |  30 ++
 .github/ISSUE_TEMPLATE/feature_request.md          |  15 +
 .github/pull_request_template.md                   |  24 ++
 .github/workflows/ci.yml                           |  82 ++++++
 .pine/.gitignore                                   |   4 +
 .pine/MEMORY.md                                    |  13 +
 .pine/board.json                                   |   1 +
 .pine/config.json                                  |   1 +
 .pine/memory/competitor-precedent.md               |  10 +
 .pine/memory/perf-refuted.md                       |  11 +
 .pine/memory/renderer.md                           |   9 +
 .pine/prompts/fix.md                               |  22 ++
 .pine/templates/bug.md                             |  14 +
 .pine/templates/epic.md                            |   3 +
 .pine/templates/feature.md                         |  12 +
 .pine/tickets/BUG-19bt2k.md                        | 158 ++++++++++
 .pine/tickets/BUG-2hjt1x.md                        | 226 +++++++++++++++
 .pine/tickets/BUG-2smqpv.md                        |  31 ++
 .pine/tickets/BUG-88mac4.md                        | 210 ++++++++++++++
 .pine/tickets/BUG-e06a9d.md                        | 122 ++++++++
 .pine/tickets/BUG-ery7v7.md                        | 233 +++++++++++++++
 .pine/tickets/BUG-g6zq2t.md                        | 104 +++++++
 .pine/tickets/BUG-j8pbj9.md                        | 146 ++++++++++
 .pine/tickets/BUG-t1xj4d.md                        | 134 +++++++++
 .pine/tickets/BUG-y6y5mf.md                        |  78 +++++
 .pine/tickets/BUG-yq6qbw.md                        | 212 ++++++++++++++
 .pine/tickets/BUG-yxvrwx.md                        |  80 +++++
 .pine/tickets/EPIC-4sa5jb.md                       |  14 +
 .pine/tickets/EPIC-9gkehb.md                       |  15 +
 .pine/tickets/EPIC-c2gg45.md                       |  14 +
 .pine/tickets/EPIC-f953vk.md                       |  15 +
 .pine/tickets/EPIC-n6ndb8.md                       |  15 +
 .pine/tickets/EPIC-xzzpty.md                       |  15 +
 .pine/tickets/EPIC-zpa1nd.md                       |  15 +
 .pine/tickets/FEAT-0s2tnc.md                       |  36 +++
 .pine/tickets/FEAT-1k76hk.md                       | 168 +++++++++++
 .pine/tickets/FEAT-26tkya.md                       |  44 +++
 .pine/tickets/FEAT-51hnwx.md                       |  36 +++
 .pine/tickets/FEAT-56bxyh.md                       |  35 +++
 .pine/tickets/FEAT-5hnsby.md                       |  36 +++
 .pine/tickets/FEAT-6v92dk.md                       | 183 ++++++++++++
 .pine/tickets/FEAT-71ay4e.md                       |  36 +++
 .pine/tickets/FEAT-7ffxsg.md                       |  36 +++
 .pine/tickets/FEAT-8559h1.md                       |  72 +++++
 .pine/tickets/FEAT-905vk4.md                       |  36 +++
 .pine/tickets/FEAT-az3sxm.md                       |  36 +++
 .pine/tickets/FEAT-azqfsv.md                       |  33 +++
 .pine/tickets/FEAT-bd87vz.md                       |  38 +++
 .pine/tickets/FEAT-c0zn3j.md                       | 108 +++++++
 .pine/tickets/FEAT-c5a15c.md                       | 168 +++++++++++
 .pine/tickets/FEAT-ckxz8d.md                       |  73 +++++
 .pine/tickets/FEAT-d8b6bj.md                       |  44 +++
 .pine/tickets/FEAT-et1gxc.md                       | 168 +++++++++++
 .pine/tickets/FEAT-g39qj3.md                       |  36 +++
 .pine/tickets/FEAT-hmsg5h.md                       | 168 +++++++++++
 .pine/tickets/FEAT-k28j7h.md                       |  37 +++
 .pine/tickets/FEAT-kncqxf.md                       | 178 ++++++++++++
 .pine/tickets/FEAT-ks4yy4.md                       | 143 +++++++++
 .pine/tickets/FEAT-ky1jfw.md                       |  90 ++++++
 .pine/tickets/FEAT-kzej8t.md                       |  36 +++
 .pine/tickets/FEAT-n762y6.md                       |  47 +++
 .pine/tickets/FEAT-rmh08k.md                       |  34 +++
 .pine/tickets/FEAT-vh2bwz.md                       | 180 ++++++++++++
 .pine/tickets/FEAT-vvaycm.md                       |  37 +++
 .pine/tickets/FEAT-vwvgs0.md                       |  36 +++
 .pine/tickets/FEAT-ybhdhz.md                       |  36 +++
 .prettierignore                                    |  12 +
 AGENTS.md                                          |  26 ++
 CLAUDE.md                                          |  26 ++
 src/main/index.ts                                  |   9 +
 src/main/ipc/ai.ts                                 | 147 +++++++++-
 src/main/ipc/index.ts                              |   4 +-
 src/main/ipc/job-start-validation.ts               |  15 +-
 src/main/ipc/model.ts                              |  25 +-
 src/main/ipc/system.ts                             |  77 +++++
 src/main/services/ai-client.ts                     | 216 +++++++++++---
 src/main/services/ffmpeg-export.ts                 |  50 +++-
 src/main/services/jobs/export-runner.ts            |  25 +-
 src/main/services/jobs/generate-clips-runner.ts    | 133 +++++++++
 src/main/services/model-manager.ts                 |  27 +-
 src/main/services/provider-models.ts               | 146 ++++++++++
 src/main/services/reframe-detect.ts                |  22 +-
 src/main/services/sidecar-manager.ts               |   5 +
 src/main/services/silence-detect.ts                |   4 +
 src/preload/api/files.ts                           |  35 +++
 src/preload/index.ts                               |   7 +-
 src/renderer/src/App.tsx                           | 112 ++++++-
 src/renderer/src/components/ClipSidebar.tsx        |  51 +++-
 src/renderer/src/components/ExportPanel.tsx        | 120 ++++++--
 src/renderer/src/components/ImportPanel.tsx        |  74 ++++-
 src/renderer/src/components/JobStatusBar.tsx       | 256 ++++++++++++++++
 .../src/components/ModelDownloadDialog.tsx         | 100 +++++--
 src/renderer/src/components/ReadinessBar.tsx       |  75 +++++
 src/renderer/src/components/SettingsPanel.tsx      | 204 +++++++++----
 .../src/components/TranscriptionSettings.tsx       | 176 +++++++++++
 src/renderer/src/components/export-run.ts          |  14 +-
 src/renderer/src/components/formatBytes.ts         |  15 +
 src/renderer/src/components/generate-clips-run.ts  |  54 ++++
 src/renderer/src/components/generateClips.ts       |  12 +-
 src/renderer/src/components/import-pipeline.ts     |  42 ++-
 src/renderer/src/components/jobStatus.ts           | 322 +++++++++++++++++++++
 src/renderer/src/components/model-download.ts      |   7 +
 src/renderer/src/components/readinessView.ts       | 132 +++++++++
 src/renderer/src/components/settingsView.ts        |  68 ++++-
 src/renderer/src/hooks/import-controller.ts        | 234 ++++++++++++---
 src/renderer/src/hooks/importControllerHost.ts     |  42 +++
 src/renderer/src/hooks/useImportController.ts      |  88 ++++--
 src/renderer/src/hooks/useJob.ts                   | 150 ++--------
 src/renderer/src/hooks/useProject.ts               |   5 +
 src/renderer/src/hooks/useReadiness.ts             |  77 +++++
 src/renderer/src/main.tsx                          |  12 +
 src/renderer/src/stores/jobNotifications.ts        |  90 ++++++
 src/renderer/src/stores/jobsStore.ts               | 249 ++++++++++++++++
 src/renderer/src/stores/projectStore/autosave.ts   |  61 +++-
 src/renderer/src/stores/projectStore/clipsSlice.ts |  88 +++++-
 .../src/stores/projectStore/exportSlice.ts         |   4 +-
 src/renderer/src/stores/uiStore.ts                 |  37 +--
 src/shared/channels.ts                             | 113 ++++++--
 src/shared/jobs.ts                                 |  83 +++++-
 tests/e2e/generate-clips-button.e2e.spec.ts        |  41 +++
 tests/e2e/integration-wave1.e2e.spec.ts            |  31 +-
 tests/e2e/job-status-bar.e2e.spec.ts               | 127 ++++++++
 tests/e2e/model-gate.e2e.spec.ts                   |  53 ++++
 tests/e2e/ping.e2e.spec.ts                         |  72 +++--
 tests/mocks/openclip.ts                            |  20 +-
 tests/unit/ai-components.spec.ts                   |  57 +++-
 tests/unit/ai-ipc.spec.ts                          | 146 +++++++++-
 tests/unit/ai-mapreduce.spec.ts                    | 112 +++++++
 tests/unit/ai-stores.spec.ts                       | 162 ++++++++---
 tests/unit/autosave-subscriber.spec.ts             |  73 +++++
 tests/unit/contract.spec.ts                        |  24 ++
 tests/unit/export-runner.spec.ts                   |  67 ++++-
 tests/unit/ffmpeg-export.serial.spec.ts            |  42 +++
 tests/unit/ffmpeg-export.spec.ts                   |  56 +++-
 tests/unit/format-bytes.spec.ts                    |  25 ++
 tests/unit/generate-clips-runner.spec.ts           | 188 ++++++++++++
 tests/unit/generate-clips-view.spec.ts             |  23 ++
 tests/unit/import-controller-host.spec.ts          |  56 ++++
 tests/unit/import-controller.spec.ts               | 215 +++++++++++++-
 tests/unit/import-url.spec.ts                      |  21 ++
 tests/unit/job-notifications.spec.ts               | 131 +++++++++
 tests/unit/job-status.spec.ts                      | 220 ++++++++++++++
 tests/unit/jobs-store.spec.ts                      | 208 +++++++++++++
 tests/unit/model-manager.spec.ts                   |  30 +-
 tests/unit/onboarding-handlers.spec.ts             | 145 ++++++++++
 tests/unit/preload-parity.spec.ts                  |  18 +-
 tests/unit/provider-models.spec.ts                 | 118 ++++++++
 tests/unit/readiness-view.spec.ts                  | 117 ++++++++
 tests/unit/silence-detect.spec.ts                  |  11 +
 tests/unit/system-notify.spec.ts                   | 133 +++++++++
 tests/unit/use-project.spec.ts                     |  11 +
 158 files changed, 11257 insertions(+), 547 deletions(-)
```
