---
topic: perf-refuted
updated: 2026-08-08T15:59:25Z
---

# perf-refuted

- 2026-08-08: Adding '-hwaccel videotoolbox' to ffmpeg decode was measured and is NOT a win on Apple Silicon: 1080p exports got ~2% SLOWER (8.03s -> 8.17s per 60s clip). Software decode is the faster configuration here; do not re-file this as an optimisation. (cites: src/main/services/ffmpeg-core.ts)
- 2026-08-08: Timeline trim-drag is NOT a re-render storm: measured in the built app at a solid 60fps, ~1ms of work per pointer event, and exactly one .ocproj write 800ms after release. React 19 batching absorbs it. Do not 'optimise' it with rAF coalescing. (cites: src/renderer/src/components/Timeline.tsx)
- 2026-08-08: Streamed-transcript array appends in transcriptSlice are technically O(n^2) but measured at only ~100ms of total extra CPU across a full 2-hour transcription, because main batches partials at 25 words. Not user-perceptible; not worth restructuring. (cites: src/renderer/src/stores/projectStore/transcriptSlice.ts)
- 2026-08-08: MessagePortMain.postMessage on a closed or peer-destroyed port is a silent no-op in Electron 41 — it does NOT throw. The unguarded emit.progress/emit.partial calls in sidecar-manager cannot produce an uncaught main-process exception on renderer teardown. The job-termination invariant holds. (cites: src/main/services/sidecar-manager.ts)
