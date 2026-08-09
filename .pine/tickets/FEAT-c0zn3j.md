---
id: FEAT-c0zn3j
title: '''Auto Generate Clips'' is a blocking invoke with no progress, no cancel, and no timeout — 2-6 minutes of a frozen button'
status: done
priority: critical
labels:
    - ux
    - jobs
    - ai
deps:
    - FEAT-vh2bwz
parent: EPIC-zpa1nd
created: "2026-08-08T15:56:46Z"
updated: "2026-08-09T03:57:41Z"
---

## Current behavior

GENERATE_CLIPS is a plain request/response channel (channels.ts:57, :257), not a streaming job. ai-client.ts:500-510 `mapReduceGenerate` runs one repair-laddered LLM call per chunk strictly sequentially (up to 2 round-trips each) with chunks defaulting to 10k tokens (ai-client.ts:792). `grep -rn "timeout|AbortSignal|abort" src/main/services/ai-client.ts src/main/ipc/ai.ts` returns nothing — no transport timeout, no abort path. The UI shows the plain text 'Generating clips…' (ClipSidebar.tsx:30). Every other long operation in the app is a cancellable streaming job; this one is not, so a wedged provider connection is unrecoverable without quitting.

## Desired behavior

Promote clip generation to a `JobKind` so it gets the MessagePort progress/cancel plane for free: 'Analyzing chunk 2 of 6' with a real bar and a Cancel button. Add a per-request timeout with a typed, human error. Emit each chunk's surviving candidates as a `partial` so cards stream in progressively instead of appearing all at once.

## Competitor precedent

OpusClip exposes a named stage machine (PENDING→QUEUED→IMPORT→CURATE→REFINE→RENDER→UPLOAD→COMPLETE) with coarse progress and lets you leave the page. SupoClip checks `should_cancel()` cooperatively between every pipeline stage. YT-Short-Clipper shows a live token/cost meter ticking during the run.

## Implementation sketch

Add `'generate-clips'` to `JobKind` in `src/shared/jobs.ts` with `JobParams`/`JobResult`/`JobPartial` (partial = `{clips: DetectedClip[], chunkIndex, chunkCount}`). New `src/main/services/jobs/generate-clips-runner.ts` registered from `src/main/ipc/ai.ts`, wrapping the existing `mapReduceGenerate` and emitting `emit.progress(i/chunks*100, 'analyzing')` per chunk plus `emit.partial` per chunk's clamped survivors. Thread `ctx.signal` into the transports (add an `AbortSignal` param to `RawTransport`) and add an `AbortSignal.timeout(120_000)` race. Renderer: clipsSlice `generateClips` switches to `drainJob`, appending partials — reuse the same pattern as import-pipeline.ts:65-72.

## Sizing

Impact: **critical** · Effort: **medium**

## Provenance

Found by a multi-agent sweep of the codebase cross-referenced against OpusClip, Kapwing AI Clip Maker, LokaClip, yt-short-clipper and SupoClip. Every `file:line` above was read directly from the source tree.

## Reproduced accidentally, with a real provider (2026-08-09)

While probing small models through OpenRouter with the app's own `ai-client`:

- `google/gemini-3.5-flash-lite` — 4.2–4.8s, consistent.
- `google/gemma-4-31b-it` — 35.7s on one run for the SAME 406s transcript, and on a
  later run it **never returned at all**; the harness killed it at a 600s timeout.

That second case is exactly this ticket in the wild. In the app there is no
timeout, no cancel and no progress on `GENERATE_CLIPS`, so a user on that model
gets a permanently frozen "Generating clips…" with the only escape being force-quit
— and because generate is a plain `invoke`, the main process keeps the request
alive behind it.

Concrete asks this evidence adds:
- A hard request deadline (the SDK clients are constructed with no `timeout`).
- A cancel path — ideally by moving GENERATE_CLIPS onto the streaming-job plane,
  which already guarantees `done` xor `error`, rather than leaving it an invoke.
- Per-chunk progress, since map-reduce already knows the chunk count.

## Done

All three asks, plus the streaming partials.

**Contract.** `'generate-clips'` joins `JobKind` with params/result/partial in
`jobs.ts`. `GenerateClipsRequest` in `channels.ts` is now an ALIAS of
`JobParams['generate-clips']` rather than a second hand-maintained copy — the
direction is forced, since channels.ts already imports jobs.ts. `concurrencyFor`
returns 1 for it: it is network-bound, but each run is a paid BYOK request per
chunk and letting a user stack generations multiplies their bill invisibly.

**Deadline + abort.** `RawTransport` gained an optional second `{signal}` arg —
optional so every existing one-argument fake in the specs still typechecks. The
OpenAI and Anthropic transports pass it as the SDK's per-request `signal`;
Ollama has no such option, so it races the promise and calls `client.abort()`.
The SDK clients are now constructed with `timeout: AI_REQUEST_TIMEOUT_MS`
(120s) — they previously carried **no deadline at all**, which is why the
reproduced hang could last forever. `mapReduceGenerate` checks the signal
between chunks so a cancel stops buying the remaining ones.

**Two abort sources, two meanings.** The runner composes
`AbortSignal.any([ctx.signal, AbortSignal.timeout(...)])` but keeps the deadline
signal separate, because "you cancelled" and "the provider never answered" are
different events: the former takes the manager's CANCELLED path, the latter
raises a typed retriable `TIMEOUT` naming the model so the user knows what to
change.

**Renderer.** `clipsSlice.generateClips` drives `runGenerateClips` (a `drainJob`
wrapper mirroring `export-run.ts`) and gained `generatePct` / `generateChunk` /
`generateJobId` / `cancelGenerate`. ClipSidebar's bare "Generating clips…" is
now a bar, "Analyzing chunk 2 of 6", and a Cancel button.

### Two decisions worth keeping

- **Provisional clips live in their own `provisionalClips` array**, never in
  `clips`. `clips` is one of the four refs the autosave subscriber watches, so
  streaming per-chunk candidates into it would write unranked, un-deduped
  guesses into the `.ocproj` as though the user had accepted them. The sidebar
  shows provisional cards *instead of* the previous run's results while a
  generation is in flight, and the terminal result replaces them wholesale —
  appending would surface cross-chunk duplicates of the same moment.
- **A failed or cancelled regeneration keeps the previous clips.** They may have
  been about to be exported. A cancel also sets no `generateError`: showing
  someone their own click back as a failure is noise.

`generate-clips-button.e2e` exercises the whole new path — click → job → real
main process → registered runner → fake transport → cards — so this is proven
end to end, not just at the seams.

## Work Evidence

Closed by `pine close --evidence` on 2026-08-09.

- Base: `3ea7b027` (last commit at or before ticket created 2026-08-08)
- Commits (4):
  - `5c0035b6` — feat(ai): clip generation becomes a cancellable job with a deadline (FEAT-c0zn3j)
  - `eb1be422` — fix(onboarding): address code review — two regressions plus readiness correctness
  - `dbea17e2` — docs(pine): attach real-provider evidence to the clip-boundary and generate-timeout tickets
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
 .pine/tickets/FEAT-ky1jfw.md                       | 264 +++++++++++++++++
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
 158 files changed, 11431 insertions(+), 547 deletions(-)
```
