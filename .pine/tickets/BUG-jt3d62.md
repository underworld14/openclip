---
id: BUG-jt3d62
title: Settings 'force CPU' (PRD §14) is not wired to exports — no CPU fallback path, and it costs export E2E coverage on CI
status: todo
priority: medium
created: "2026-08-09T04:28:47Z"
updated: "2026-08-09T04:28:47Z"
---

# Description

`forceCpu` exists as a real user-facing Setting — `schema.ts:343` (`// GPU fallback
override (PRD §14)`), defaulted in `settings.ts:29` and `settingsStore.ts:27` — and
`codecArgs()` honours it (`ffmpeg-export.ts:214`). But **nothing connects the two**:

- `JobParams['export']` (`src/shared/jobs.ts:133`) has no `forceCpu` field.
- `export-runner.ts:254` calls `exportClip({…})` without it.
- No renderer/main code reads `settings.forceCpu` on the export path.

So every export encodes with `h264_videotoolbox`, whatever the user picked. The toggle
is inert, and the PRD §14 GPU-fallback path exists only in unit tests that call
`exportClipArgs({forceCpu: true})` directly.

Found while making CI green (BUG-zcqyb7). Two consequences:

1. **A user whose Mac cannot use VideoToolbox has no way out.** The encoder fails and the
   export dies with SIDECAR_CRASH; flipping the documented setting changes nothing.
2. **Export E2E cannot run on CI.** GitHub's macos-14 runners are VMs with no hardware
   encode session (`cannot create compression session: -12903`, run 31294445970), so the
   two E2E specs that export for real now skip there. With `forceCpu` threaded through,
   they could instead run on libx264 and keep full end-to-end export coverage on CI —
   same job plane, same MessagePort progress, same ffprobe assertions, only the encoder
   differs.

Note `src/shared/jobs.ts` is one of the four **FROZEN** contract seams, so this is a
deliberate contract change: add the field, thread it in the runner, wire the Setting, and
update the drift/contract tests together. That is why it was NOT folded into the CI fix.

# Steps to Reproduce

1. Settings → enable "force CPU".
2. Export any clip.
3. `ps`/the ffmpeg argv still shows `-c:v h264_videotoolbox`; libx264 is never selected.

# Expected

The Setting selects the CPU encoder end to end, giving a working fallback on machines
without a usable VideoToolbox session.

# Actual

The Setting is stored and displayed but never reaches `exportClip`.

# Acceptance Criteria
- [ ] `forceCpu` added to `JobParams['export']` (frozen-contract change + drift tests)
- [ ] `export-runner.ts` threads it into `exportClip`
- [ ] The Settings toggle reaches the job params from the renderer
- [ ] A unit test proves the argv flips to libx264 when the setting is on
- [ ] `export.e2e.spec.ts` / `timeline.e2e.spec.ts` drive `forceCpu` so real export E2E
      runs on CI again instead of skipping (drop the videotoolbox skip guards there)

# Related Files

- `src/shared/jobs.ts:133` — `JobParams['export']` (FROZEN)
- `src/main/services/jobs/export-runner.ts:254` — the `exportClip` call
- `src/main/services/ffmpeg-export.ts:214` — `codecArgs()`
- `src/shared/schema.ts:343`, `src/main/ipc/settings.ts:29`, `settingsStore.ts:27`
- `tests/e2e/export.e2e.spec.ts`, `tests/e2e/timeline.e2e.spec.ts`

# Attachments
