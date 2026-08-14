---
id: BUG-g6zq2t
title: Every clip edit rewrites the whole 3 MB project document including all word timestamps
status: done
priority: medium
labels:
    - perf
    - autosave
parent: EPIC-c2gg45
created: "2026-08-08T15:57:27Z"
updated: "2026-08-14T12:33:38Z"
---

## Verdict

**PARTIAL** (high confidence) · severity **P2**

This finding was produced by a finder agent and then handed to an independent adversarial
verifier whose instructions were to *refute* it, defaulting to REFUTED when uncertain. It
survived. Four sibling claims in the same pass did not — see `.pine/MEMORY.md`.

## User impact

A user editing a 2-hour podcast project: each clip approve/reject, and each trim drag that settles for 800ms, rewrites the whole 3.04 MB .ocproj including all 20,000 word timestamps. A 30-edit session writes ~90 MB to disk to persist a few hundred bytes of actual change. Perceptually, the user sees at most one dropped frame (~18 ms renderer main-thread block from the contextBridge + IPC clone of the 3 MB object) roughly 800 ms after they stop interacting — not during the drag. On a very long source (6h lecture, ~60k words, 8.3 MB doc) the hitch grows to ~58 ms, which is visible as a brief stutter if the user happens to be scrolling or the preview is playing when it lands. There is no data loss and no broken flow.

## Evidence

MECHANISM — CONFIRMED exactly as claimed.

/Users/izzadev/projects/openclip/src/renderer/src/stores/projectStore/autosave.ts:92-106
```
  const unsubscribe = store.subscribe((state, prev) => {
    if (!state.currentProject) return
    const changed =
      state.currentProject !== prev.currentProject ||
      state.clips !== prev.clips ||
      state.transcript !== prev.transcript ||
      state.exportHistory !== prev.exportHistory
    if (!changed) return
    const composed = state.composeProject()
    if (composed) autosave(composed)
  })
```
autosave.ts:136-139 — the save is the real bridge call: `await window.openclip.project.save({ project })`.
App.tsx:74 — `useEffect(() => installAutosave(), [])`. No flag; reachable in normal production use.

composeProject includes the word array (exportSlice.ts:162-166 → composeLiveProject at exportSlice.ts:66-72):
```
  return { ...base, clips, transcript: transcript ?? base.transcript, exportHistory }
```
schema.ts:295-297 `Transcript = z.looseObject({ language, segments, words: z.array(WordTimestamp), ... })` — `words` is part of `Project`.

Every clips-reference change qualifies: clipsSlice.ts:70 `approveClip: (id) => set((s) => ({ clips: s.clips.map(...) }))`, :71 `rejectClip: ... filter(...)`, :66 `updateClip`, and timelineSlice.ts:64-70 `dragClipHandle → get().updateClip(id, { editedStart, editedEnd })`.

Write path is a whole-document pretty-printed rewrite (project-store.ts:108-112):
```
  const tmp = `${path}.${randomUUID()}.tmp`
  await writeFile(tmp, JSON.stringify(toPersist, null, 2), 'utf8')
  await rename(tmp, path)
```
No Zod re-validation on save (ipc/project.ts:27-36), so the main-side cost is stringify+write only.

Debounce is 800ms, pure trailing-edge with NO maxWait (shared/autosave.ts:21, :70-78 — `if (timer) clearTimeout(timer); timer = setTimeout(...)`).

MEASUREMENTS — I built a realistic 2h/20k-word project (1667 segments, 12 clips, full-precision confidence floats as produced by whisper-parse.ts:112 `confidence: entryConfidence(entry)`, unrounded).

(a) Node, exercising project-store.ts's exact save body (/tmp/ocbench/bench.mjs):
  words: 20000, segments: 1667
  pretty JSON bytes: 3,036,242 = 3.04 MB   (compact would be 1.85 MB)
  JSON.stringify(pretty)                 5.39 ms
  full saveProject() stringify+write+rename  7.09 ms

(b) REAL Electron run (node_modules/electron, contextIsolation:true, sandbox:true, nodeIntegration:false — same webPreferences as the app), measuring the synchronous renderer-main-thread block of `window.api.save({project})` (contextBridge deep clone + ipcRenderer.invoke structured clone) vs the main-process write:

  words  | .ocproj MB | composeProject() | renderer SYNC block | round trip | main write
   5,000 |    0.69    |   0.0003 ms      |      4.6 ms         |   7.3 ms   |  1.47 ms
  20,000 |    2.75    |   0.0000 ms      |     18.4 ms         |  27.4 ms   |  4.16 ms
  60,000 |    8.34    |   0.0001 ms      |     58.3 ms         |  85.8 ms   | 14.28 ms

WHAT THIS REFUTES: the "jank during editing" half.
1. During a trim drag, `onHandlePointerMove` → `dragClipHandle` → `updateClip` fires per pointermove, but the subscriber only runs `composeProject()` (a shallow object spread — measured 0.0003 ms) and resets a timer. Zero serialization, zero write while the pointer is down.
2. Because the debounce has no maxWait, continuous editing produces ZERO writes; the single write lands 800 ms after the user goes idle. So the 18 ms block never overlaps the interaction it came from.
3. 18 ms is ~1 dropped frame, occurring while the user is idle. At 6h/60k words it grows to ~58 ms (~4 frames) — still post-interaction.

So: "multi-megabyte writes" = CONFIRMED (3.04 MB per approve/reject/trim-settle). "Jank during editing" = REFUTED at realistic sizes.

## Fix

Cheapest, no contract change — /Users/izzadev/projects/openclip/src/main/services/project-store.ts:111: drop the pretty-printing, `JSON.stringify(toPersist)` instead of `JSON.stringify(toPersist, null, 2)`. Measured 3.04 MB → 1.85 MB (-39%) and ~5.4 ms → ~3 ms stringify. Costs human-readability of the .ocproj; loadProject is unaffected.

Real fix (removes the word array from the hot path) — add a delta channel so a clips-only edit never ships the transcript:
- src/shared/channels.ts: add `SAVE_PROJECT_PATCH` with req `{ id, clips, exportHistory, settings? }`.
- src/main/services/project-store.ts: `patchProject(dir, id, patch)` — read the on-disk doc, merge the patch, write. (Or keep an in-memory last-saved doc per id in the IPC layer to skip the read.)
- src/renderer/src/stores/projectStore/autosave.ts:98-105: when `state.transcript === prev.transcript && state.currentProject === prev.currentProject`, route to the patch save; only fall back to the full `project.save` when the transcript or the document itself changed. This makes the renderer sync block ~0.1 ms and the write ~50 KB for the overwhelmingly common case.

Alternative structural fix (larger, touches the frozen schema + loader): persist `transcript.words` to a sidecar `<id>.words.json` written only when the transcript changes, and keep the .ocproj lean. Requires updating schema.ts / loadProject / the drift fixtures together.

## Regression test

tests/unit/autosave-payload-size.spec.ts (vitest, fake timers). Build a Project with 20,000 WordTimestamps. Seed useProjectStore with it, `startAutosave(useProjectStore, spy, 800)`. Call `useProjectStore.getState().approveClip(clipId)`, `vi.advanceTimersByTime(800)`, await flush.

Assert: `JSON.stringify(spy.mock.calls[0][0]).length` is under, say, 200_000 bytes — i.e. the autosave payload for a clips-only edit does not carry the word array. Today the payload is ~1.85 MB compact and the test fails; after the delta-save fix it passes.

Companion regression test for the coalescing property that this verification established (so a future "fix" doesn't break it): drive 60 `dragClipHandle` calls 10 ms apart, advance 799 ms, assert `spy` has not been called; advance 1 ms more, assert exactly one call.

## Work Evidence

Closed by `pine close --evidence` on 2026-08-14.

- Base: `3ea7b027` (last commit at or before ticket created 2026-08-08)
- Commits (2):
  - `d3ff8bfe` — perf(autosave): a clip edit no longer rewrites the whole transcript (BUG-g6zq2t)
  - `3c7d68c2` — chore(pine): adopt pine issue tracking + file the multi-agent audit backlog
- Files changed (base → working tree):

```
 .agents/skills/pine/SKILL.md                       | 145 ++++
 .claude/settings.json                              |  15 +-
 .claude/skills/pine/SKILL.md                       | 145 ++++
 .codex/hooks.json                                  |  14 +
 .codex/hooks/pine-learn-reminder.sh                |   6 +
 .cursor/hooks.json                                 |  10 +
 .cursor/hooks/pine-learn-reminder.sh               |   6 +
 .github/ISSUE_TEMPLATE/bug_report.md               |  30 +
 .github/ISSUE_TEMPLATE/feature_request.md          |  15 +
 .github/pull_request_template.md                   |  24 +
 .github/workflows/ci.yml                           | 100 +++
 .pine/.gitignore                                   |   4 +
 .pine/MEMORY.md                                    |  13 +
 .pine/board.json                                   |   1 +
 .pine/config.json                                  |   1 +
 .pine/memory/ci.md                                 |  19 +
 .pine/memory/competitor-precedent.md               |  10 +
 .pine/memory/perf-refuted.md                       |  11 +
 .pine/memory/renderer.md                           |  15 +
 .pine/prompts/fix.md                               |  22 +
 .pine/templates/bug.md                             |  14 +
 .pine/templates/epic.md                            |   3 +
 .pine/templates/feature.md                         |  12 +
 .pine/tickets/BUG-19bt2k.md                        | 158 +++++
 .pine/tickets/BUG-2hjt1x.md                        | 226 +++++++
 .pine/tickets/BUG-2smqpv.md                        | 250 +++++++
 .pine/tickets/BUG-88mac4.md                        | 210 ++++++
 .pine/tickets/BUG-e06a9d.md                        | 338 ++++++++++
 .pine/tickets/BUG-ery7v7.md                        | 233 +++++++
 .pine/tickets/BUG-g6zq2t.md                        | 104 +++
 .pine/tickets/BUG-j8pbj9.md                        | 146 +++++
 .pine/tickets/BUG-jt3d62.md                        | 156 +++++
 .pine/tickets/BUG-t1xj4d.md                        | 360 ++++++++++
 .pine/tickets/BUG-y6y5mf.md                        | 300 +++++++++
 .pine/tickets/BUG-yq6qbw.md                        | 449 +++++++++++++
 .pine/tickets/BUG-yxvrwx.md                        | 296 +++++++++
 .pine/tickets/BUG-zcqyb7.md                        | 198 ++++++
 .pine/tickets/EPIC-4sa5jb.md                       |  14 +
 .pine/tickets/EPIC-9gkehb.md                       |  15 +
 .pine/tickets/EPIC-c2gg45.md                       |  14 +
 .pine/tickets/EPIC-f953vk.md                       |  15 +
 .pine/tickets/EPIC-n6ndb8.md                       |  15 +
 .pine/tickets/EPIC-xzzpty.md                       |  15 +
 .pine/tickets/EPIC-zpa1nd.md                       |  48 ++
 .pine/tickets/FEAT-0s2tnc.md                       |  36 +
 .pine/tickets/FEAT-1k76hk.md                       | 168 +++++
 .pine/tickets/FEAT-26tkya.md                       | 141 ++++
 .pine/tickets/FEAT-51hnwx.md                       |  36 +
 .pine/tickets/FEAT-56bxyh.md                       |  35 +
 .pine/tickets/FEAT-5hnsby.md                       | 261 ++++++++
 .pine/tickets/FEAT-6v92dk.md                       | 183 ++++++
 .pine/tickets/FEAT-71ay4e.md                       |  36 +
 .pine/tickets/FEAT-7ffxsg.md                       | 248 +++++++
 .pine/tickets/FEAT-8559h1.md                       | 245 +++++++
 .pine/tickets/FEAT-905vk4.md                       |  36 +
 .pine/tickets/FEAT-az3sxm.md                       | 268 ++++++++
 .pine/tickets/FEAT-azqfsv.md                       |  33 +
 .pine/tickets/FEAT-bd87vz.md                       |  38 ++
 .pine/tickets/FEAT-c0zn3j.md                       | 282 ++++++++
 .pine/tickets/FEAT-c5a15c.md                       | 168 +++++
 .pine/tickets/FEAT-ckxz8d.md                       | 246 +++++++
 .pine/tickets/FEAT-d8b6bj.md                       | 252 +++++++
 .pine/tickets/FEAT-et1gxc.md                       | 168 +++++
 .pine/tickets/FEAT-g39qj3.md                       |  36 +
 .pine/tickets/FEAT-hmsg5h.md                       | 168 +++++
 .pine/tickets/FEAT-k28j7h.md                       | 268 ++++++++
 .pine/tickets/FEAT-kncqxf.md                       | 178 +++++
 .pine/tickets/FEAT-ks4yy4.md                       | 143 ++++
 .pine/tickets/FEAT-ky1jfw.md                       | 264 ++++++++
 .pine/tickets/FEAT-kzej8t.md                       |  36 +
 .pine/tickets/FEAT-n762y6.md                       |  47 ++
 .pine/tickets/FEAT-rmh08k.md                       |  34 +
 .pine/tickets/FEAT-vh2bwz.md                       | 180 +++++
 .pine/tickets/FEAT-vvaycm.md                       |  37 ++
 .pine/tickets/FEAT-vwvgs0.md                       |  36 +
 .pine/tickets/FEAT-ybhdhz.md                       |  36 +
 .prettierignore                                    |  12 +
 AGENTS.md                                          |  26 +
 CLAUDE.md                                          |  26 +
 CODE_OF_CONDUCT.md                                 | 131 ++++
 CONTRIBUTING.md                                    | 191 ++++++
 LICENSE                                            |  31 +
 README.md                                          | 163 +++++
 THIRD-PARTY-LICENSES.md                            |  49 ++
 build/licenses/ffmpeg/COPYING.GPLv3                | 674 +++++++++++++++++++
 build/licenses/ffmpeg/README.md                    |  69 ++
 docs/PACKAGING.md                                  |  90 ++-
 docs/screenshots/01-welcome.png                    | Bin 0 -> 32645 bytes
 docs/screenshots/02-editor.png                     | Bin 0 -> 92473 bytes
 electron-builder.yml                               |  38 ++
 package-lock.json                                  | 730 +++++++++++++++++++--
 package.json                                       |  13 +-
 scripts/bundle-binaries.mjs                        |  57 ++
 scripts/capture-screenshots.mjs                    | 130 ++++
 scripts/verify-package.mjs                         | 107 ++-
 src/main/index.ts                                  |  19 +
 src/main/ipc/ai.ts                                 | 152 ++++-
 src/main/ipc/index.ts                              |   4 +-
 src/main/ipc/job-start-validation.ts               |  41 +-
 src/main/ipc/model.ts                              |  25 +-
 src/main/ipc/project.ts                            |  22 +-
 src/main/ipc/settings.ts                           |  98 ++-
 src/main/ipc/system.ts                             |  81 +++
 src/main/services/ai-client.ts                     | 275 ++++++--
 src/main/services/ass-captions.ts                  |  50 +-
 src/main/services/encoder-probe.ts                 |  64 ++
 src/main/services/ffmpeg-caption.ts                |   8 +-
 src/main/services/ffmpeg-export.ts                 |  75 ++-
 src/main/services/jobs/export-runner.ts            | 117 +++-
 src/main/services/jobs/generate-clips-runner.ts    | 136 ++++
 src/main/services/model-manager.ts                 |  27 +-
 src/main/services/openrouter-models.ts             |  37 +-
 src/main/services/project-store.ts                 |  54 +-
 src/main/services/provider-models.ts               | 146 +++++
 src/main/services/reframe-detect.ts                |  46 +-
 src/main/services/sidecar-manager.ts               |   5 +
 src/main/services/silence-detect.ts                |   4 +
 src/main/utils/paths.ts                            |  29 +-
 src/preload/api/files.ts                           |  35 +
 src/preload/index.ts                               |   7 +-
 src/renderer/src/App.tsx                           | 148 ++++-
 src/renderer/src/assets/index.css                  |  29 +
 src/renderer/src/components/BrandKitEditor.tsx     |  57 +-
 src/renderer/src/components/ClipCard.tsx           |  23 +
 src/renderer/src/components/ClipSidebar.tsx        | 103 ++-
 src/renderer/src/components/ExportPanel.tsx        | 167 ++++-
 src/renderer/src/components/ImportPanel.tsx        |  74 ++-
 src/renderer/src/components/JobStatusBar.tsx       | 256 ++++++++
 .../src/components/ModelDownloadDialog.tsx         | 100 ++-
 src/renderer/src/components/ReadinessBar.tsx       |  75 +++
 src/renderer/src/components/SettingsPanel.tsx      | 575 ++++++++++------
 .../src/components/TranscriptionSettings.tsx       | 176 +++++
 src/renderer/src/components/batch-export.ts        |   7 +
 src/renderer/src/components/clipView.ts            |  19 +-
 src/renderer/src/components/export-run.ts          |  14 +-
 src/renderer/src/components/formatBytes.ts         |  15 +
 src/renderer/src/components/generate-clips-run.ts  |  54 ++
 src/renderer/src/components/generateClips.ts       |  12 +-
 src/renderer/src/components/import-pipeline.ts     |  42 +-
 src/renderer/src/components/jobStatus.ts           | 322 +++++++++
 src/renderer/src/components/model-download.ts      |   7 +
 src/renderer/src/components/readinessView.ts       | 132 ++++
 src/renderer/src/components/settingsView.ts        |  95 ++-
 src/renderer/src/components/ui/dialog.tsx          |  25 +-
 src/renderer/src/hooks/import-controller.ts        | 234 +++++--
 src/renderer/src/hooks/importControllerHost.ts     |  42 ++
 src/renderer/src/hooks/jobPort.ts                  |  25 +-
 src/renderer/src/hooks/useImportController.ts      |  98 ++-
 src/renderer/src/hooks/useJob.ts                   | 150 +----
 src/renderer/src/hooks/useProject.ts               |   5 +
 src/renderer/src/hooks/useReadiness.ts             |  77 +++
 src/renderer/src/main.tsx                          |  12 +
 src/renderer/src/stores/jobNotifications.ts        |  90 +++
 src/renderer/src/stores/jobsStore.ts               | 249 +++++++
 src/renderer/src/stores/projectStore/autosave.ts   | 123 +++-
 src/renderer/src/stores/projectStore/clipsSlice.ts | 111 +++-
 .../src/stores/projectStore/exportSlice.ts         |  11 +-
 .../src/stores/projectStore/timelineSlice.ts       |  38 +-
 src/renderer/src/stores/uiStore.ts                 |  37 +-
 src/shared/channels.ts                             | 150 ++++-
 src/shared/clip-snap.ts                            | 149 +++++
 src/shared/jobs.ts                                 | 121 +++-
 src/shared/schema.ts                               |  10 +-
 tests/e2e/export.e2e.spec.ts                       |  27 +-
 tests/e2e/generate-clips-button.e2e.spec.ts        |  41 ++
 tests/e2e/integration-wave1.e2e.spec.ts            |  31 +-
 tests/e2e/job-status-bar.e2e.spec.ts               | 127 ++++
 tests/e2e/model-gate.e2e.spec.ts                   |  53 ++
 tests/e2e/ping.e2e.spec.ts                         |  72 +-
 tests/e2e/timeline.e2e.spec.ts                     |  27 +-
 tests/e2e/vertical-slice.e2e.spec.ts               |  75 ++-
 tests/fixtures/contract/index.ts                   |  19 +-
 tests/harness/fixtures.ts                          |  47 ++
 tests/harness/renderer-env.ts                      |  59 ++
 tests/mocks/openclip.ts                            |  47 +-
 tests/unit/ai-components.spec.ts                   |  57 +-
 tests/unit/ai-ipc.spec.ts                          | 160 ++++-
 tests/unit/ai-mapreduce.spec.ts                    | 231 +++++++
 tests/unit/ai-stores.spec.ts                       | 162 +++--
 tests/unit/ass-captions.serial.spec.ts             |  21 +-
 tests/unit/ass-playres.serial.spec.ts              | 116 ++++
 tests/unit/ass-playres.spec.ts                     | 127 ++++
 tests/unit/autosave-payload-size.spec.ts           | 158 +++++
 tests/unit/autosave-subscriber.spec.ts             |  79 ++-
 tests/unit/clip-reject-undo.spec.tsx               | 162 +++++
 tests/unit/clip-snap.spec.ts                       | 159 +++++
 tests/unit/contract.spec.ts                        |  24 +
 tests/unit/dialog-scroll.spec.tsx                  | 101 +++
 tests/unit/export-cancel.spec.tsx                  | 106 +++
 tests/unit/export-runner.spec.ts                   |  67 +-
 tests/unit/ffmpeg-export.serial.spec.ts            |  63 +-
 tests/unit/ffmpeg-export.spec.ts                   |  56 +-
 tests/unit/ffmpeg-version.serial.spec.ts           |  35 +-
 tests/unit/force-cpu.spec.ts                       | 160 +++++
 tests/unit/format-bytes.spec.ts                    |  25 +
 tests/unit/generate-clips-runner.spec.ts           | 188 ++++++
 tests/unit/generate-clips-view.spec.ts             |  23 +
 tests/unit/import-controller-host.spec.ts          |  56 ++
 tests/unit/import-controller.spec.ts               | 215 +++++-
 tests/unit/import-panel-drop.spec.tsx              | 136 ++++
 tests/unit/import-url.spec.ts                      |  21 +
 tests/unit/ipc-project.spec.ts                     |   7 +-
 tests/unit/job-notifications.spec.ts               | 131 ++++
 tests/unit/job-port-window-delivery.spec.tsx       |  81 +++
 tests/unit/job-status.spec.ts                      | 220 +++++++
 tests/unit/jobs-store.spec.ts                      | 208 ++++++
 tests/unit/model-manager.spec.ts                   |  30 +-
 tests/unit/onboarding-handlers.spec.ts             | 145 ++++
 tests/unit/openrouter-curated.serial.spec.ts       | 111 ++++
 tests/unit/preload-parity.spec.ts                  |  18 +-
 tests/unit/project-id-path-safety.spec.ts          | 104 +++
 tests/unit/project-store.spec.ts                   |   7 +-
 tests/unit/provider-models.spec.ts                 | 118 ++++
 tests/unit/readiness-view.spec.ts                  | 117 ++++
 tests/unit/reframe.serial.spec.ts                  |  35 +-
 tests/unit/settings-ipc.spec.ts                    | 134 ++++
 tests/unit/settings-panel-model-draft.spec.tsx     | 141 ++++
 tests/unit/settings-tabs.spec.tsx                  |  74 +++
 tests/unit/silence-detect.spec.ts                  |  11 +
 tests/unit/smoke-strict.spec.ts                    |  25 +-
 tests/unit/system-notify.spec.ts                   | 133 ++++
 tests/unit/use-import-controller.spec.tsx          | 145 ++++
 tests/unit/use-project.spec.ts                     |  11 +
 tests/unit/use-readiness.spec.tsx                  | 117 ++++
 tsconfig.test.json                                 |   1 +
 vitest.config.ts                                   |  12 +-
 226 files changed, 21422 insertions(+), 938 deletions(-)
```
