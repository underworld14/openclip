---
id: FEAT-ks4yy4
title: Add GitHub Actions CI — zero CI today, and it has already let E2E rot through
status: todo
priority: critical
labels:
    - infra
    - ci
parent: EPIC-9gkehb
created: "2026-08-08T15:31:59Z"
updated: "2026-08-08T15:31:59Z"
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
