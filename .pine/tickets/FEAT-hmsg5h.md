---
id: FEAT-hmsg5h
title: Drag-and-drop is advertised in the UI copy but no drop target exists anywhere
status: done
priority: high
labels:
    - ux
    - import
parent: EPIC-xzzpty
created: "2026-08-08T15:56:46Z"
updated: "2026-08-08T17:53:39Z"
---

## Current behavior

Welcome.tsx:32 tells the user 'Turn a long video into viral shorts — drop a file or paste a YouTube link', and ImportPanel's own docstring claims 'file picker + drop'. `grep -rniE "onDrop|onDragOver|dataTransfer" src/renderer/src/` returns zero matches. This is also the first acceptance criterion of PRD §6.1. The text field's placeholder (ImportPanel.tsx:58) says URL only; the only hint that a file path works is the aria-label (:57).

## Desired behavior

A real drop zone on the Welcome card and the editor canvas: dashed border + 'Drop a video here' on dragenter, ffprobe validation on drop, and a soft warning for unsupported types or very short sources. Fix the placeholder to 'Paste a YouTube URL or drop a video file…'.

## Competitor precedent

OpusClip's landing input is 'Drop a video link' beside an 'Upload files' affordance. Kapwing accepts upload-or-link in one combined field and states accepted formats inline. LokaClip markets drag-a-local-file as its headline differentiator ('Hampir semua AI clipper memaksamu menempelkan link').

## Implementation sketch

Add `onDragOver`/`onDragLeave`/`onDrop` to the wrapper in ImportPanel.tsx (and a full-window overlay in App.tsx). In the drop handler read `e.dataTransfer.files[0].path` (available under Electron), feed it to the controller's existing `importFile(path)` — the file path branch already exists, so this is purely a new entry point. Note `sandbox: true` still exposes `File.path` in Electron; if not, use `webUtils.getPathForFile` exposed through a new preload helper. Also update the placeholder at ImportPanel.tsx:58.

## Sizing

Impact: **high** · Effort: **small**

## Provenance

Found by a multi-agent sweep of the codebase cross-referenced against OpusClip, Kapwing AI Clip Maker, LokaClip, yt-short-clipper and SupoClip. Every `file:line` above was read directly from the source tree.

## Work Evidence

Closed by `pine close --evidence` on 2026-08-08.

- Base: `3ea7b027` (last commit at or before ticket created 2026-08-08)
- Commits (3):
  - `d093c874` — feat(import): real drag-and-drop, which the UI had been advertising all along (FEAT-hmsg5h)
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
 .pine/tickets/FEAT-c5a15c.md                       |  36 ++++
 .pine/tickets/FEAT-ckxz8d.md                       |  36 ++++
 .pine/tickets/FEAT-d8b6bj.md                       |  44 ++++
 .pine/tickets/FEAT-et1gxc.md                       | 168 +++++++++++++++
 .pine/tickets/FEAT-g39qj3.md                       |  36 ++++
 .pine/tickets/FEAT-hmsg5h.md                       |  36 ++++
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
 117 files changed, 6476 insertions(+), 165 deletions(-)
```
