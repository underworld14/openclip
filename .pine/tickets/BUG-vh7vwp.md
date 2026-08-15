---
id: BUG-vh7vwp
title: 'AI emoji is broken on OpenAI/OpenRouter: the transport forces the ClipSchema response_format on every prompt'
status: done
priority: medium
created: "2026-08-15T08:35:22Z"
updated: "2026-08-15T16:10:12Z"
---

# Description

`buildOpenAITransport` (`src/main/services/ai-client.ts`) attaches
`response_format: {type:'json_schema', json_schema:{name:'clips', strict:true, schema}}`
to EVERY prompt it is given. `ENHANCE_CAPTIONS` (mode:'emoji') reuses that same
transport for `suggestEmoji` (`src/main/ipc/ai.ts` → `services/ai-emoji.ts`), so the
emoji request is strictly constrained to emit a ClipSchema document.
`parseEmojiMap` then rejects it (values are arrays/objects, not emoji strings) and
the handler's catch degrades to `{}` — which is indistinguishable, by design, from
"the model had no suggestions". So AI emoji has never worked on OpenAI or
OpenRouter, silently.

Anthropic (`zodOutputFormat(ClipSchema)`) and Ollama (`format: clipJsonSchema()`)
have the same shape.

Found while building FEAT-bysdwg; deliberately not folded into it.

# Acceptance Criteria
- [ ] The emoji transport is not constrained to the clip schema
- [ ] A test asserts the emoji request's response_format (or absence of one)
- [ ] AI emoji produces a non-empty map against a real provider

# Implementation Plan

FEAT-bysdwg added the seam: `buildOpenAITransport(client, model, opts)` already
takes `modes` and could take a `responseSchema`. Give the emoji path its own
schema (or `modes: ['none']` plus the schema in the prompt, as the custom
provider's non-strict rungs do), and key the structured-mode memo on the schema
name — it already is (`${baseUrl}|${model}|clips`).

# Notes

# Related Files
- src/main/services/ai-client.ts
- src/main/services/ai-emoji.ts
- src/main/ipc/ai.ts

# Attachments

## Work Evidence

Closed by `pine close --evidence` on 2026-08-15.

- Base: `58534d6a` (last commit at or before ticket created 2026-08-15)
- Commits (2):
  - `ce609dd3` — fix(ai): stop OPENAI_BASE_URL env override, give AI emoji its own unconstrained transport
  - `65c217de` — chore(pine): close FEAT-bysdwg with evidence, file 3 follow-ups, capture learnings
- Files changed (base → working tree):

```
 .pine/MEMORY.md                                    |   4 +
 .pine/memory/byok-endpoints.md                     |  11 +
 .pine/memory/renderer.md                           |   4 +-
 .pine/memory/testing.md                            |   3 +-
 .pine/tickets/BUG-08sb0x.md                        |  36 +++
 .pine/tickets/BUG-12bxbk.md                        |  33 +++
 .pine/tickets/BUG-15cddx.md                        | 138 ++++++++++
 .pine/tickets/BUG-1m642d.md                        |  59 ++++
 .pine/tickets/BUG-44fgyv.md                        |  38 +++
 .pine/tickets/BUG-45xt77.md                        |  78 ++++++
 .pine/tickets/BUG-4c3gj3.md                        | 118 ++++++++
 .pine/tickets/BUG-4tscfq.md                        |  36 +++
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
 .pine/tickets/BUG-v4phgj.md                        | 215 +++++++++++++++
 .pine/tickets/BUG-vh7vwp.md                        |  47 ++++
 .pine/tickets/BUG-vv87d6.md                        | 120 +++++++++
 .pine/tickets/BUG-w2jv3w.md                        | 106 ++++++++
 .pine/tickets/BUG-whdqsc.md                        | 231 ++++++++++++++++
 .pine/tickets/BUG-y9km1j.md                        |  73 +++++
 .pine/tickets/EPIC-k83ghw.md                       |  66 +++++
 .pine/tickets/FEAT-azvb5c.md                       | 226 ++++++++++++++++
 .pine/tickets/FEAT-bysdwg.md                       |  87 +++++-
 .pine/tickets/FEAT-rmgkee.md                       | 234 ++++++++++++++++
 .pine/tickets/FEAT-vz5vya.md                       | 118 ++++++++
 .pine/tickets/FEAT-x9femg.md                       | 125 +++++++++
 README.md                                          |  74 +++--
 electron-builder.yml                               |  35 ++-
 package-lock.json                                  | 100 ++++++-
 package.json                                       |   1 +
 src/main/index.ts                                  | 120 ++++++++-
 src/main/ipc/ai.ts                                 |  68 ++++-
 src/main/ipc/audio.ts                              |  50 ++--
 src/main/ipc/job-start-validation.ts               |  13 +-
 src/main/ipc/media.ts                              |  15 +-
 src/main/ipc/project.ts                            |  32 ++-
 src/main/ipc/settings.ts                           |  39 ++-
 src/main/ipc/system.ts                             |  20 +-
 src/main/ipc/video.ts                              |  15 +-
 src/main/menu.ts                                   |  30 ++-
 src/main/services/ai-client.ts                     | 246 +++++++++++++++--
 src/main/services/ai-emoji.ts                      |  10 +-
 src/main/services/ass-captions.ts                  |  13 +-
 src/main/services/ffmpeg-extract.ts                |   6 +
 src/main/services/jobs/extract-audio-runner.ts     | 100 +++++++
 src/main/services/jobs/generate-clips-runner.ts    | 101 +++++--
 src/main/services/jobs/transcribe-runner.ts        |  16 +-
 src/main/services/media-store.ts                   |  29 ++
 src/main/services/model-manager.ts                 | 196 ++++++++++++--
 src/main/services/project-store.ts                 |  16 +-
 src/main/services/provider-models.ts               |  33 ++-
 src/main/services/sidecar-errors.ts                | 172 ++++++++++++
 src/main/services/sidecar-manager.ts               |  54 +++-
 src/main/services/updater.ts                       |  59 ++++
 src/main/utils/ffprobe.ts                          |  26 +-
 src/main/utils/paths.ts                            |  50 +++-
 src/preload/api/audio.ts                           |  12 -
 src/preload/index.ts                               |   4 -
 src/renderer/src/App.tsx                           | 174 ++++++++++--
 src/renderer/src/assets/index.css                  |  36 +++
 src/renderer/src/components/Dashboard.tsx          |  12 +-
 src/renderer/src/components/ErrorBoundary.tsx      |  86 ++++++
 src/renderer/src/components/ExportPanel.tsx        |  30 ++-
 .../src/components/GeneratePreflightDialog.tsx     |  39 ++-
 src/renderer/src/components/ImportPanel.tsx        |  28 +-
 src/renderer/src/components/JobStatusBar.tsx       |  15 +-
 .../src/components/ModelDownloadDialog.tsx         | 104 ++++----
 src/renderer/src/components/PreviewPlayer.tsx      | 297 +++++++++++++++++++--
 src/renderer/src/components/SettingsPanel.tsx      | 155 ++++++++---
 src/renderer/src/components/Timeline.tsx           |  65 +++--
 .../src/components/TranscriptionSettings.tsx       |  59 +++-
 src/renderer/src/components/batch-export.ts        |  42 ++-
 src/renderer/src/components/caption-css.ts         |  40 ++-
 src/renderer/src/components/import-pipeline.ts     |  90 ++++++-
 src/renderer/src/components/jobStatus.ts           |  15 ++
 src/renderer/src/components/model-download.ts      |  88 ++++++
 src/renderer/src/components/preview-crop.ts        |  49 +++-
 src/renderer/src/components/readinessView.ts       |   2 +-
 src/renderer/src/components/timeline-math.ts       |  57 ++++
 src/renderer/src/hooks/import-controller.ts        | 219 ++++++++++++++-
 src/renderer/src/hooks/useGlobalShortcuts.ts       |   9 +-
 src/renderer/src/hooks/useImportController.ts      |   9 +-
 src/renderer/src/hooks/useProject.ts               | 115 +++++++-
 src/renderer/src/main.tsx                          |   5 +-
 src/renderer/src/stores/jobsStore.ts               |  11 +-
 src/renderer/src/stores/projectStore/clipsSlice.ts | 121 +++++++--
 .../src/stores/projectStore/previewSlice.ts        |   8 +
 src/shared/ai-providers.ts                         |  39 +++
 src/shared/channels.ts                             |  17 +-
 src/shared/endpoint-url.ts                         |   8 +-
 src/shared/jobs.ts                                 |  26 ++
 src/shared/schema.ts                               |  12 +-
 src/shared/shortcuts.ts                            |  32 +++
 tests/e2e/vertical-slice.e2e.spec.ts               |  78 +++++-
 tests/fixtures/contract/index.ts                   |  17 ++
 tests/harness/renderer-env.ts                      |  25 ++
 tests/mocks/openclip.ts                            |  12 +-
 tests/unit/ai-errors.spec.ts                       | 121 +++++++++
 tests/unit/ai-ipc.spec.ts                          |  34 +++
 tests/unit/ai-mapreduce.spec.ts                    |  75 ++++++
 tests/unit/ai-providers-meta.spec.ts               |  49 ++++
 tests/unit/ai-providers.spec.ts                    | 111 ++++++++
 tests/unit/ai-stores.spec.ts                       |  93 ++++++-
 tests/unit/app-menu.spec.ts                        |  23 ++
 tests/unit/ass-captions.spec.ts                    |  16 ++
 tests/unit/batch-export.spec.ts                    |  62 +++++
 tests/unit/caption-css.spec.ts                     |  16 +-
 tests/unit/clip-reject-undo.spec.tsx               |  29 ++
 tests/unit/contract.spec.ts                        |  10 +
 tests/unit/custom-endpoint.spec.ts                 | 133 ++++++++-
 tests/unit/dialog-handlers.spec.ts                 |  10 +-
 tests/unit/error-boundary.spec.tsx                 |  64 +++++
 tests/unit/export-cancel.spec.tsx                  |  26 ++
 tests/unit/extract-audio-runner.spec.ts            | 100 +++++++
 tests/unit/ffprobe.spec.ts                         |  24 +-
 tests/unit/generate-clips-runner.spec.ts           | 117 ++++++++
 tests/unit/generate-preflight-dialog.spec.tsx      |  37 ++-
 tests/unit/global-shortcuts.spec.tsx               |  44 +++
 tests/unit/import-controller.spec.ts               |  16 +-
 tests/unit/import-pipeline.spec.ts                 |  93 ++++++-
 tests/unit/import-url.spec.ts                      |  35 ++-
 tests/unit/ipc-media.spec.ts                       |  25 +-
 tests/unit/ipc-project.spec.ts                     |  51 +++-
 tests/unit/job-start-validation.spec.ts            |  55 ++++
 tests/unit/job-status.spec.ts                      |  24 ++
 tests/unit/model-download-safety.spec.ts           | 293 ++++++++++++++++++++
 tests/unit/model-download-ux.spec.tsx              | 195 ++++++++++++++
 tests/unit/model-manager.spec.ts                   |  65 ++++-
 tests/unit/model-urls.serial.spec.ts               |  41 +++
 tests/unit/onboarding-handlers.spec.ts             |  58 +++-
 tests/unit/paths-prod.spec.ts                      |  35 +++
 tests/unit/preload-parity.spec.ts                  |   6 +-
 tests/unit/preview-crop.spec.ts                    |  72 ++++-
 tests/unit/preview-fitmode.spec.tsx                | 201 ++++++++++++++
 tests/unit/project-management.spec.tsx             |  11 +
 tests/unit/project-store.spec.ts                   |  34 +++
 tests/unit/provider-models.spec.ts                 |  32 ++-
 tests/unit/reframe-visibility.spec.tsx             |  15 +-
 tests/unit/settings-ipc.spec.ts                    |  48 ++++
 tests/unit/settings-panel-copy.spec.tsx            | 130 +++++++++
 tests/unit/settings-panel-custom-endpoint.spec.tsx |  25 ++
 tests/unit/settings-tabs.spec.tsx                  |   4 +-
 tests/unit/shortcuts.spec.ts                       |  25 ++
 tests/unit/sidecar-errors.spec.ts                  | 142 ++++++++++
 tests/unit/sidecar-manager.spec.ts                 |  63 +++++
 tests/unit/timeline-math.spec.ts                   |  80 ++++++
 tests/unit/trunk-infra.spec.ts                     |  30 +++
 tests/unit/updater.spec.ts                         |  88 ++++++
 tests/unit/use-project.spec.ts                     | 134 +++++++++-
 165 files changed, 11239 insertions(+), 597 deletions(-)
```
