---
id: FEAT-rmh08k
title: Reframe plan is never cached — every re-export re-runs the full face + motion analysis
status: todo
priority: medium
labels:
    - perf
    - reframe
parent: EPIC-c2gg45
created: "2026-08-08T15:59:08Z"
updated: "2026-08-08T15:59:08Z"
---

## Current behavior

`docs/auto-reframe-design.md:50` explicitly calls for it: *"cache the plan per clip id + bounds"*. There is no cache. `grep -n cache src/main/services/reframe-detect.ts src/main/services/jobs/export-runner.ts` finds nothing.

Every export of the same clip at the same bounds re-runs the **entire** face-sampling pipeline: an ffmpeg decode pass sampling frames at 2 fps, YuNet ONNX inference on every sampled frame, and then a second `tblend` motion pass. Re-export after tweaking a caption colour pays the whole cost again.

Related waste in the same path:

- `planReframe` computes `filterFaceOutliers(samples)` for its early-exit clustering and then passes the **raw** `samples` into `buildReframePlan`, which filters again internally (`reframe-detect.ts:867`) — the clusters used to derive motion ROIs and the clusters used to build the plan are computed from different inputs.
- The `motionRois` branch inside `detectReframe` (Pass 2, `reframe-detect.ts:421-426`) is dead in production — `planReframe` only calls it for faces and then runs the standalone `detectMotion`, leaving two divergent copies of the motion logic. The file's own comment says the branch is "exercised ONLY by the unit spec".
- The reframe/motion ffmpeg children are spawned outside `ffmpeg-core.runFfmpeg` (`reframe-detect.ts:546`) and are never PID-tracked with the sidecar, so app-quit teardown has no OS-level backstop for them, unlike every other ffmpeg child.

## Desired behavior

Cache the computed `ReframePlan` keyed by `(clipId, resolvedStart, resolvedEnd, sourceMtime, sampleFps)`, persisted alongside the project so it survives a restart. Invalidate on trim.

## Sizing

Worth doing right after [[BUG-ery7v7]] (the `-t` decode-to-EOF fix), because both target the same complaint: exporting is slower than it needs to be. Measured context from that ticket — an export with reframe + silence enabled decodes the same span up to four times (silencedetect, 2 fps face sample, motion pass, final encode) with no shared decode.

SupoClip's approach is the structural alternative worth considering: **one** sequential ffmpeg decode at 3 fps / 480px wide, piped as rawvideo into the detector, deliberately replacing per-frame seeking.
