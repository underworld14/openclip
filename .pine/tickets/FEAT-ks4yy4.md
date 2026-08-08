---
id: FEAT-ks4yy4
title: Add GitHub Actions CI — zero CI today, and it has already let E2E rot through
status: done
priority: critical
labels:
    - infra
    - ci
parent: EPIC-9gkehb
created: "2026-08-08T15:31:59Z"
updated: "2026-08-08T16:35:08Z"
---

## Problem

There is no `.github/` directory at all — no CI workflow, no issue templates, no PR template.

```
$ ls -la /Users/izzadev/projects/openclip/.github
ls: .github: No such file or directory
```

Every quality gate is opt-in and local. PRD §4.5 lists GitHub Actions as the CI/CD tool and Appendix B shows `.github/workflows/build.yml` as the first entry of the project structure.

## Why it matters (proven, not theoretical)

The absence of CI has already let real rot through, discovered in this sweep:

1. **The whole Playwright E2E suite was unrunnable** on a clean checkout — `node_modules/electron/dist` contained only `LICENSES.chromium.html`, so all 8 specs died with *"Electron failed to install correctly"*. Nobody noticed.
2. Once Electron was repaired, **2 of 8 E2E specs fail** (see [[BUG-e2e-ping-stale]] and [[BUG-generate-clips-noop]]) — including the regression guard for the P0 "dead Auto Generate Clips button".
3. `npm test` reports green on a machine without ffmpeg because ~10 real-binary `@serial` specs self-skip — the entire ffmpeg/libass/reframe/whisper regression layer silently disappears.

## Acceptance criteria

- [ ] `.github/workflows/ci.yml` runs on push + PR: `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`.
- [ ] A `macos-14` (arm64) job additionally installs ffmpeg and runs `npm run build` + `npm run test:e2e`.
- [ ] The smoke layer is enforced in CI via `OPENCLIP_REQUIRE_SMOKES=1 vitest run` (the `test:smoke` script already exists) so a self-skipped smoke fails the build rather than passing silently.
- [ ] E2E runs against a real Electron install; the job fails loudly if `node_modules/electron/dist/Electron.app` is missing rather than reporting a skip.
- [ ] Issue templates (bug / feature) and a PR template exist.

## Notes

`npm run test:e2e | tail` masks the exit code — make sure the CI step does not pipe the test command, or the failure will be swallowed exactly as it was here.

## Work Evidence

Closed by `pine close --evidence` on 2026-08-08.

- Base: `3ea7b027` (last commit at or before ticket created 2026-08-08)
- Commits (2):
  - `b88052a1` — ci: add GitHub Actions, issue templates, and a PR template (FEAT-ks4yy4)
  - `3c7d68c2` — chore(pine): adopt pine issue tracking + file the multi-agent audit backlog
- Files changed (base → working tree):

```
 .agents/skills/pine/SKILL.md                  | 145 ++++++++++++++++
 .claude/settings.json                         |  15 +-
 .claude/skills/pine/SKILL.md                  | 145 ++++++++++++++++
 .codex/hooks.json                             |  14 ++
 .codex/hooks/pine-learn-reminder.sh           |   6 +
 .cursor/hooks.json                            |  10 ++
 .cursor/hooks/pine-learn-reminder.sh          |   6 +
 .github/ISSUE_TEMPLATE/bug_report.md          |  30 ++++
 .github/ISSUE_TEMPLATE/feature_request.md     |  15 ++
 .github/pull_request_template.md              |  24 +++
 .github/workflows/ci.yml                      |  82 +++++++++
 .pine/.gitignore                              |   4 +
 .pine/MEMORY.md                               |  13 ++
 .pine/board.json                              |   1 +
 .pine/config.json                             |   1 +
 .pine/memory/competitor-precedent.md          |  10 ++
 .pine/memory/perf-refuted.md                  |  11 ++
 .pine/prompts/fix.md                          |  22 +++
 .pine/templates/bug.md                        |  14 ++
 .pine/templates/epic.md                       |   3 +
 .pine/templates/feature.md                    |  12 ++
 .pine/tickets/BUG-19bt2k.md                   | 158 +++++++++++++++++
 .pine/tickets/BUG-2hjt1x.md                   | 226 +++++++++++++++++++++++++
 .pine/tickets/BUG-2smqpv.md                   |  31 ++++
 .pine/tickets/BUG-88mac4.md                   | 210 +++++++++++++++++++++++
 .pine/tickets/BUG-e06a9d.md                   | 122 ++++++++++++++
 .pine/tickets/BUG-ery7v7.md                   | 233 ++++++++++++++++++++++++++
 .pine/tickets/BUG-g6zq2t.md                   | 104 ++++++++++++
 .pine/tickets/BUG-j8pbj9.md                   | 146 ++++++++++++++++
 .pine/tickets/BUG-t1xj4d.md                   | 134 +++++++++++++++
 .pine/tickets/BUG-y6y5mf.md                   |  78 +++++++++
 .pine/tickets/BUG-yq6qbw.md                   | 187 +++++++++++++++++++++
 .pine/tickets/BUG-yxvrwx.md                   |  80 +++++++++
 .pine/tickets/EPIC-4sa5jb.md                  |  14 ++
 .pine/tickets/EPIC-9gkehb.md                  |  15 ++
 .pine/tickets/EPIC-c2gg45.md                  |  14 ++
 .pine/tickets/EPIC-f953vk.md                  |  15 ++
 .pine/tickets/EPIC-n6ndb8.md                  |  15 ++
 .pine/tickets/EPIC-xzzpty.md                  |  15 ++
 .pine/tickets/EPIC-zpa1nd.md                  |  15 ++
 .pine/tickets/FEAT-0s2tnc.md                  |  36 ++++
 .pine/tickets/FEAT-1k76hk.md                  |  36 ++++
 .pine/tickets/FEAT-51hnwx.md                  |  36 ++++
 .pine/tickets/FEAT-56bxyh.md                  |  35 ++++
 .pine/tickets/FEAT-5hnsby.md                  |  36 ++++
 .pine/tickets/FEAT-6v92dk.md                  |  50 ++++++
 .pine/tickets/FEAT-71ay4e.md                  |  36 ++++
 .pine/tickets/FEAT-7ffxsg.md                  |  36 ++++
 .pine/tickets/FEAT-8559h1.md                  |  36 ++++
 .pine/tickets/FEAT-905vk4.md                  |  36 ++++
 .pine/tickets/FEAT-az3sxm.md                  |  36 ++++
 .pine/tickets/FEAT-bd87vz.md                  |  38 +++++
 .pine/tickets/FEAT-c0zn3j.md                  |  37 ++++
 .pine/tickets/FEAT-c5a15c.md                  |  36 ++++
 .pine/tickets/FEAT-ckxz8d.md                  |  36 ++++
 .pine/tickets/FEAT-d8b6bj.md                  |  44 +++++
 .pine/tickets/FEAT-et1gxc.md                  |  36 ++++
 .pine/tickets/FEAT-g39qj3.md                  |  36 ++++
 .pine/tickets/FEAT-hmsg5h.md                  |  36 ++++
 .pine/tickets/FEAT-k28j7h.md                  |  37 ++++
 .pine/tickets/FEAT-kncqxf.md                  |  46 +++++
 .pine/tickets/FEAT-ks4yy4.md                  |  43 +++++
 .pine/tickets/FEAT-ky1jfw.md                  |  49 ++++++
 .pine/tickets/FEAT-kzej8t.md                  |  36 ++++
 .pine/tickets/FEAT-n762y6.md                  |  47 ++++++
 .pine/tickets/FEAT-rmh08k.md                  |  34 ++++
 .pine/tickets/FEAT-vvaycm.md                  |  37 ++++
 .pine/tickets/FEAT-vwvgs0.md                  |  36 ++++
 .pine/tickets/FEAT-ybhdhz.md                  |  36 ++++
 AGENTS.md                                     |  26 +++
 CLAUDE.md                                     |  26 +++
 src/main/services/ffmpeg-export.ts            |  50 +++++-
 src/main/services/silence-detect.ts           |   4 +
 src/renderer/src/App.tsx                      |   6 +-
 src/renderer/src/components/generateClips.ts  |  12 +-
 src/renderer/src/hooks/import-controller.ts   |  16 +-
 src/renderer/src/hooks/useImportController.ts |  13 +-
 src/renderer/src/hooks/useProject.ts          |   5 +
 tests/e2e/generate-clips-button.e2e.spec.ts   |  30 ++++
 tests/e2e/ping.e2e.spec.ts                    |  64 ++++---
 tests/unit/ffmpeg-export.serial.spec.ts       |  44 ++++-
 tests/unit/ffmpeg-export.spec.ts              |  56 ++++++-
 tests/unit/generate-clips-view.spec.ts        |  23 +++
 tests/unit/import-controller.spec.ts          |  25 ++-
 tests/unit/silence-detect.spec.ts             |  11 ++
 tests/unit/use-project.spec.ts                |  12 ++
 86 files changed, 3881 insertions(+), 46 deletions(-)
```
