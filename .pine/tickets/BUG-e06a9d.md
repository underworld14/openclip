---
id: BUG-e06a9d
title: JOB_START projectId is unvalidated as a path segment (defense-in-depth)
status: done
priority: low
labels:
    - security
    - hardening
parent: EPIC-4sa5jb
created: "2026-08-08T15:57:27Z"
updated: "2026-08-14T11:30:18Z"
---

## Verdict

**PARTIAL** (high confidence) · severity **P3**

This finding was produced by a finder agent and then handed to an independent adversarial
verifier whose instructions were to *refute* it, defaulting to REFUTED when uncertain. It
survived. Four sibling claims in the same pass did not — see `.pine/MEMORY.md`.

## User impact

No impact on a normal user: the projectId is always a locally-generated UUID, so the escaped branch is never taken in practice, and even when forced it cannot delete pre-existing files (the rm leaf is always a fresh `export-<ts>-<n>` jobId). A compromised renderer could use it to create empty directories and write `*.captions.ass` files anywhere the app user can write (e.g. dropping a file into ~/Library/LaunchAgents-adjacent paths is blocked by the mandatory `.captions.ass` suffix). No data loss, no crash, no degraded flow.

## Evidence

WHAT IS TRUE (confirmed):

1. The validation asymmetry is exactly as claimed.
`src/main/ipc/job-start-validation.ts:23-41`:
```
const nonEmpty = z.string().min(1)
...
  export: z.looseObject({
    projectId: nonEmpty,
    clipId: nonEmpty,
```
vs `src/main/services/media-store.ts:28-33`:
```
export function assertSafeProjectId(projectId: string): string {
  if (!projectId || /[\\/]/.test(projectId) || projectId === '.' || projectId === '..') {
    throw new MediaStoreError('INVALID', `unsafe project id: ${JSON.stringify(projectId)}`)
```
`grep -rn "assertSafeProjectId" src` returns hits ONLY in media-store.ts. The JOB_START path (`src/main/index.ts:218-222` -> `validateJobStart`) never calls it. `src/main/ipc/audio.ts:35` also passes an unvalidated `projectId` into `cacheDirFor`.

2. Path construction really does escape the temp root. `src/main/utils/paths.ts:302-315` is a bare `join`, no normalization guard:
```
export function tempRootFor(projectId, baseTemp) { return join(openclipTempRoot(baseTemp), projectId) }
export function jobTempDir(projectId, jobId, baseTemp) { return join(tempRootFor(projectId, baseTemp), jobId) }
```
I ran a throwaway vitest spec calling the REAL exported functions (deleted afterward). Output:
```
TEMP ROOT      : /var/folders/3b/.../T/oc-scratch-base/openclip
"p1"                 | jobTempDir= .../oc-scratch-base/openclip/p1/export-mfoo-1   | escapes= false
"../../../../victim" | jobTempDir= /var/folders/3b/victim/export-mfoo-1             | escapes= true
"../../.."           | jobTempDir= /var/folders/3b/99qpl0gd3vqc.../export-mfoo-1    | escapes= true
".."                 | jobTempDir= .../T/oc-scratch-base/export-mfoo-1              | escapes= true
"a/../../b"          | jobTempDir= .../T/oc-scratch-base/b/export-mfoo-1            | escapes= true
"/etc"               | jobTempDir= .../oc-scratch-base/openclip/etc/export-mfoo-1   | escapes= false  (join swallows the leading /)
```

WHAT IS FALSE (the claimed consequence — a destructive recursive delete):

3. The rm target's LAST segment is always a main-process-generated jobId, never attacker-controlled. `export-runner.ts:112-118`:
```
function defaultRemoveJobTemp(projectId: string, jobId: string): void {
  try { rmSync(jobTempDir(projectId, jobId), { recursive: true, force: true }) } catch {}
```
and `sidecar-manager.ts:233-236`:
```
private nextJobId(kind: JobKind): string {
  this.seq += 1
  return `${kind}-${Date.now().toString(36)}-${this.seq}`
}
```
So a traversal projectId produces `rm -rf <escaped-dir>/export-<base36-timestamp>-<seq>`. It cannot name `Documents`, `Desktop`, a project dir, or the sibling `cache/`. With `force: true`, a non-existent leaf is a silent no-op.

4. Demonstrated on disk in a sandbox (nothing outside it touched). Same spec, second test — `victim/` sits outside the fake temp root, containing a real data dir and a decoy dir named exactly like the jobId:
```
rm target      : .../oc-scratch-sandbox/victim/export-mfoo-1
victim/Important survives   : true      <-- pre-existing user data untouched
victim/<jobId> survives     : false     <-- only a dir literally named export-mfoo-1 dies
nonexistent leaf rm threw?  : no (force:true)
```
The only way the delete removes anything is if the app itself just created that dir — which it does when captions are on: `ffmpeg-caption.ts:69` `mkdirSync(dirname(opts.assPath), { recursive: true })` with `assPath = jobTempDir(...)+'/'+TEMP_NAMES.captionsAss(clipId)` (`export-runner.ts:132-135`). Proven:
```
ass written at : .../oc-scratch-sandbox/victim/export-cap-2/clip-c1.captions.ass true
```
i.e. the real primitive is arbitrary mkdir -p + write of a `*.captions.ass` file outside the temp tree (the created parent dirs survive the rm of the leaf), NOT deletion of existing data. `clipId` is likewise unvalidated and gives a second, filename-suffix-constrained write escape:
```
traversal clipId ass path -> .../openclip/victim/pwn.captions.ass
```

REACHABILITY (honest threat model): not reachable by any normal user flow. `projectId` is `crypto.randomUUID()` generated in the renderer (`src/renderer/src/hooks/useProject.ts:81`, `hooks/import-controller.ts:140`). Reaching this requires arbitrary renderer JS execution — the renderer runs `contextIsolation: true, sandbox: true, nodeIntegration: false` with a strict CSP, and I found zero `dangerouslySetInnerHTML` in `src/renderer`, so there is no in-app injection sink for whisper/LLM text. The other theoretical source is a hand-crafted `.ocproj` (`Project.id` is bare `z.string()` at `src/shared/schema.ts:307`, and `listProjects` reads `json.id` from file content) — but `loadProject` resolves `join(dir, id + '.ocproj')`, so a traversal id fails NOT_FOUND before any job starts, and placing such a file already requires local FS write. Anyone with either capability already has more power than this bug grants.

## Fix

Defense-in-depth, cheap and worth doing since a sibling module already has the helper:
1. `src/main/ipc/job-start-validation.ts`: replace `nonEmpty` for id fields with a segment-safe schema, e.g. `const idSeg = z.string().min(1).refine((s) => !/[\\/]/.test(s) && s !== '.' && s !== '..', 'must be a single path segment')`, and use it for `transcribe.projectId`, `export.projectId` and `export.clipId`. Update the header comment's "SECURITY-SENSITIVE params" list.
2. Apply the same guard to `src/main/ipc/audio.ts:35` (`projectId` -> `cacheDirFor`), or better, hoist `assertSafeProjectId` out of `media-store.ts` into a shared util (e.g. `@main/utils/safe-id.ts`) and call it from `tempRootFor`/`jobTempDir` in `src/main/utils/paths.ts` so every consumer is covered structurally. Note `paths.ts` is FROZEN trunk infra — throwing from it is a contract change; the validation-layer fix (1)+(2) is the lower-risk option.
3. Optional: tighten `Project.id` in `src/shared/schema.ts:307` to a UUID/segment-safe regex (breaking for any existing non-UUID ids, so gate on a load-migration).

## Regression test

Add to `tests/unit/job-start-validation.spec.ts` (today only exercises `projectId: 'p1'`):

```ts
it.each(['../evil', '..', '.', 'a/b', 'a\\b'])('rejects traversal projectId %s', (pid) => {
  expect(() => validateJobStart({ kind: 'export', params: {
    projectId: pid, clipId: 'c1', sourcePath: '/a.mp4', outputPath: '/o.mp4',
    startTime: 0, endTime: 1, aspectRatio: '9:16'
  }})).toThrow(/INPUT_INVALID/)
})
it('rejects traversal clipId', () => { /* same, clipId: '../../pwn' */ })
```
Plus a path-shape assertion that survives refactors, in `tests/unit/paths.spec.ts`:
```ts
const root = openclipTempRoot('/base')
expect(resolve(jobTempDir('../../victim', 'export-1', '/base')).startsWith(resolve(root) + sep)).toBe(true)
```
Both fail today (the first throws nothing, the second resolves to `/victim/export-1`) and pass after the fix.

## Work Evidence

Closed by `pine close --evidence` on 2026-08-14.

- Base: `3ea7b027` (last commit at or before ticket created 2026-08-08)
- Commits (2):
  - `70ad7d5c` — fix(main): guard projectId as a path segment, and make settings survive corruption (BUG-e06a9d, BUG-yxvrwx)
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
 .pine/memory/renderer.md                           |  14 +
 .pine/prompts/fix.md                               |  22 +
 .pine/templates/bug.md                             |  14 +
 .pine/templates/epic.md                            |   3 +
 .pine/templates/feature.md                         |  12 +
 .pine/tickets/BUG-19bt2k.md                        | 158 +++++
 .pine/tickets/BUG-2hjt1x.md                        | 226 +++++++
 .pine/tickets/BUG-2smqpv.md                        |  31 +
 .pine/tickets/BUG-88mac4.md                        | 210 ++++++
 .pine/tickets/BUG-e06a9d.md                        | 122 ++++
 .pine/tickets/BUG-ery7v7.md                        | 233 +++++++
 .pine/tickets/BUG-g6zq2t.md                        | 104 +++
 .pine/tickets/BUG-j8pbj9.md                        | 146 +++++
 .pine/tickets/BUG-jt3d62.md                        |  70 ++
 .pine/tickets/BUG-t1xj4d.md                        | 134 ++++
 .pine/tickets/BUG-y6y5mf.md                        |  78 +++
 .pine/tickets/BUG-yq6qbw.md                        | 212 ++++++
 .pine/tickets/BUG-yxvrwx.md                        |  80 +++
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
 .pine/tickets/FEAT-5hnsby.md                       |  36 +
 .pine/tickets/FEAT-6v92dk.md                       | 183 ++++++
 .pine/tickets/FEAT-71ay4e.md                       |  36 +
 .pine/tickets/FEAT-7ffxsg.md                       | 248 +++++++
 .pine/tickets/FEAT-8559h1.md                       | 245 +++++++
 .pine/tickets/FEAT-905vk4.md                       |  36 +
 .pine/tickets/FEAT-az3sxm.md                       |  36 +
 .pine/tickets/FEAT-azqfsv.md                       |  33 +
 .pine/tickets/FEAT-bd87vz.md                       |  38 ++
 .pine/tickets/FEAT-c0zn3j.md                       | 282 ++++++++
 .pine/tickets/FEAT-c5a15c.md                       | 168 +++++
 .pine/tickets/FEAT-ckxz8d.md                       | 246 +++++++
 .pine/tickets/FEAT-d8b6bj.md                       | 252 +++++++
 .pine/tickets/FEAT-et1gxc.md                       | 168 +++++
 .pine/tickets/FEAT-g39qj3.md                       |  36 +
 .pine/tickets/FEAT-hmsg5h.md                       | 168 +++++
 .pine/tickets/FEAT-k28j7h.md                       |  37 ++
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
 docs/PACKAGING.md                                  |  71 +-
 docs/screenshots/01-welcome.png                    | Bin 0 -> 32645 bytes
 docs/screenshots/02-editor.png                     | Bin 0 -> 92473 bytes
 electron-builder.yml                               |  25 +
 package-lock.json                                  | 730 +++++++++++++++++++--
 package.json                                       |  13 +-
 scripts/bundle-binaries.mjs                        |  57 ++
 scripts/capture-screenshots.mjs                    | 130 ++++
 scripts/verify-package.mjs                         |  60 +-
 src/main/index.ts                                  |  19 +
 src/main/ipc/ai.ts                                 | 147 ++++-
 src/main/ipc/index.ts                              |   4 +-
 src/main/ipc/job-start-validation.ts               |  36 +-
 src/main/ipc/model.ts                              |  25 +-
 src/main/ipc/settings.ts                           |  98 ++-
 src/main/ipc/system.ts                             |  77 +++
 src/main/services/ai-client.ts                     | 216 ++++--
 src/main/services/ffmpeg-export.ts                 |  50 +-
 src/main/services/jobs/export-runner.ts            |  25 +-
 src/main/services/jobs/generate-clips-runner.ts    | 133 ++++
 src/main/services/model-manager.ts                 |  27 +-
 src/main/services/provider-models.ts               | 146 +++++
 src/main/services/reframe-detect.ts                |  22 +-
 src/main/services/sidecar-manager.ts               |   5 +
 src/main/services/silence-detect.ts                |   4 +
 src/main/utils/paths.ts                            |  29 +-
 src/preload/api/files.ts                           |  35 +
 src/preload/index.ts                               |   7 +-
 src/renderer/src/App.tsx                           | 112 +++-
 src/renderer/src/assets/index.css                  |  29 +
 src/renderer/src/components/ClipSidebar.tsx        |  51 +-
 src/renderer/src/components/ExportPanel.tsx        | 120 +++-
 src/renderer/src/components/ImportPanel.tsx        |  74 ++-
 src/renderer/src/components/JobStatusBar.tsx       | 256 ++++++++
 .../src/components/ModelDownloadDialog.tsx         | 100 ++-
 src/renderer/src/components/ReadinessBar.tsx       |  75 +++
 src/renderer/src/components/SettingsPanel.tsx      | 527 +++++++++------
 .../src/components/TranscriptionSettings.tsx       | 176 +++++
 src/renderer/src/components/export-run.ts          |  14 +-
 src/renderer/src/components/formatBytes.ts         |  15 +
 src/renderer/src/components/generate-clips-run.ts  |  54 ++
 src/renderer/src/components/generateClips.ts       |  12 +-
 src/renderer/src/components/import-pipeline.ts     |  42 +-
 src/renderer/src/components/jobStatus.ts           | 322 +++++++++
 src/renderer/src/components/model-download.ts      |   7 +
 src/renderer/src/components/readinessView.ts       | 132 ++++
 src/renderer/src/components/settingsView.ts        |  68 +-
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
 src/renderer/src/stores/projectStore/clipsSlice.ts |  88 ++-
 .../src/stores/projectStore/exportSlice.ts         |   4 +-
 src/renderer/src/stores/uiStore.ts                 |  37 +-
 src/shared/channels.ts                             | 113 +++-
 src/shared/jobs.ts                                 |  83 ++-
 tests/e2e/export.e2e.spec.ts                       |  17 +-
 tests/e2e/generate-clips-button.e2e.spec.ts        |  41 ++
 tests/e2e/integration-wave1.e2e.spec.ts            |  31 +-
 tests/e2e/job-status-bar.e2e.spec.ts               | 127 ++++
 tests/e2e/model-gate.e2e.spec.ts                   |  53 ++
 tests/e2e/ping.e2e.spec.ts                         |  72 +-
 tests/e2e/timeline.e2e.spec.ts                     |  14 +-
 tests/e2e/vertical-slice.e2e.spec.ts               |  75 ++-
 tests/fixtures/contract/index.ts                   |  19 +-
 tests/harness/fixtures.ts                          |  47 ++
 tests/harness/renderer-env.ts                      |  59 ++
 tests/mocks/openclip.ts                            |  47 +-
 tests/unit/ai-components.spec.ts                   |  57 +-
 tests/unit/ai-ipc.spec.ts                          | 146 ++++-
 tests/unit/ai-mapreduce.spec.ts                    | 112 ++++
 tests/unit/ai-stores.spec.ts                       | 162 +++--
 tests/unit/ass-captions.serial.spec.ts             |  21 +-
 tests/unit/autosave-subscriber.spec.ts             |  73 +++
 tests/unit/contract.spec.ts                        |  24 +
 tests/unit/dialog-scroll.spec.tsx                  | 101 +++
 tests/unit/export-runner.spec.ts                   |  67 +-
 tests/unit/ffmpeg-export.serial.spec.ts            |  63 +-
 tests/unit/ffmpeg-export.spec.ts                   |  56 +-
 tests/unit/ffmpeg-version.serial.spec.ts           |  35 +-
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
 tests/unit/preload-parity.spec.ts                  |  18 +-
 tests/unit/project-id-path-safety.spec.ts          | 104 +++
 tests/unit/provider-models.spec.ts                 | 118 ++++
 tests/unit/readiness-view.spec.ts                  | 117 ++++
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
 202 files changed, 16897 insertions(+), 831 deletions(-)
```
