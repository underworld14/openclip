---
id: BUG-2hjt1x
title: Importing a second video keeps the first project's clips — and autosave writes them into the new .ocproj
status: done
priority: high
labels:
    - bug
    - data-loss
    - import
parent: EPIC-4sa5jb
created: "2026-08-08T15:57:27Z"
updated: "2026-08-08T16:35:07Z"
---

## Verdict

**CONFIRMED** (high confidence) · severity **P1**

This finding was produced by a finder agent and then handed to an independent adversarial
verifier whose instructions were to *refute* it, defaulting to REFUTED when uncertain. It
survived. Four sibling claims in the same pass did not — see `.pine/MEMORY.md`.

## User impact

A user who imports a second video while a first project's clips are on screen (header "Import" / sidebar "New / Import") lands in the new project with the OLD project's clip cards still in the right sidebar, the old selection still active, and the old export history still counted. Within ~800 ms the autosave subscriber writes those foreign clips and export records into the NEW project's .ocproj, so the corruption is durable — reopening project B later shows project A's clips as if they belonged to B.

Worse than cosmetic: ExportPanel.tsx:128-152 / 217-233 build export jobs from `composeProject().sourceVideo` (video B) combined with the leaked `clips` (A's timestamps). Hitting "Export All" right after the second import re-encodes video B at video A's cut points, producing silently wrong clips with mismatched captions. The stale state self-heals only if the user runs "Auto Generate Clips" again (which replaces the clips array). Project A's own .ocproj is flush-saved correctly before the switch and is not damaged, so nothing is destroyed — but project B is born polluted.

## Evidence

STATIC — the two paths differ exactly as claimed.

src/renderer/src/hooks/import-controller.ts:266-271 (commit of a newly imported project):
    const sourceVideo = { ...result.sourceVideo, path: sourcePath, appOwned }
    const blank = deps.createBlankProject(name, sourceVideo)
    deps.store.setCurrentProject({ ...blank, id: projectId, transcript: result.transcript })
    markCommitted()
    deps.ui?.setView?.('editor')
Only `setCurrentProject`. No setClips / setExportHistory / selectClip(null).

src/renderer/src/hooks/useProject.ts:105-111 (the load/new path):
  export function hydrateFromProject(store: CoreStoreApi, project: Project): void {
    const state = store.getState()
    state.setCurrentProject(project)
    state.setTranscript(project.transcript)
    state.setClips(project.clips)
    state.setExportHistory(project.exportHistory)
  }

src/renderer/src/stores/projectStore/index.ts:55 — the core setter is document-only:
  setCurrentProject: (currentProject) => set({ currentProject }),

`grep -rn "setClips\|setExportHistory" src` returns ONLY the slice definitions and useProject.ts:109-110 — nothing else in the app ever resets those slices. The transcript slice IS reset (import-controller wires `onTranscript` → `store.hydrateTranscript`), which is why only clips / exportHistory / selectedClipId leak.

The import controller's React wiring (src/renderer/src/hooks/useImportController.ts:63-72) passes the raw store setters through, so there is no compensating reset in the wrapper.

AUTOSAVE — src/renderer/src/stores/projectStore/autosave.ts:92-106: the subscriber fires on `state.currentProject !== prev.currentProject` and saves `state.composeProject()`; src/renderer/src/stores/projectStore/exportSlice.ts:162-166 composes `{...currentProject, clips, transcript, exportHistory}` from the LIVE slices. So the very `setCurrentProject` that commits project B immediately schedules a write of B's id with A's clips.

EMPIRICAL — real Playwright Electron run against `out/main/index.js` (rebuilt with `npx electron-vite build`), isolated `--user-data-dir`, `OPENCLIP_FAKE_TRANSCRIBE=1`, whisper-model gate satisfied with a stub `models/ggml-base.bin`. Driven entirely through the PRODUCTION UI (typed a path into `import-file-input` + clicked `import-start`; clips via the real `auto-generate-clips` header button; second import via the header "Import" dialog — no test-only code path). Observed:

  projectA: id 0d39f58a-…-3e6c78604ffd, name "videoA.mp4", 2 clips [clip-mskj9psb-0, clip-mskj9psb-1] + 1 export record
  after importing /tmp/videoB.mp4:
    currentId       b7c57259-…-4a02ae211c73   (project B)
    currentName     "videoB.mp4"
    currentSource   "/tmp/videoB.mp4"
    docClips        0        <- the new blank doc is clean
    sliceClips      2        <- A's clips STILL in the clips slice
    sliceClipIds    ["clip-mskj9psb-0","clip-mskj9psb-1"]
    selectedClipId  "clip-mskj9psb-0"   <- selection also leaked
    exportHistory   1        <- A's export record leaked
    composedClips   2, composedId b7c57259-…  <- what autosave writes
    DOM clip-card count: 2   <- A's cards visibly on screen under project B

  .ocproj files actually on disk in userData/projects afterwards:
    0d39f58a-….ocproj  name "videoA.mp4"  source /tmp/videoA.mp4  clips 2  ids [clip-mskj9psb-0, clip-mskj9psb-1]  exportHistory 1
    b7c57259-….ocproj  name "videoB.mp4"  source /tmp/videoB.mp4  clips 2  ids [clip-mskj9psb-0, clip-mskj9psb-1]  exportHistory 1   <-- CORRUPTED

Autosave persisted A's clips AND A's export record into B's .ocproj, unprompted, with no user action beyond the import.

REACHABILITY: fully reachable for a normal user, no flag/harness. src/renderer/src/App.tsx:95-104 renders an "Import" header button whenever the editor is showing (i.e. precisely when a project is open) and App.tsx:135-138 a "New / Import" sidebar button; both open the ImportPanel dialog whose Enter/Import button calls `ctl.importAny` → `importFile` → the buggy commit. The load path (Dashboard → projectActions.open) is NOT affected — it goes through hydrateFromProject.

## Fix

Make the import commit go through the same full-slice hydration the load/new path uses.

1. src/renderer/src/hooks/import-controller.ts — widen the `ImportControllerStore` seam (around line 65) with the sibling-slice resets, and use them at the commit site:

     setCurrentProject(project: Project): void
     setClips(clips: Clip[]): void
     setExportHistory(history: ExportRecord[]): void
     selectClip(id: string | null): void

   then at ~line 266-271 replace the single call with a `commitProject(project)` that does all four (or simply inject `hydrateFromProject`-equivalent behaviour):

     const next = { ...blank, id: projectId, transcript: result.transcript }
     deps.store.setCurrentProject(next)
     deps.store.setClips(next.clips)          // []
     deps.store.setExportHistory(next.exportHistory)  // []
     deps.store.selectClip(null)

   Order matters for autosave: do the slice resets BEFORE `setCurrentProject`, or batch them, so the subscriber's first composeProject() for the new id already sees empty slices (otherwise the very first debounced write can still snapshot the stale clips — the debounce coalesces, so a single tick is enough, but resetting first removes the race entirely).

2. src/renderer/src/hooks/useImportController.ts (63-72) — wire the new seam members from `useProjectStore` (`setClips`, `setExportHistory`, `selectClip`), same stable-ref pattern as the existing ones.

3. Better long-term: export a `commitNewProject(store, project)` helper next to `hydrateFromProject` in useProject.ts and have BOTH paths call it, so the two can't drift again. Also consider resetting the timeline slice (trim/playhead) for the same reason.

## Regression test

Unit (fast, fails today) — tests/unit/import-controller.spec.ts already has a `build()` harness with a fake store. Add setClips/setExportHistory/selectClip spies to it and assert:

  it('resets the sibling slices when a new project is committed', async () => {
    const { ctl, setClips, setExportHistory, selectClip } = build()
    await ctl.importFile('/tmp/b.mp4')
    expect(setClips).toHaveBeenCalledWith([])
    expect(setExportHistory).toHaveBeenCalledWith([])
    expect(selectClip).toHaveBeenCalledWith(null)
  })

Integration (store-level, no Electron) — with the real `useProjectStore`:
  seed setCurrentProject(projectA) + setClips([clipA]) + setExportHistory([recA]);
  run createImportController wired to the real store with a stubbed runImportPipeline;
  await ctl.importFile('/tmp/b.mp4');
  expect(store.getState().clips).toEqual([])
  expect(store.getState().composeProject()!.clips).toEqual([])   // this is the autosave payload — fails today with [clipA]

E2E regression (the one I ran, kept trimmed) — launch out/main/index.js with OPENCLIP_FAKE_TRANSCRIBE=1 and an isolated --user-data-dir containing a stub models/ggml-base.bin; import /tmp/videoA.mp4 through `import-file-input`, click `auto-generate-clips`, then import /tmp/videoB.mp4 through the header Import dialog; after the autosave debounce assert `win.getByTestId('clip-card')` has count 0 and that JSON.parse(userData/projects/<Bid>.ocproj).clips is []. Today: 2 cards and 2 clips in B's file.

## Work Evidence

Closed by `pine close --evidence` on 2026-08-08.

- Base: `3ea7b027` (last commit at or before ticket created 2026-08-08)
- Commits (2):
  - `caa1e357` — fix(import): hydrate every slice on import so the previous project cannot leak in (BUG-2hjt1x)
  - `3c7d68c2` — chore(pine): adopt pine issue tracking + file the multi-agent audit backlog
- Files changed (base → working tree):

```
 .agents/skills/pine/SKILL.md                  | 145 ++++++++++++++++
 .claude/settings.json                         |  15 +-
 .claude/skills/pine/SKILL.md                  | 145 ++++++++++++++++
 .codex/hooks.json                             |  14 ++
 .codex/hooks/pine-learn-reminder.sh           |   6 +
 .cursor/hooks.json                            |  10 ++
 .cursor/hooks/pine-learn-reminder.sh          |   6 +
 .github/ISSUE_TEMPLATE/bug_report.md          |  30 ++++
 .github/ISSUE_TEMPLATE/feature_request.md     |  15 ++
 .github/pull_request_template.md              |  24 +++
 .github/workflows/ci.yml                      |  82 +++++++++
 .pine/.gitignore                              |   4 +
 .pine/MEMORY.md                               |  13 ++
 .pine/board.json                              |   1 +
 .pine/config.json                             |   1 +
 .pine/memory/competitor-precedent.md          |  10 ++
 .pine/memory/perf-refuted.md                  |  11 ++
 .pine/prompts/fix.md                          |  22 +++
 .pine/templates/bug.md                        |  14 ++
 .pine/templates/epic.md                       |   3 +
 .pine/templates/feature.md                    |  12 ++
 .pine/tickets/BUG-19bt2k.md                   |  58 +++++++
 .pine/tickets/BUG-2hjt1x.md                   | 126 ++++++++++++++
 .pine/tickets/BUG-2smqpv.md                   |  31 ++++
 .pine/tickets/BUG-88mac4.md                   | 210 +++++++++++++++++++++++
 .pine/tickets/BUG-e06a9d.md                   | 122 ++++++++++++++
 .pine/tickets/BUG-ery7v7.md                   | 233 ++++++++++++++++++++++++++
 .pine/tickets/BUG-g6zq2t.md                   | 104 ++++++++++++
 .pine/tickets/BUG-j8pbj9.md                   |  46 +++++
 .pine/tickets/BUG-t1xj4d.md                   | 134 +++++++++++++++
 .pine/tickets/BUG-y6y5mf.md                   |  78 +++++++++
 .pine/tickets/BUG-yq6qbw.md                   | 187 +++++++++++++++++++++
 .pine/tickets/BUG-yxvrwx.md                   |  80 +++++++++
 .pine/tickets/EPIC-4sa5jb.md                  |  14 ++
 .pine/tickets/EPIC-9gkehb.md                  |  15 ++
 .pine/tickets/EPIC-c2gg45.md                  |  14 ++
 .pine/tickets/EPIC-f953vk.md                  |  15 ++
 .pine/tickets/EPIC-n6ndb8.md                  |  15 ++
 .pine/tickets/EPIC-xzzpty.md                  |  15 ++
 .pine/tickets/EPIC-zpa1nd.md                  |  15 ++
 .pine/tickets/FEAT-0s2tnc.md                  |  36 ++++
 .pine/tickets/FEAT-1k76hk.md                  |  36 ++++
 .pine/tickets/FEAT-51hnwx.md                  |  36 ++++
 .pine/tickets/FEAT-56bxyh.md                  |  35 ++++
 .pine/tickets/FEAT-5hnsby.md                  |  36 ++++
 .pine/tickets/FEAT-6v92dk.md                  |  50 ++++++
 .pine/tickets/FEAT-71ay4e.md                  |  36 ++++
 .pine/tickets/FEAT-7ffxsg.md                  |  36 ++++
 .pine/tickets/FEAT-8559h1.md                  |  36 ++++
 .pine/tickets/FEAT-905vk4.md                  |  36 ++++
 .pine/tickets/FEAT-az3sxm.md                  |  36 ++++
 .pine/tickets/FEAT-bd87vz.md                  |  38 +++++
 .pine/tickets/FEAT-c0zn3j.md                  |  37 ++++
 .pine/tickets/FEAT-c5a15c.md                  |  36 ++++
 .pine/tickets/FEAT-ckxz8d.md                  |  36 ++++
 .pine/tickets/FEAT-d8b6bj.md                  |  44 +++++
 .pine/tickets/FEAT-et1gxc.md                  |  36 ++++
 .pine/tickets/FEAT-g39qj3.md                  |  36 ++++
 .pine/tickets/FEAT-hmsg5h.md                  |  36 ++++
 .pine/tickets/FEAT-k28j7h.md                  |  37 ++++
 .pine/tickets/FEAT-kncqxf.md                  |  46 +++++
 .pine/tickets/FEAT-ks4yy4.md                  |  43 +++++
 .pine/tickets/FEAT-ky1jfw.md                  |  49 ++++++
 .pine/tickets/FEAT-kzej8t.md                  |  36 ++++
 .pine/tickets/FEAT-n762y6.md                  |  47 ++++++
 .pine/tickets/FEAT-rmh08k.md                  |  34 ++++
 .pine/tickets/FEAT-vvaycm.md                  |  37 ++++
 .pine/tickets/FEAT-vwvgs0.md                  |  36 ++++
 .pine/tickets/FEAT-ybhdhz.md                  |  36 ++++
 AGENTS.md                                     |  26 +++
 CLAUDE.md                                     |  26 +++
 src/main/services/ffmpeg-export.ts            |  50 +++++-
 src/main/services/silence-detect.ts           |   4 +
 src/renderer/src/App.tsx                      |   6 +-
 src/renderer/src/components/generateClips.ts  |  12 +-
 src/renderer/src/hooks/import-controller.ts   |  16 +-
 src/renderer/src/hooks/useImportController.ts |  13 +-
 src/renderer/src/hooks/useProject.ts          |   5 +
 tests/e2e/generate-clips-button.e2e.spec.ts   |  30 ++++
 tests/e2e/ping.e2e.spec.ts                    |  64 ++++---
 tests/unit/ffmpeg-export.serial.spec.ts       |  44 ++++-
 tests/unit/ffmpeg-export.spec.ts              |  56 ++++++-
 tests/unit/generate-clips-view.spec.ts        |  23 +++
 tests/unit/import-controller.spec.ts          |  25 ++-
 tests/unit/silence-detect.spec.ts             |  11 ++
 tests/unit/use-project.spec.ts                |  12 ++
 86 files changed, 3581 insertions(+), 46 deletions(-)
```
