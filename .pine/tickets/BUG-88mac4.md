---
id: BUG-88mac4
title: silencedetect decodes the video stream for an audio-only measurement (missing -vn)
status: todo
priority: medium
labels:
    - perf
    - ffmpeg
parent: EPIC-c2gg45
created: "2026-08-08T15:57:27Z"
updated: "2026-08-08T15:57:27Z"
---

## Verdict

**CONFIRMED** (high confidence) · severity **P2**

This finding was produced by a finder agent and then handed to an independent adversarial
verifier whose instructions were to *refute* it, defaulting to REFUTED when uncertain. It
survived. Four sibling claims in the same pass did not — see `.pine/MEMORY.md`.

## User impact

A user who ticks "Remove silences (tighten the clip)" in the export panel waits longer and burns needless CPU/battery on every clip export. Measured on this machine: +1.1 s per 60 s 1080p clip, +3.2-3.5 s per 120 s 1080p clip, +2.35 s per 60 s 4K clip, against a ~8 s encode for the same 60 s clip — i.e. a 13-30% longer export, and 40 billion extra CPU cycles (vs 0.7 billion needed) spent decoding video frames that are thrown straight into a null sink. On a batch of 10 clips from a 4K source that is ~23 s of pure waste plus the fan/battery cost. Nothing is wrong with the output; it is slower and hotter than it needs to be.

## Evidence

CODE — /Users/izzadev/projects/openclip/src/main/services/silence-detect.ts:35-50, the argv builder, verbatim:

    return [
      '-hide_banner',
      '-nostats',
      '-ss',
      String(startTime),
      '-i',
      assertSafePathArg(sourcePath, 'sourcePath'),
      '-t',
      String(durationSec),
      '-af',
      `silencedetect=noise=${noiseDb}dB:d=${minSilence}`,
      '-f',
      'null',
      '-'
    ]

No '-vn'. ffmpeg's default stream selection therefore maps the video stream too. Proved with the real binary (ffmpeg 8.1.2, homebrew, Apple Silicon):

  $ ffmpeg -hide_banner -nostats -ss 0 -i long1080.mp4 -t 5 -af silencedetect=noise=-30dB:d=0.6 -f null -
  Stream mapping:
    Stream #0:0 -> #0:0 (h264 (native) -> wrapped_avframe (native))
    Stream #0:1 -> #0:1 (aac (native) -> pcm_s16le (native))

The h264 stream is fully decoded for a purely audio measurement.

MEASUREMENTS (each argv run verbatim as the builder emits it; the only delta is '-vn' inserted after the input). Fixtures generated under the scratchpad: long1080.mp4 = 120 s 1920x1080 h264/aac 87 MB; gaps.mp4 = 120 s 1080p with 2 s tone / 1.8 s silence alternation; uhd.mp4 = 60 s 3840x2160.

  120 s span, 1080p (long1080.mp4)
    current run1 3.305 s | run2 3.180 s | run3 3.520 s
    with -vn  run1 0.149 s | run2 0.140 s | run3 0.130 s        -> ~23x

  60 s span, 1080p (gaps.mp4, -ss 12 -t 60)
    current 1.100 s / 1.201 s
    with -vn 0.074 s / 0.085 s                                   -> ~14x

  60 s span, 4K (uhd.mp4)
    current 2.35 s
    with -vn 0.078 s                                             -> ~30x

  /usr/bin/time -l on the 120 s 1080p run:
    current: 109,230,359,232 instructions retired, 40,356,124,642 cycles, 104 MB peak RSS
    -vn:      1,429,642,933 instructions retired,     704,467,636 cycles,  11.7 MB peak RSS
    -> 76x fewer instructions, 57x fewer cycles, 9x less memory.

BEHAVIOUR IS IDENTICAL — diffed the silencedetect stderr with and without '-vn' on gaps.mp4 (-ss 7.5 -t 60): all 30 silence_start/silence_end lines byte-identical (2.7 / 4.500021 / 6.7 / 8.500021 … 58.7 / 60.041333). The only diff is the filter-instance pointer in the log prefix (0xa09059b00 vs 0xa32c10a80).

REACHABILITY — fully reachable from the normal UI, opt-in:
  src/renderer/src/components/ExportPanel.tsx:105  const [removeSilence, setRemoveSilence] = useState(false)
  src/renderer/src/components/ExportPanel.tsx:387-393  checkbox data-testid="remove-silence-toggle", label "Remove silences (tighten the clip)"
  -> ExportPanel.tsx:165 removeSilence -> exportSlice.ts:140 -> src/shared/jobs.ts:155
  src/main/services/jobs/export-runner.ts:164-176:
      if (!params.removeSilence) return undefined
      ...
      const silences = await detectSilences({ sourcePath, startTime, endTime, ... })
  So: once per export, exactly when the user ticks the box. Not a test-only path, not behind a dev flag. Default is off, so it does not hit every export.

CONTEXT for severity — the wasted pass is a fraction of the export, not the whole thing. A representative 60 s export re-encode (crop+scale to 1080x1920, libx264 veryfast crf 20, aac) measured 8.19 s on the same machine, so the wasted video decode adds ~13% (1080p) to ~29% (4K) wall time to a silence-removal export. It also runs inside the Promise.all at export-runner.ts:163, concurrent with the reframe analysis pass, so when reframe is also enabled part of the 1-3.5 s is hidden behind the (slower) face-detect pass and only the CPU burn remains.

EDGE CASE I found while testing the fix (affects the fix, not the claim): on a source with NO audio track, the current argv exits 0 (video absorbs the mapping, -af unused), while adding '-vn' makes ffmpeg exit 234 ("output file does not contain any stream"), which would make detectSilences reject instead of returning []. Net user-visible behaviour is unchanged because export-runner.ts:180-183 catches and falls back to "no cut", but the fix should handle it deliberately.

## Fix

/Users/izzadev/projects/openclip/src/main/services/silence-detect.ts:35-50 — insert '-vn' as an output option (after the input, before '-af'):

    '-i',
    assertSafePathArg(sourcePath, 'sourcePath'),
    '-vn',                       // audio-only measurement: don't decode/null-encode video
    '-t',
    String(durationSec),
    '-af',
    ...

Also update the header comment at lines 7-8 which documents the argv without -vn.

Handle the no-audio-source regression I measured: with '-vn' a video that has no audio stream now exits non-zero (234) instead of 0. Cheapest correct handling is in detectSilences (silence-detect.ts:99-113) — treat a "no audio stream / does not contain any stream" failure as `return []` rather than letting it reject; the caller in export-runner.ts:180 already swallows it, but making it explicit keeps the "never throws on no silences" contract in the docstring at lines 96-97 true.

Then update the exact-argv assertion in /Users/izzadev/projects/openclip/tests/unit/silence-detect.spec.ts:16-32, which currently hardcodes the 13-element array without '-vn'.

Optional adjacent check (not part of this claim): /Users/izzadev/projects/openclip/src/main/services/reframe-detect.ts:77 builds the frame-sampling argv; confirm it is symmetric (i.e. that it doesn't decode+encode the audio stream it never uses).

## Regression test

Unit (fails today, passes after the fix) — in tests/unit/silence-detect.spec.ts:

  it('does not decode the video stream — audio-only measurement', () => {
    const args = silenceDetectArgs('/src/in.mp4', 10, 20)
    expect(args).toContain('-vn')
    // must be an OUTPUT option: after the input path, before the null muxer
    expect(args.indexOf('-vn')).toBeGreaterThan(args.indexOf('/src/in.mp4'))
    expect(args.indexOf('-vn')).toBeLessThan(args.indexOf('-f'))
  })

plus updating the existing exact-argv expectation at silence-detect.spec.ts:16-32 to include '-vn'.

Optional real-binary guard, as a @serial smoke (tests/**/*.serial.spec.ts, self-skipping when ffmpeg is absent), pinning both correctness and the win: run silenceDetectArgs against a fixture with known 1.8 s silence gaps, assert the returned absolute ranges match the expected gaps, and assert the pass completes well under the source duration (e.g. < 0.5 s for a 60 s span) — that threshold fails at ~1.1 s today and passes at ~0.08 s after the fix. Add a no-audio-source case asserting detectSilences resolves to [] rather than rejecting.
