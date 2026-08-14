---
id: BUG-yxvrwx
title: Settings are written without Zod validation and a malformed file silently resets every setting
status: done
priority: low
labels:
    - bug
    - settings
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

Today: none from a normal user's UI actions — every reachable patch value is enum- or string-constrained at its source, so the file on disk stays schema-valid and settings never reset. The reachable-in-practice residue is the corruption path: `writeFileSync` is non-atomic (no tmp+rename), so a crash, power loss, or full disk during the write leaves truncated JSON, and the very next launch silently comes back with provider=openai, model='' and language cleared — no toast, no log, no "couldn't read your settings" message. The user's next AI generate then quietly runs against the wrong provider/model (it will fail with a missing-key/model error that points nowhere near the real cause). A future required field added to the Settings schema would trigger the same total reset for every existing user on upgrade (the team already hardened the *unknown-key* direction in commit 94a2522 "looseObject persistence schemas so newer-version keys survive"; the missing-required-key direction is still unguarded).

## Evidence

MECHANISM: CONFIRMED, exactly as described.

/Users/izzadev/projects/openclip/src/main/ipc/settings.ts:40-53
```
function readSettings(path: string): SettingsType {
  if (!existsSync(path)) return DEFAULT_SETTINGS
  try {
    const parsed = Settings.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    return parsed.success ? parsed.data : DEFAULT_SETTINGS   // <- full-object fallback, no log, no error
  } catch {
    return DEFAULT_SETTINGS
  }
}
function writeSettings(path: string, settings: SettingsType): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(settings, null, 2), 'utf8')  // <- no safeParse, non-atomic
}
```
settings.ts:60-68
```
    async (_e, req: { settings: Partial<SettingsType> }) => {
      const path = settingsPath()
      const merged: SettingsType = { ...readSettings(path), ...req.settings }   // TS-only "type", trusted from renderer
      writeSettings(path, merged)
```

PROOF (ran the REAL handlers; temp spec at tests/unit/zzz-scratch-settings-reset.spec.ts, since deleted; electron's CJS `require('electron')` stubbed via Module._load so app.getPath -> a temp dir):
1. renderer-shaped writes -> `{"aiProvider":"anthropic","model":"claude-sonnet-4-5","language":"id",...}` on disk.
2. one out-of-contract patch `{ maxClips: NaN }` -> handler returns it happily and disk gets `"maxClips": null` (JSON.stringify(NaN)==="null").
3. next GET_SETTINGS -> `{"aiProvider":"openai","model":"","whisperModel":"base","aspectRatio":"9:16","maxClips":5,...}` — provider, model and language all gone. Total silent reset. Confirmed.
4. Also confirmed the same total reset from a truncated file (simulating crash/power-loss mid `writeFileSync`, which is not atomic — no tmp+rename): `TRUNCATED READ: {"aiProvider":"openai","model":"", ...}`.

REACHABILITY: REFUTED for the "normal user" framing. No renderer path can produce a schema-invalid value today. `SET_SETTINGS` is only ever called from settingsStore.save() (/Users/izzadev/projects/openclip/src/renderer/src/stores/settingsStore.ts:102), and the complete set of call sites is SettingsPanel.tsx lines 154, 172, 229, 265, 273, 346, 383, 400 — i.e. only five fields are writable at all:
- `aiProvider` / `emojiProvider`: values come from `PROVIDERS` in src/renderer/src/components/settingsView.ts:31 = `['openai','anthropic','google','ollama','openrouter']`, byte-identical to `AIProvider` in schema.ts:324.
- `model` / `emojiModel`: `z.string()` (any string passes; `emojiModel` is `|| undefined`).
- `language`: `e.target.value.trim() || undefined`, `z.string().optional()`.
There is NO UI for maxClips / minDuration / maxDuration / whisperModel / forceCpu / telemetryOptIn / aspectRatio / baseUrl (grep over src/renderer shows those names only in per-project `ProjectSettings` and export presets, never in a `save({...})`). So the "NaN from a number input" style trigger does not exist. Additionally `Settings` is `z.looseObject` (schema.ts:327), so unknown/extra keys cannot break the parse either.

BLAST RADIUS is also smaller than claimed: API keys are NOT in this file — KeyVault persists to `userData/secrets.json` (src/main/utils/security.ts:131), so a reset loses aiProvider/model/emojiProvider/emojiModel/language only, not key material.

## Fix

src/main/ipc/settings.ts, three small changes:
1. Validate on write: in the SET_SETTINGS handler, `const parsed = Settings.safeParse({ ...readSettings(path), ...req.settings })`; on failure throw a typed IPC error (or drop the offending keys) instead of persisting — never write an unvalidated object.
2. Repair instead of nuke on read: on `safeParse` failure, merge field-by-field — keep every key that individually validates against `Settings.shape[k]`, fall back to the default only for the keys that fail. Log the discarded keys via the app logger so it is not silent.
3. Make the write atomic: `writeFileSync(path + '.tmp', json)` then `renameSync(tmp, path)`, so a crash mid-write cannot truncate the live file.

## Regression test

New tests/unit/settings-ipc.spec.ts (stub `require('electron')`'s `app.getPath` to a tmpdir via Module._load, register the real `registerSettingsHandlers`):
- "a schema-invalid patch does not clobber good settings": set `{aiProvider:'anthropic', model:'claude-sonnet-4-5', language:'id'}`, then call SET_SETTINGS with `{maxClips: Number.NaN}`; expect the call to reject AND a subsequent GET_SETTINGS to still return aiProvider 'anthropic' / model 'claude-sonnet-4-5' / language 'id'. Fails today (GET returns the full DEFAULT_SETTINGS — verified).
- "a corrupt settings.json preserves the keys that still parse": write a good file, truncate it to 60 bytes (or hand-set `maxClips: null`), expect GET_SETTINGS to keep aiProvider/model where recoverable and to log a warning rather than returning defaults silently. Fails today.

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
 .pine/tickets/BUG-e06a9d.md                        | 338 ++++++++++
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
 202 files changed, 17113 insertions(+), 831 deletions(-)
```
