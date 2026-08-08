---
id: FEAT-1k76hk
title: Whisper model management is invisible, and the persisted whisperModel setting is ignored
status: done
priority: medium
labels:
    - ux
    - models
parent: EPIC-xzzpty
created: "2026-08-08T15:56:46Z"
updated: "2026-08-08T17:53:39Z"
---

## Current behavior

`settingsStore.ts:22 whisperModel: 'base'` exists in the schema and the store, but SettingsPanel.tsx contains no whisper control at all (grepping the file for 'whisper' matches only the language help copy at :404). Meanwhile import-controller.ts:38 hardcodes `const DEFAULT_MODEL: WhisperModelSize = 'base'` and :137 resolves `deps.model ?? DEFAULT_MODEL` — the user's setting is never read. So a user who downloads `large-v3` gets `base` transcription anyway, and there is no way to see installed models, switch models, or reclaim the multiple gigabytes they occupy.

## Desired behavior

A Transcription section in Settings: a row per model with size, speed/accuracy, an Installed/Download badge, a Delete button to free disk, and a radio to select the active one — which the import path actually honors. Show total disk used by models and by the WAV cache.

## Competitor precedent

YT-Short-Clipper's Library page lists each dependency with per-item status and a one-click Download, flipping to 'Installed'. LokaClip surfaces storage management showing disk usage with a cache-clear button.

## Implementation sketch

Reuse `WHISPER_MODEL_TABLE` from ModelDownloadDialog.tsx into a new `components/TranscriptionSettings.tsx` mounted in SettingsPanel. Data comes from the existing `model.status({model})` bridge call (used at import-controller.ts:173) — widen it to return size-on-disk. Add a `MODEL_DELETE` channel in channels.ts backed by `model-manager.ts`. Critically, change import-controller.ts:137 to read `settings.whisperModel` instead of the hardcoded `DEFAULT_MODEL`. Note model-manager.ts also has no resume (:109 deletes the partial on cancel) — worth pairing, since restarting a 2.9GB download from zero is the other half of this pain.

## Sizing

Impact: **medium** · Effort: **medium**

## Provenance

Found by a multi-agent sweep of the codebase cross-referenced against OpusClip, Kapwing AI Clip Maker, LokaClip, yt-short-clipper and SupoClip. Every `file:line` above was read directly from the source tree.

## Work Evidence

Closed by `pine close --evidence` on 2026-08-08.

- Base: `3ea7b027` (last commit at or before ticket created 2026-08-08)
- Commits (3):
  - `3dd9e11c` — feat(settings): whisper model management, and actually honour the setting (FEAT-1k76hk)
  - `48f51462` — feat(contract): add preflight, test-connection and model-delete channels (EPIC-xzzpty)
  - `3c7d68c2` — chore(pine): adopt pine issue tracking + file the multi-agent audit backlog
- Files changed (base → working tree):

```
 .agents/skills/pine/SKILL.md                       | 145 +++++++++++++
 .claude/settings.json                              |  15 +-
 .claude/skills/pine/SKILL.md                       | 145 +++++++++++++
 .codex/hooks.json                                  |  14 ++
 .codex/hooks/pine-learn-reminder.sh                |   6 +
 .cursor/hooks.json                                 |  10 +
 .cursor/hooks/pine-learn-reminder.sh               |   6 +
 .github/ISSUE_TEMPLATE/bug_report.md               |  30 +++
 .github/ISSUE_TEMPLATE/feature_request.md          |  15 ++
 .github/pull_request_template.md                   |  24 +++
 .github/workflows/ci.yml                           |  82 ++++++++
 .pine/.gitignore                                   |   4 +
 .pine/MEMORY.md                                    |  13 ++
 .pine/board.json                                   |   1 +
 .pine/config.json                                  |   1 +
 .pine/memory/competitor-precedent.md               |  10 +
 .pine/memory/perf-refuted.md                       |  11 +
 .pine/prompts/fix.md                               |  22 ++
 .pine/templates/bug.md                             |  14 ++
 .pine/templates/epic.md                            |   3 +
 .pine/templates/feature.md                         |  12 ++
 .pine/tickets/BUG-19bt2k.md                        | 158 ++++++++++++++
 .pine/tickets/BUG-2hjt1x.md                        | 226 ++++++++++++++++++++
 .pine/tickets/BUG-2smqpv.md                        |  31 +++
 .pine/tickets/BUG-88mac4.md                        | 210 +++++++++++++++++++
 .pine/tickets/BUG-e06a9d.md                        | 122 +++++++++++
 .pine/tickets/BUG-ery7v7.md                        | 233 +++++++++++++++++++++
 .pine/tickets/BUG-g6zq2t.md                        | 104 +++++++++
 .pine/tickets/BUG-j8pbj9.md                        | 146 +++++++++++++
 .pine/tickets/BUG-t1xj4d.md                        | 134 ++++++++++++
 .pine/tickets/BUG-y6y5mf.md                        |  78 +++++++
 .pine/tickets/BUG-yq6qbw.md                        | 212 +++++++++++++++++++
 .pine/tickets/BUG-yxvrwx.md                        |  80 +++++++
 .pine/tickets/EPIC-4sa5jb.md                       |  14 ++
 .pine/tickets/EPIC-9gkehb.md                       |  15 ++
 .pine/tickets/EPIC-c2gg45.md                       |  14 ++
 .pine/tickets/EPIC-f953vk.md                       |  15 ++
 .pine/tickets/EPIC-n6ndb8.md                       |  15 ++
 .pine/tickets/EPIC-xzzpty.md                       |  15 ++
 .pine/tickets/EPIC-zpa1nd.md                       |  15 ++
 .pine/tickets/FEAT-0s2tnc.md                       |  36 ++++
 .pine/tickets/FEAT-1k76hk.md                       |  36 ++++
 .pine/tickets/FEAT-51hnwx.md                       |  36 ++++
 .pine/tickets/FEAT-56bxyh.md                       |  35 ++++
 .pine/tickets/FEAT-5hnsby.md                       |  36 ++++
 .pine/tickets/FEAT-6v92dk.md                       | 183 ++++++++++++++++
 .pine/tickets/FEAT-71ay4e.md                       |  36 ++++
 .pine/tickets/FEAT-7ffxsg.md                       |  36 ++++
 .pine/tickets/FEAT-8559h1.md                       |  36 ++++
 .pine/tickets/FEAT-905vk4.md                       |  36 ++++
 .pine/tickets/FEAT-az3sxm.md                       |  36 ++++
 .pine/tickets/FEAT-bd87vz.md                       |  38 ++++
 .pine/tickets/FEAT-c0zn3j.md                       |  57 +++++
 .pine/tickets/FEAT-c5a15c.md                       | 168 +++++++++++++++
 .pine/tickets/FEAT-ckxz8d.md                       |  36 ++++
 .pine/tickets/FEAT-d8b6bj.md                       |  44 ++++
 .pine/tickets/FEAT-et1gxc.md                       | 168 +++++++++++++++
 .pine/tickets/FEAT-g39qj3.md                       |  36 ++++
 .pine/tickets/FEAT-hmsg5h.md                       | 168 +++++++++++++++
 .pine/tickets/FEAT-k28j7h.md                       |  37 ++++
 .pine/tickets/FEAT-kncqxf.md                       | 178 ++++++++++++++++
 .pine/tickets/FEAT-ks4yy4.md                       | 143 +++++++++++++
 .pine/tickets/FEAT-ky1jfw.md                       |  49 +++++
 .pine/tickets/FEAT-kzej8t.md                       |  36 ++++
 .pine/tickets/FEAT-n762y6.md                       |  47 +++++
 .pine/tickets/FEAT-rmh08k.md                       |  34 +++
 .pine/tickets/FEAT-vvaycm.md                       |  37 ++++
 .pine/tickets/FEAT-vwvgs0.md                       |  36 ++++
 .pine/tickets/FEAT-ybhdhz.md                       |  36 ++++
 .prettierignore                                    |  12 ++
 AGENTS.md                                          |  26 +++
 CLAUDE.md                                          |  26 +++
 src/main/ipc/ai.ts                                 | 115 +++++++++-
 src/main/ipc/index.ts                              |   4 +-
 src/main/ipc/model.ts                              |  33 ++-
 src/main/ipc/system.ts                             |  46 ++++
 src/main/services/ffmpeg-export.ts                 |  50 ++++-
 src/main/services/model-manager.ts                 |  27 ++-
 src/main/services/provider-models.ts               | 141 +++++++++++++
 src/main/services/silence-detect.ts                |   4 +
 src/preload/api/files.ts                           |  35 ++++
 src/preload/index.ts                               |   7 +-
 src/renderer/src/App.tsx                           |  54 ++++-
 src/renderer/src/components/ImportPanel.tsx        |  68 +++++-
 .../src/components/ModelDownloadDialog.tsx         |  59 ++++--
 src/renderer/src/components/ReadinessBar.tsx       |  71 +++++++
 src/renderer/src/components/SettingsPanel.tsx      | 180 ++++++++++------
 .../src/components/TranscriptionSettings.tsx       | 148 +++++++++++++
 src/renderer/src/components/formatBytes.ts         |  15 ++
 src/renderer/src/components/generateClips.ts       |  12 +-
 src/renderer/src/components/model-download.ts      |   7 +
 src/renderer/src/components/readinessView.ts       | 116 ++++++++++
 src/renderer/src/components/settingsView.ts        |  42 +++-
 src/renderer/src/hooks/import-controller.ts        |  82 +++++++-
 src/renderer/src/hooks/useImportController.ts      |  57 ++++-
 src/renderer/src/hooks/useProject.ts               |   5 +
 src/renderer/src/hooks/useReadiness.ts             |  75 +++++++
 src/renderer/src/main.tsx                          |   4 +
 src/shared/channels.ts                             |  64 ++++++
 tests/e2e/generate-clips-button.e2e.spec.ts        |  41 ++++
 tests/e2e/ping.e2e.spec.ts                         |  71 ++++---
 tests/mocks/openclip.ts                            |   4 +-
 tests/unit/ai-components.spec.ts                   |  43 +++-
 tests/unit/ai-ipc.spec.ts                          | 146 ++++++++++++-
 tests/unit/contract.spec.ts                        |  24 +++
 tests/unit/ffmpeg-export.serial.spec.ts            |  42 ++++
 tests/unit/ffmpeg-export.spec.ts                   |  56 ++++-
 tests/unit/format-bytes.spec.ts                    |  25 +++
 tests/unit/generate-clips-view.spec.ts             |  23 ++
 tests/unit/import-controller.spec.ts               | 143 ++++++++++++-
 tests/unit/model-manager.spec.ts                   |  30 ++-
 tests/unit/onboarding-handlers.spec.ts             | 145 +++++++++++++
 tests/unit/preload-parity.spec.ts                  |  10 +-
 tests/unit/provider-models.spec.ts                 |  97 +++++++++
 tests/unit/readiness-view.spec.ts                  |  88 ++++++++
 tests/unit/silence-detect.spec.ts                  |  11 +
 tests/unit/use-project.spec.ts                     |  11 +
 117 files changed, 6740 insertions(+), 165 deletions(-)
```
