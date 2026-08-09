---
topic: renderer
updated: 2026-08-09T03:58:17Z
---

# renderer

- 2026-08-08: The import controller (renderer/src/hooks/useImportController.ts) is a MODULE SINGLETON, not per-component state. ImportPanel unmounts partway through a first-run import — App flips to the editor on the first transcript partial — so a per-component controller took the in-flight progress, cancel and error state with it. Anything that needs to observe or resume an in-flight import must go through the shared instance. (cites: src/renderer/src/hooks/useImportController.ts)
- 2026-08-08: Do not hardcode provider model catalogues. The curated OpenRouter pin list already shipped a retired model as the app's own top recommendation. Fetch each provider's /models endpoint (provider-models.ts); the only static entry left is one seed id in settingsView.DEFAULT_MODEL_BY_PROVIDER, used until the live list loads. (cites: src/main/services/provider-models.ts)
- 2026-08-09: A project committed at probe time means transcript partials stream into an OPEN project, so the autosave subscriber must suspend while an import runs (startAutosave isSuspended + resume). Otherwise every streamed partial changes the transcript ref and rewrites the whole .ocproj each debounce window. (cites: src/renderer/src/stores/projectStore/autosave.ts)
- 2026-08-09: Map-reduce job partials are PROVISIONAL — per-chunk clips are not de-overlapped across chunks, ranked or clamped. Render them from a separate store field (provisionalClips), never the persisted one, and REPLACE on the terminal done. Routing them through clips would both duplicate moments from overlapping chunk windows and get them autosaved into the .ocproj. (cites: src/renderer/src/stores/projectStore/clipsSlice.ts)
- 2026-08-09: Long jobs get exactly one user-visible surface: stores/jobsStore tracks ACTIVITIES (an import = url-download + probe + extract + transcribe = one row) at the orchestrator level, not inside the frozen drainJob seam. Anything new that runs for more than a second should wrap its orchestrator in trackTask rather than growing its own modal-local progress UI. (cites: src/renderer/src/stores/jobsStore.ts)
