---
id: BUG-yq6qbw
title: Map-reduce silently discards failed chunks, and clip bounds never snap to sentence boundaries
status: todo
priority: medium
labels:
    - bug
    - ai
    - quality
parent: EPIC-4sa5jb
created: "2026-08-08T15:57:27Z"
updated: "2026-08-08T15:57:27Z"
---

## Verdict

**PARTIAL** (high confidence) · severity **P2**

This finding was produced by a finder agent and then handed to an independent adversarial
verifier whose instructions were to *refute* it, defaulting to REFUTED when uncertain. It
survived. Four sibling claims in the same pass did not — see `.pine/MEMORY.md`.

## User impact

Sub-claim 2 (the real one): a user imports a 1h+ podcast, clicks Generate Clips, asks for 10. Two or three chunks are sent; if one is refused by the provider, rate-limited into a malformed body, truncated, or content-filtered, its clips vanish. The UI shows "success" with 4 clips instead of 10 and no error, no toast, no main-process log. The user concludes the AI found nothing more in the second half of their video and either accepts a worse result or burns another full BYOK run debugging nothing. Note this also poisons the cache: `mapReduceGenerate` writes the partial result under `clipCacheKey` at line 540, so re-clicking Generate returns the same degraded set from cache without re-calling the provider — the user cannot retry their way out within the session.

Sub-claim 1: when the model returns an over-long span (violating the prompt cap), the clip is cut at exactly start+90s, which lands mid-word ~100% of the time — an audible chop on the last syllable. Frequency depends entirely on model compliance with an explicit instruction, so this is occasional rather than systematic, and the user can drag the trim handles to fix it. The broader "no sentence/word snapping assist anywhere" is a genuine quality gap against OpusClip-class output, but it is a missing feature, not a malfunction.

## Evidence

All code facts in the claim are accurate. The severity framing on the boundary half is overstated; the silent-failure half is fully confirmed.

== SUB-CLAIM 1: arbitrary clamp, no snapping — CONFIRMED as written, but it is a MISSING FEATURE on a guardrail path, not a defect that fires in the common path ==

src/main/services/ai-client.ts:319-329 (exact):
```
export function clampDetectedClips<T extends ClampInput>(clips: T[], opts: ClampOptions): T[] {
  const cleaned: T[] = []
  for (const c of clips) {
    const start = Math.max(0, Math.min(c.start_time, opts.duration))
    let end = Math.max(0, Math.min(c.end_time, opts.duration))
    if (end <= start) continue // drop inverted/zero-length
    // enforce max duration by truncating the end
    if (end - start > opts.maxDuration) end = start + opts.maxDuration
    if (end - start < opts.minDuration) continue // drop too-short
    cleaned.push({ ...c, start_time: start, end_time: end })
  }
```
`end = start + opts.maxDuration` — arithmetic only, no reference to segments or words. Confirmed.

No snapping exists anywhere. `grep -rniE "snap|sentence" src/` returns only: transcript sentence GROUPING (whisper-parse.ts:123 `groupSegments`), the transcript panel, and `src/shared/keep-ranges.ts:110` (silence-removal gap snapping — unrelated to clip bounds). Zero hits for clip-boundary snapping. Confirmed.

Raw AI times reach ffmpeg unmodified — src/shared/clip-bounds.ts:37-42:
```
export function resolveBounds(clip: Clip): ClipBounds {
  return { start: clip.editedStart ?? clip.startTime, end: clip.editedEnd ?? clip.endTime }
}
```

QUANTIFICATION (ran a throwaway vitest spec against the real `clampDetectedClips`, 400 realistic sentence segments of 3.0–6.9s, maxDuration=90, model emitting 120s spans that start on real segment boundaries):
```
truncated=76 endsOnSegmentBoundary=0 (0.0%)
below-min result length = 0
```
So: **conditional on truncation firing, it lands off any segment boundary ~100% of the time** (timestamps are continuous floats; hitting one is measure-zero). And a 14s clip with minDuration=15 is dropped, not extended. Both exactly as claimed.

WHY THIS IS WEAKER THAN THE CLAIM ASSERTS:
(a) The truncation branch only fires when the model VIOLATES an explicit prompt constraint — ai-client.ts:148: `CLIP DURATION: each clip must be between ${args.minDuration} and ${args.maxDuration} seconds.` It is a last-resort guardrail, not the primary source of clip boundaries. The primary source is the model echoing the segment timestamps it was shown (renderTranscript, line 114: `[${s.start.toFixed(2)}-${s.end.toFixed(2)}] ...`), which ARE sentence boundaries. The claim implies every clip end is arbitrary; that is not what the code does.
(b) Dropping a below-min clip is a deliberate, documented guardrail (header line 21: "enforce min/max duration"), and extending has its own failure mode (running into unrelated content / past maxDuration). Calling it a defect is a design opinion, not a bug.
(c) There is a real mitigation: the user can retrim by hand — src/renderer/src/stores/projectStore/timelineSlice.ts:35,63 `setClipBounds`. (No snap-assist during the drag either, which is the same missing feature.)

== SUB-CLAIM 2: silent partial chunk failure — CONFIRMED, unqualified ==

src/main/services/ai-client.ts:500-515 (exact):
```
  for (const chunk of chunks) {
    const result = await runRepairLadder(transport, {...})
    if (result.ok) { all.push(...result.value.clips) } else { lastError = result.error }
  }

  // If every chunk failed, surface the typed error (never a silent empty set).
  if (all.length === 0 && lastError) {
    return { ok: false, error: lastError }
  }
```
`lastError` is discarded whenever `all.length > 0`. There is not even a `console.warn` in the main process — genuinely silent.

The response shape cannot carry a warning. src/shared/channels.ts:257:
```
[IPCChannels.GENERATE_CLIPS]: ChannelPayload<GenerateClipsRequest, ClipSchema>
```
and src/shared/schema.ts:421-424: `ClipSchema = z.strictObject({ clips, analysis })`, where `ClipAnalysis` is only `{total_duration, clips_found, best_clip_index, overall_virality_potential}`. No warnings field, and it is a `strictObject` so one cannot be smuggled in.

Renderer discards nothing because nothing is sent — src/renderer/src/stores/projectStore/clipsSlice.ts:78-89:
```
const result = await window.openclip.ai.generateClips(req)
set({ clips: result.clips.map(detectedToClip), generating: false })
```

EMPIRICAL PROOF (real `mapReduceGenerate`, 600 segments → 9 chunks, only chunk 1 returns valid JSON, the other 8 return "sorry, I cannot help with that" on both the first call and the repair round-trip):
```
transport calls = 17   (1 + 8×2 = 17 → 8 of 9 chunks failed)
result = {"ok":true,"value":{"clips":[{...one clip...}],"analysis":{"clips_found":1,...}}}
```
The user asked for 10 clips, got 1, and the app reports full success.

REACHABILITY QUALIFICATION (the claim's "5-chunk video" is inflated): chunking only happens above `maxTokens: 10_000` (ai-client.ts:792), i.e. ~40k chars of segment text. At ~150 wpm / ~5.7 chars per word:
```
30 min -> ~6.4k est tokens -> 1 chunk
45 min -> ~9.6k est tokens -> 1 chunk
60 min -> ~12.8k est tokens -> 2 chunks
120 min -> ~25.7k est tokens -> 3 chunks
```
A 5-chunk video is ~3.5 hours. Single-chunk videos (< ~50 min) are NOT affected — a lone failing chunk hits `all.length === 0` and correctly surfaces INPUT_INVALID (covered by tests/unit/ai-mapreduce.spec.ts:280 "a single chunk that fails both rungs surfaces INPUT_INVALID"). So this is reachable in the normal user flow, but only for ~1 hour+ source video. That is the podcast/lecture case the app targets, so it is not a theoretical path.

TEST GAP: `grep -n "it(" tests/unit/ai-mapreduce.spec.ts` shows coverage for all-chunks-fail (line 280) and the cache, but there is NO test for the mixed success/failure case. The path is untested.

## Fix

Two independent fixes; only the first is a bug fix.

1) Surface partial chunk failure (the actual defect).
- src/shared/schema.ts: add an optional non-AI-facing warnings channel. Do NOT add it to `ClipSchema` (it is a `z.strictObject` consumed as the provider's structured-output schema — adding a field changes the JSON Schema sent to OpenAI/Anthropic/Ollama). Instead widen the CHANNEL result: in src/shared/channels.ts:257 change to `ChannelPayload<GenerateClipsRequest, ClipSchema & { warnings?: string[] }>` (or a new `GenerateClipsResult` type wrapping `{ result: ClipSchema; warnings: string[] }`), and update tests/unit/contract.spec.ts + preload-parity.spec.ts accordingly.
- src/main/services/ai-client.ts: change `LadderResult`'s ok branch (or `MapReduceRequest`'s return) to carry `failedChunks: number` and `lastError`. In the loop at 500-510 count failures; after 515, when `failedChunks > 0`, log main-side (`console.warn`) AND propagate a warning string like `${failedChunks} of ${chunks.length} transcript sections failed AI analysis (${lastError.message}) — fewer clips than requested.`
- Do NOT cache a partial result, or cache it keyed with the failure count: guard line 540 with `if (req.cache && req.cacheKey && failedChunks === 0)` so a retry actually re-calls the provider.
- src/main/ipc/ai.ts:~165 (`return result.value`): return the warnings alongside.
- src/renderer/src/stores/projectStore/clipsSlice.ts:78-89: store `generateWarnings` and render a non-blocking banner next to the clip list.

2) Boundary snapping (enhancement, ship separately).
- New pure module `src/shared/clip-snap.ts`: `snapToBoundaries(start, end, segments, words, {minDuration, maxDuration})`. Prefer the nearest sentence boundary from `TranscriptSegment[]` within a tolerance (~1.5s), fall back to the nearest word gap from `WordTimestamp[]`, fall back to the raw value. Never let a snap violate min/max.
- In ai-client.ts, do NOT bury this in `clampDetectedClips` (it is a pure, segment-free function used standalone). Apply it in `mapReduceGenerate` between line 519 (`reconciled`) and 520 (`clamped`), passing `req.segments` through — then let the existing clamp run as the final guardrail. For the over-long case, snap DOWN to the last sentence end at or before `start + maxDuration` rather than the raw arithmetic cut at line 326.
- For the below-min drop at line 327: optionally extend the end to the next sentence boundary first, and only drop if still below min after that.
- Also snap the trim-handle drag in src/renderer/src/stores/projectStore/timelineSlice.ts:63 via the same shared module.

## Regression test

In tests/unit/ai-mapreduce.spec.ts:

1) Partial-failure warning (fails today — currently returns ok:true with no signal):
```ts
it('reports how many chunks failed when SOME chunks succeed', async () => {
  let call = 0
  const transport: RawTransport = async () => {
    call++
    return call === 1
      ? { rawText: JSON.stringify({ clips: [clip(5, 40)], analysis: {...} }) }
      : { rawText: 'sorry, I cannot help with that' }
  }
  const res = await mapReduceGenerate(transport, {
    segments: segments(600), system: 's',
    buildUserPrompt: (ss) => ss.map((x) => x.text).join(' '),
    chunkOptions: { maxTokens: 2000, overlapSeconds: 10 },
    duration: 3000, minDuration: 15, maxDuration: 90, maxClips: 10
  })
  expect(res.ok).toBe(true)
  if (res.ok) {
    expect(res.value.clips).toHaveLength(1)
    expect(res.failedChunks).toBe(8)          // FAILS TODAY: property does not exist
    expect(res.warnings?.[0]).toMatch(/8 of 9/) // FAILS TODAY
  }
})
```
(I verified the setup above runs and today prints `transport calls = 17`, `ok:true`, one clip, `Object.keys(res.value) === ['clips','analysis']`.)

2) Partial result must not be cached (fails today — line 540 caches unconditionally):
```ts
it('does not serve a partially-failed run from cache', async () => {
  const cache = new Map()
  // first run: 1 of 3 chunks succeeds
  await mapReduceGenerate(flakyTransport, { ...req, cache, cacheKey: 'k' })
  expect(cache.has('k')).toBe(false)  // FAILS TODAY: cache.has('k') === true
})
```

3) Boundary snapping (fails today):
```ts
it('snaps a maxDuration truncation back to the previous sentence end', () => {
  const segs = /* sentences ending at 0, 4.2, 9.1, ..., 88.4, 93.0 */
  const out = /* pipeline with snapping */ ([clip(0, 200)], { duration: 300, minDuration: 15, maxDuration: 90, segments: segs })
  expect(out[0].end_time).toBe(88.4)   // FAILS TODAY: clampDetectedClips gives exactly 90
})
it('extends a below-min clip to the next sentence end instead of dropping it', () => {
  const out = /* pipeline */ ([clip(10, 24)], { duration: 600, minDuration: 15, maxDuration: 90, segments: /* boundary at 26.5 */ })
  expect(out).toHaveLength(1)          // FAILS TODAY: length 0 (verified empirically)
  expect(out[0].end_time).toBe(26.5)
})
```
