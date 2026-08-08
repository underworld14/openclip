---
id: FEAT-c0zn3j
title: '''Auto Generate Clips'' is a blocking invoke with no progress, no cancel, and no timeout — 2-6 minutes of a frozen button'
status: todo
priority: critical
labels:
    - ux
    - jobs
    - ai
parent: EPIC-zpa1nd
created: "2026-08-08T15:56:46Z"
updated: "2026-08-08T15:56:46Z"
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
