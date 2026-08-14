---
id: BUG-yq6qbw
title: Map-reduce silently discards failed chunks, and clip bounds never snap to sentence boundaries
status: done
priority: medium
labels:
    - bug
    - ai
    - quality
parent: EPIC-4sa5jb
created: "2026-08-08T15:57:27Z"
updated: "2026-08-14T12:25:39Z"
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

## Empirical evidence — real OpenRouter run (2026-08-09)

Ran the app's own `ai-client` (real `createTransport` → OpenRouter, real
`mapReduceGenerate` → `clampDetectedClips`) against a 406s Bahasa Indonesia podcast
transcript with three deliberately planted viral moments.

**Moment recall was not the problem — both small models found 3/3.** The boundary
claim is what reproduced:

| model | clips | landed exactly on a segment boundary |
|---|---|---|
| `google/gemma-4-31b-it` | 4 | **4/4** |
| `google/gemini-3.5-flash-lite` | 3 | **0/3** — 71/105, 182/236, 294/353 |

The segment grid has boundaries at 72, 103, 184, 233, 294, 349… `gemini-3.5-flash-lite`
returned 71 and 105 — one second either side of the real sentence edges. Those clips
start a beat before the speaker opens their mouth and end a beat after, i.e. exactly
the mid-word cut this ticket is about. `gemma-4-31b-it` happened to align, so the
defect is **model-dependent and silent** — which is the worst shape for it, because
whether a user's clips cut cleanly depends on which model they typed into Settings.

Snapping to the word/segment grid in code (the data is already local) removes the
variance regardless of model. See `.pine/memory/competitor-precedent.md` for
SupoClip's sentence-boundary extension approach.

## Work Evidence

Closed by `pine close --evidence` on 2026-08-14.

- Base: `3ea7b027` (last commit at or before ticket created 2026-08-08)
- Commits (4):
  - `4a5bc230` — feat(clips): snap clip boundaries to speech, not to arithmetic (BUG-yq6qbw)
  - `e92a0700` — fix(ai): a failed transcript chunk is no longer silent, and no longer poisons the cache (BUG-yq6qbw)
  - `dbea17e2` — docs(pine): attach real-provider evidence to the clip-boundary and generate-timeout tickets
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
 .pine/tickets/BUG-yq6qbw.md                        | 212 ++++++
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
 src/renderer/src/stores/projectStore/autosave.ts   |  61 +-
 src/renderer/src/stores/projectStore/clipsSlice.ts | 111 +++-
 .../src/stores/projectStore/exportSlice.ts         |  11 +-
 .../src/stores/projectStore/timelineSlice.ts       |  38 +-
 src/renderer/src/stores/uiStore.ts                 |  37 +-
 src/shared/channels.ts                             | 130 +++-
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
 tests/unit/autosave-subscriber.spec.ts             |  73 +++
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
 tests/unit/job-notifications.spec.ts               | 131 ++++
 tests/unit/job-port-window-delivery.spec.tsx       |  81 +++
 tests/unit/job-status.spec.ts                      | 220 +++++++
 tests/unit/jobs-store.spec.ts                      | 208 ++++++
 tests/unit/model-manager.spec.ts                   |  30 +-
 tests/unit/onboarding-handlers.spec.ts             | 145 ++++
 tests/unit/openrouter-curated.serial.spec.ts       | 111 ++++
 tests/unit/preload-parity.spec.ts                  |  18 +-
 tests/unit/project-id-path-safety.spec.ts          | 104 +++
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
 221 files changed, 20864 insertions(+), 923 deletions(-)
```
