---
id: BUG-ery7v7
title: '''Remove silences'' export decodes the source to EOF — 19x the frames for a byte-identical file'
status: done
priority: high
labels:
    - perf
    - ffmpeg
    - export
parent: EPIC-c2gg45
created: "2026-08-08T15:57:27Z"
updated: "2026-08-08T16:21:12Z"
---

## Verdict

**CONFIRMED** (high confidence) · severity **P1**

This finding was produced by a finder agent and then handed to an independent adversarial
verifier whose instructions were to *refute* it, defaulting to REFUTED when uncertain. It
survived. Four sibling claims in the same pass did not — see `.pine/MEMORY.md`.

## User impact

A user who ticks "Remove silences" (or uses split-screen auto-reframe together with silence removal) pays a decode cost proportional to how much source lies AFTER their clip, not to the clip length. Measured decode-to-EOF throughput on this M-series machine for 1080p/30/6Mbps is ~43x realtime, so for OpenClip's actual target input (a 1-3 hour podcast/long-form video — the product premise) a 30 s clip taken 5 minutes in forces a full decode of the remaining ~2 hours: roughly 2.5-3 minutes of extra wall time and ~5 GB of extra disk reads PER CLIP, on top of ~3 s of real work. Exporting 10 clips from one long video turns ~1 minute of work into ~30 minutes. Worse: the progress bar reaches ~98% within seconds and then sits completely frozen for the entire drain (empirically verified: out_time_ms stuck at 19700000 for 7.6 s on a 5-minute source; minutes on a 2-hour source), so the export reads as a hang and users will hit Cancel and lose the export. The output file itself is correct (byte-identical to the fixed version) — this is pure wasted work plus an apparent freeze. Short sources (<10 min) only lose a few seconds, so the bug is invisible in the fixture-sized smoke tests.

## Evidence

CODE (argv shape verified by calling the real builders, not by eyeballing):

/Users/izzadev/projects/openclip/src/main/services/ffmpeg-export.ts:512-521 (exportClipArgsMultiRange):
    return [
      '-hide_banner', '-y',
      '-ss', String(opts.startTime),
      '-i', opts.sourcePath,
      ...extraInputs,
      '-t', String(duration),          // <-- line 520-521: OUTPUT option
      '-filter_complex', `${vchain};${achain}`, ...

/Users/izzadev/projects/openclip/src/main/services/ffmpeg-export.ts:614-624 (exportClipArgsSplit): identical shape, '-t' at line 623 after '-i'.

Real argv dumped by invoking exportClipArgsMultiRange({startTime:5,endTime:35,keepRanges:[[5,15],[20,30]],forceCpu:true,...}) through vitest (temp spec, since deleted):
  -hide_banner -y -ss 5 -i /SRC -t 30 -filter_complex
  "[0:v]crop=ih*9/16:ih,select='between(t,0,10)+between(t,15,25)',setpts=N/FRAME_RATE/TB,scale=1080:1920[v];
   [0:a]aselect='between(t,0,10)+between(t,15,25)',asetpts=N/SR/TB[a]" -map [v] -map [a] ...

EMPIRICAL (ffmpeg 8.1.2, homebrew, this machine). Built a 600s 640x360@30 source and a 300s 1920x1080@30 source with testsrc2+sine. Ran the EXACT argv shape and counted input packets/frames actually decoded via `-v verbose` ("packets read" summary):

600s source, clip [5,35], keep 20s of 30s:
  ARM A (-t AFTER -i, i.e. current code):
    Input stream #0:0 (video): 17880 packets read (147160669 bytes); 17880 frames decoded
    Input stream #0:1 (audio): 25668 packets read
    real 1.81  user 9.64
  ARM B (identical, but '-t 30' moved BEFORE '-i'):
    Input stream #0:0 (video): 953 packets read (7832974 bytes); 934 frames decoded
    Input stream #0:1 (audio): 1341 packets read
    real 1.80  user 5.63
  Outputs BYTE-IDENTICAL: md5 A3.mp4 == md5 B3.mp4 == a815ce9c4eb67f151b2730f67da22896, both 20.066667 s.
  => 17880 video frames = 595 s x 30 fps = the ENTIRE remainder of the source, for a 30 s clip. 19x the frames, 19x the bytes, for a bit-identical file.

1080p 300s source, same clip, real default codec (h264_videotoolbox):
  ARM A: 8880 video packets read (222002933 bytes); real 9.14  user 26.82
  ARM B: 951 video packets read (23777737 bytes);  real 2.92  user 4.39
  Both outputs 20.066667 s. => 3.1x wall, 6.1x CPU, 9.3x disk read, on a source only 5 minutes long.

SPLIT path (line 623), same 1080p source:
  with select (removing=true):  8880 packets read; real 15.34   <-- whole source
  without select (removing=false): 953 packets read; real 8.19  <-- correct

CONTROL — proves `select` is the cause and the single-cut path is FINE:
  single-cut argv (-ss 5 -i src -to 30 -vf crop,scale, no select): 953 packets read. Bounded correctly.
  -t after -i WITH a select that keeps everything: video 951 packets read (bounded), audio 25668 (whole file).

PROGRESS-BAR SYMPTOM (timestamped `-progress pipe:2` stream, 1080p 300s source, exact app argv):
   5.04s  out_time_ms=19700000
   5.55s  out_time_ms=19700000
   ... (frozen, 16 consecutive identical samples) ...
  12.59s  out_time_ms=19700000
  12.65s  out_time_ms=19984671   <- then exit
  i.e. progress hits 98% at 5 s and sits frozen for 7.6 s while ffmpeg drains the remaining 265 s of source.

MECHANISM: `-t` after `-i` bounds OUTPUT time. select/aselect drop frames and setpts=N/FRAME_RATE/TB re-stamps the survivors, so output time only ever reaches keptDuration < duration. The output `-t duration` limit is therefore NEVER reached, no output stream is ever marked finished, and ffmpeg demuxes+decodes to source EOF.

STALE DOC: the TRADE-OFFS comment at ffmpeg-export.ts:471-473 says "No `-ss`: ... the source is decoded from 0 ... Cost scales with the clip's distance into the source." That is wrong twice over — the code DOES pass `-ss` (line 515), and the real cost scales with the distance from the clip END to source EOF, which is the opposite direction and unbounded.

REACHABILITY: fully reachable from normal UI, no flag, no test harness. src/renderer/src/components/ExportPanel.tsx:387-394 renders the checkbox `data-testid="remove-silence-toggle"` — "Remove silences (tighten the clip)". It flows ExportPanel:165 -> exportSlice.ts:140 -> JobParams['export'].removeSilence (src/shared/jobs.ts:155) -> export-runner.ts:161-181, which sets keepRanges only when `removesAnything(...)` is true — i.e. exactly when the select filter appears. ffmpeg-export.ts:726-742 then routes to exportClipArgsMultiRange (or exportClipArgsSplit when reframe='split'). Any real talking-head source has silences, so ticking the box is the trigger.

## Fix

Move `-t <duration>` from an output option to an INPUT option (before `-i <source>`), so the demuxer stops reading at the clip end regardless of what the filtergraph drops. Verified byte-identical output (same md5) with a 19x reduction in frames decoded.

1) /Users/izzadev/projects/openclip/src/main/services/ffmpeg-export.ts:512-521 (exportClipArgsMultiRange) — change
     '-ss', String(opts.startTime),
     '-i', opts.sourcePath,
     ...extraInputs,
     '-t', String(duration),
   to
     '-ss', String(opts.startTime),
     // INPUT-side duration: bounds DEMUXING. As an output option it never fires,
     // because select/setpts compress the output timeline below `duration`, so
     // ffmpeg would read the source to EOF.
     '-t', String(duration),
     '-i', opts.sourcePath,
     ...extraInputs,
   (`-t` must sit before the SOURCE `-i`, not before the logo `...extraInputs` — input options bind to the next `-i`.)

2) /Users/izzadev/projects/openclip/src/main/services/ffmpeg-export.ts:614-624 (exportClipArgsSplit) — identical move; the split path only needs it when `removing` is true but moving it unconditionally is harmless and keeps one shape.

3) Optional but recommended: also fix the stale TRADE-OFFS comment at ffmpeg-export.ts:471-473 ("No `-ss`" is false — line 515 passes `-ss`).

Non-goals / do not change: exportClipArgs (single-cut) at line 444 uses `-to` after `-i` and is empirically bounded correctly (953 packets read) — leave it alone. The analysis passes (silence-detect.ts, reframe-detect.ts) also put `-t` after `-i` but have no frame-dropping filter, so they are bounded too.

Blast radius: the existing assertions in tests/unit/ffmpeg-export.spec.ts:232 and :300 use `args[args.indexOf('-t') + 1]`, which is position-agnostic and still passes after the move.

## Regression test

Two layers; the first is the cheap regression guard, the second proves the actual behaviour.

(a) Pure argv unit test — add to tests/unit/ffmpeg-export.spec.ts. Fails today, passes after the fix:

  it('bounds DEMUXING: -t is an INPUT option on the jump-cut paths (select never lets output reach -t)', () => {
    for (const args of [
      exportClipArgsMultiRange({ ...base, keepRanges }),
      exportClipArgsSplit({ ...base, keepRanges, reframePlan: splitPlan })
    ]) {
      expect(args.indexOf('-t')).toBeGreaterThan(-1)
      // must precede the SOURCE input, else ffmpeg reads to EOF
      expect(args.indexOf('-t')).toBeLessThan(args.indexOf('-i'))
      expect(args[args.indexOf('-t') + 1]).toBe('28.5')
    }
  })

(b) Real-binary regression in a `*.serial.spec.ts` @serial smoke (skipIf no ffmpeg). Generate a source whose tail is much longer than the clip, run the real builder's argv, and assert ffmpeg did not decode the tail — parse ffmpeg's own accounting rather than timing, so it is not flaky:

  // 60 s source; export a 5 s clip at t=1 with keepRanges that drop 2 s.
  await run(['-f','lavfi','-i','testsrc2=size=320x180:rate=30:duration=60',
             '-f','lavfi','-i','sine=duration=60','-c:v','libx264','-preset','ultrafast',
             '-pix_fmt','yuv420p','-c:a','aac','-shortest', src])
  const args = exportClipArgsMultiRange({ sourcePath: src, outputPath: out, startTime: 1, endTime: 6,
                                          keepRanges: [[1,3],[4,6]], aspectRatio: '9:16', forceCpu: true, quality: 'medium' })
  const stderr = await capture('ffmpeg', ['-v','verbose', ...args])
  const decoded = Number(/Input stream #0:0 \(video\): \d+ packets read \([^)]+\); (\d+) frames decoded/.exec(stderr)![1])
  expect(decoded).toBeLessThan(300)   // ~5 s @30fps + keyframe slack; today it is ~1800 (the whole 60 s)
  // and the output must be unchanged by the fix:
  expect(await probeDuration(out)).toBeCloseTo(4.0, 1)

Baseline I measured for exactly this shape on a 600 s source: 17880 frames decoded before the fix, 934 after, with md5-identical output.

## Work Evidence

Closed by `pine close --evidence` on 2026-08-08.

- Base: `3ea7b027` (last commit at or before ticket created 2026-08-08)
- Commits (2):
  - `ec7113cc` — perf(ffmpeg): stop decoding to EOF on silence-removal exports (BUG-ery7v7, BUG-88mac4)
  - `3c7d68c2` — chore(pine): adopt pine issue tracking + file the multi-agent audit backlog
- Files changed (base → working tree):

```
 .agents/skills/pine/SKILL.md            | 145 +++++++++++++++++++++++++
 .claude/settings.json                   |  15 ++-
 .claude/skills/pine/SKILL.md            | 145 +++++++++++++++++++++++++
 .codex/hooks.json                       |  14 +++
 .codex/hooks/pine-learn-reminder.sh     |   6 +
 .cursor/hooks.json                      |  10 ++
 .cursor/hooks/pine-learn-reminder.sh    |   6 +
 .pine/.gitignore                        |   4 +
 .pine/MEMORY.md                         |  13 +++
 .pine/board.json                        |   1 +
 .pine/config.json                       |   1 +
 .pine/memory/competitor-precedent.md    |  10 ++
 .pine/memory/perf-refuted.md            |  11 ++
 .pine/prompts/fix.md                    |  22 ++++
 .pine/templates/bug.md                  |  14 +++
 .pine/templates/epic.md                 |   3 +
 .pine/templates/feature.md              |  12 ++
 .pine/tickets/BUG-19bt2k.md             |  58 ++++++++++
 .pine/tickets/BUG-2hjt1x.md             | 126 +++++++++++++++++++++
 .pine/tickets/BUG-2smqpv.md             |  31 ++++++
 .pine/tickets/BUG-88mac4.md             | 124 +++++++++++++++++++++
 .pine/tickets/BUG-e06a9d.md             | 122 +++++++++++++++++++++
 .pine/tickets/BUG-ery7v7.md             | 147 +++++++++++++++++++++++++
 .pine/tickets/BUG-g6zq2t.md             | 104 ++++++++++++++++++
 .pine/tickets/BUG-j8pbj9.md             |  46 ++++++++
 .pine/tickets/BUG-t1xj4d.md             | 134 +++++++++++++++++++++++
 .pine/tickets/BUG-y6y5mf.md             |  78 +++++++++++++
 .pine/tickets/BUG-yq6qbw.md             | 187 ++++++++++++++++++++++++++++++++
 .pine/tickets/BUG-yxvrwx.md             |  80 ++++++++++++++
 .pine/tickets/EPIC-4sa5jb.md            |  14 +++
 .pine/tickets/EPIC-9gkehb.md            |  15 +++
 .pine/tickets/EPIC-c2gg45.md            |  14 +++
 .pine/tickets/EPIC-f953vk.md            |  15 +++
 .pine/tickets/EPIC-n6ndb8.md            |  15 +++
 .pine/tickets/EPIC-xzzpty.md            |  15 +++
 .pine/tickets/EPIC-zpa1nd.md            |  15 +++
 .pine/tickets/FEAT-0s2tnc.md            |  36 ++++++
 .pine/tickets/FEAT-1k76hk.md            |  36 ++++++
 .pine/tickets/FEAT-51hnwx.md            |  36 ++++++
 .pine/tickets/FEAT-56bxyh.md            |  35 ++++++
 .pine/tickets/FEAT-5hnsby.md            |  36 ++++++
 .pine/tickets/FEAT-6v92dk.md            |  50 +++++++++
 .pine/tickets/FEAT-71ay4e.md            |  36 ++++++
 .pine/tickets/FEAT-7ffxsg.md            |  36 ++++++
 .pine/tickets/FEAT-8559h1.md            |  36 ++++++
 .pine/tickets/FEAT-905vk4.md            |  36 ++++++
 .pine/tickets/FEAT-az3sxm.md            |  36 ++++++
 .pine/tickets/FEAT-bd87vz.md            |  38 +++++++
 .pine/tickets/FEAT-c0zn3j.md            |  37 +++++++
 .pine/tickets/FEAT-c5a15c.md            |  36 ++++++
 .pine/tickets/FEAT-ckxz8d.md            |  36 ++++++
 .pine/tickets/FEAT-d8b6bj.md            |  44 ++++++++
 .pine/tickets/FEAT-et1gxc.md            |  36 ++++++
 .pine/tickets/FEAT-g39qj3.md            |  36 ++++++
 .pine/tickets/FEAT-hmsg5h.md            |  36 ++++++
 .pine/tickets/FEAT-k28j7h.md            |  37 +++++++
 .pine/tickets/FEAT-kncqxf.md            |  46 ++++++++
 .pine/tickets/FEAT-ks4yy4.md            |  43 ++++++++
 .pine/tickets/FEAT-ky1jfw.md            |  49 +++++++++
 .pine/tickets/FEAT-kzej8t.md            |  36 ++++++
 .pine/tickets/FEAT-n762y6.md            |  47 ++++++++
 .pine/tickets/FEAT-rmh08k.md            |  34 ++++++
 .pine/tickets/FEAT-vvaycm.md            |  37 +++++++
 .pine/tickets/FEAT-vwvgs0.md            |  36 ++++++
 .pine/tickets/FEAT-ybhdhz.md            |  36 ++++++
 AGENTS.md                               |  26 +++++
 CLAUDE.md                               |  26 +++++
 src/main/services/ffmpeg-export.ts      |  50 +++++++--
 src/main/services/silence-detect.ts     |   4 +
 tests/unit/ffmpeg-export.serial.spec.ts |  44 +++++++-
 tests/unit/ffmpeg-export.spec.ts        |  56 +++++++++-
 tests/unit/silence-detect.spec.ts       |  11 ++
 72 files changed, 3087 insertions(+), 11 deletions(-)
```
