---
id: BUG-jt3d62
title: Settings 'force CPU' (PRD §14) is not wired to exports — no CPU fallback path, and it costs export E2E coverage on CI
status: done
priority: medium
created: "2026-08-09T04:28:47Z"
updated: "2026-08-14T11:53:18Z"
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

## Work Evidence

Closed by `pine close --evidence` on 2026-08-14.

- Base: `8533c6bc` (last commit at or before ticket created 2026-08-09)
- Commits (2):
  - `100abace` — feat(export): wire 'force CPU' end to end, probe the encoder, fall back automatically (BUG-jt3d62, FEAT-5hnsby)
  - `14e19185` — fix(ci): the E2E exports need a usable GPU encoder too (BUG-zcqyb7)
- Files changed (base → working tree):

```
 .github/workflows/ci.yml                           |  25 +-
 .pine/memory/ci.md                                 |  13 +-
 .pine/memory/renderer.md                           |   5 +-
 .pine/tickets/BUG-2smqpv.md                        | 223 ++++++-
 .pine/tickets/BUG-e06a9d.md                        | 220 ++++++-
 .pine/tickets/BUG-jt3d62.md                        |  70 ++
 .pine/tickets/BUG-y6y5mf.md                        | 226 ++++++-
 .pine/tickets/BUG-yxvrwx.md                        | 220 ++++++-
 .pine/tickets/BUG-zcqyb7.md                        | 117 +++-
 .pine/tickets/FEAT-26tkya.md                       | 101 ++-
 .pine/tickets/FEAT-7ffxsg.md                       | 216 +++++-
 .pine/tickets/FEAT-d8b6bj.md                       | 212 +++++-
 CODE_OF_CONDUCT.md                                 | 131 ++++
 CONTRIBUTING.md                                    | 191 ++++++
 LICENSE                                            |  31 +
 README.md                                          | 163 +++++
 THIRD-PARTY-LICENSES.md                            |  49 ++
 build/licenses/ffmpeg/COPYING.GPLv3                | 674 +++++++++++++++++++
 build/licenses/ffmpeg/README.md                    |  69 ++
 docs/PACKAGING.md                                  |  71 +-
 docs/screenshots/01-welcome.png                    | Bin 0 -> 32645 bytes
 docs/screenshots/02-editor.png                     | Bin 0 -> 92473 bytes
 electron-builder.yml                               |  25 +
 package-lock.json                                  | 730 +++++++++++++++++++--
 package.json                                       |  13 +-
 scripts/bundle-binaries.mjs                        |  57 ++
 scripts/capture-screenshots.mjs                    | 130 ++++
 scripts/verify-package.mjs                         |  60 +-
 src/main/index.ts                                  |  10 +
 src/main/ipc/job-start-validation.ts               |  28 +-
 src/main/ipc/settings.ts                           |  98 ++-
 src/main/ipc/system.ts                             |   6 +-
 src/main/services/ass-captions.ts                  |  50 +-
 src/main/services/encoder-probe.ts                 |  64 ++
 src/main/services/ffmpeg-caption.ts                |   8 +-
 src/main/services/ffmpeg-export.ts                 |  25 +
 src/main/services/jobs/export-runner.ts            |  92 ++-
 src/main/services/openrouter-models.ts             |  37 +-
 src/main/utils/paths.ts                            |  29 +-
 src/renderer/src/assets/index.css                  |  29 +
 src/renderer/src/components/ExportPanel.tsx        |  10 +-
 src/renderer/src/components/SettingsPanel.tsx      | 535 ++++++++-------
 src/renderer/src/components/batch-export.ts        |   7 +
 src/renderer/src/components/settingsView.ts        |  27 +
 src/renderer/src/components/ui/dialog.tsx          |  25 +-
 src/renderer/src/hooks/jobPort.ts                  |  25 +-
 src/renderer/src/hooks/useImportController.ts      |  10 +
 .../src/stores/projectStore/exportSlice.ts         |   7 +
 src/shared/channels.ts                             |  12 +
 src/shared/jobs.ts                                 |  15 +
 tests/e2e/export.e2e.spec.ts                       |  27 +-
 tests/e2e/timeline.e2e.spec.ts                     |  27 +-
 tests/e2e/vertical-slice.e2e.spec.ts               |  75 ++-
 tests/fixtures/contract/index.ts                   |  19 +-
 tests/harness/renderer-env.ts                      |  59 ++
 tests/mocks/openclip.ts                            |  27 +-
 tests/unit/ai-ipc.spec.ts                          |  14 +-
 tests/unit/ass-playres.serial.spec.ts              | 116 ++++
 tests/unit/ass-playres.spec.ts                     | 127 ++++
 tests/unit/dialog-scroll.spec.tsx                  | 101 +++
 tests/unit/force-cpu.spec.ts                       | 160 +++++
 tests/unit/import-panel-drop.spec.tsx              | 136 ++++
 tests/unit/job-port-window-delivery.spec.tsx       |  81 +++
 tests/unit/openrouter-curated.serial.spec.ts       | 111 ++++
 tests/unit/project-id-path-safety.spec.ts          | 104 +++
 tests/unit/settings-ipc.spec.ts                    | 134 ++++
 tests/unit/settings-panel-model-draft.spec.tsx     | 141 ++++
 tests/unit/settings-tabs.spec.tsx                  |  74 +++
 tests/unit/use-import-controller.spec.tsx          | 145 ++++
 tests/unit/use-readiness.spec.tsx                  | 117 ++++
 tsconfig.test.json                                 |   1 +
 vitest.config.ts                                   |  12 +-
 72 files changed, 6575 insertions(+), 424 deletions(-)
```
