---
id: BUG-g6zq2t
title: Every clip edit rewrites the whole 3 MB project document including all word timestamps
status: todo
priority: medium
labels:
    - perf
    - autosave
parent: EPIC-c2gg45
created: "2026-08-08T15:57:27Z"
updated: "2026-08-08T15:57:27Z"
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
