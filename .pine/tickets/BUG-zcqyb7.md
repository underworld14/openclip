---
id: BUG-zcqyb7
title: 'CI red on main: Linux gates job runs macOS-only GPU smokes; macOS npm ci hits GitHub rate limit'
status: done
priority: high
created: "2026-08-09T04:07:07Z"
updated: "2026-08-14T11:16:01Z"
---

# Description

The first CI run after `b88052a` (`ci: add GitHub Actions…`) was red in **both** jobs —
run 31293580008. Two independent causes.

**(A) The `gates` job (ubuntu-latest) ran real-binary `@serial` smokes that are written
against a macOS ffmpeg.** `ci.yml` calls that job "the pure gates, no binaries", but
`npm test` runs the whole vitest suite and the smokes only guard on `ffmpegAvailable()`.
`ffmpeg-static` is a **devDependency**, so `npm ci` puts a working ffmpeg on every runner
— the guard passes on Linux, the smokes run, and the two specs that export through the
DEFAULT encoder die: `codecArgs()` picks `h264_videotoolbox` unless `forceCpu`, and
VideoToolbox is a macOS framework that a Linux build simply does not carry.

    [vost#0:0] Unknown encoder 'h264_videotoolbox' → ffmpeg exited with code 8

Exactly the specs that omit `forceCpu` failed; `brand-overlay` / `emoji-caption` pass
`forceCpu: true` and passed. The guard was checking *the binary exists*, not *the
capability the spec exercises*.

Third failure, same job, different cause: `ffmpeg-version.serial.spec.ts` asserts MAJOR
parity between two dev-only npm packages that are **not built in lockstep across
platforms** — for this very lockfile `ffmpeg-static@5.3.0` is ffmpeg 6.0 on darwin-arm64
but **7.0 on linux-x64**, while `ffmpeg-ffprobe-static@6.1.1` is 6.1 everywhere. On Linux
that is a drift no version bump in this repo can close.

**(B) The `macos` job never got past `npm ci`.** `youtube-dl-exec`'s postinstall fetches
the yt-dlp release off the GitHub API. Unauthenticated it shares a 60/hr budget with every
other runner on the same egress IP:

    npm error command sh -c node scripts/postinstall.js
    Error: { "message": "API rate limit exceeded for 13.105.117.134. …" }

**Correction — passing `GITHUB_TOKEN` does NOT fix this, and the first attempt at it was
inert.** `getBinary()` in that postinstall does `fetch(url, headers)`, passing the header
object as fetch's *init* argument, so the `Authorization` header is silently dropped; the
package reads `GITHUB_TOKEN` and then throws it away. Two runs happened to pass `npm ci`
afterwards, which looked like the fix working — it was luck on a shared-IP budget, and the
failure returned in run 31294745592 with the same *unauthenticated* wording ("rate limit
exceeded for &lt;ip&gt;", not "for user ID"). The real fix is `YOUTUBE_DL_SKIP_DOWNLOAD=1`:
nothing in CI consumes that binary — `ytDlpPath()` returns youtube-dl-exec's computed PATH
CONSTANT without ever stat-ing the file, and the only spec that runs real yt-dlp is gated
behind `RUN_NETWORK_E2E` *and* a package-time-staged `resources/yt-dlp/…`. Verified by
deleting the managed binary locally: full suite still 932 passed.

# Steps to Reproduce

Locally, on a Mac, emulate a Linux ffmpeg (real binary, VideoToolbox stripped) and run the
suite — this reproduced the CI failure exactly, 2 specs, same `exit 8`:

    OPENCLIP_FFMPEG=<shim> npx vitest run tests/unit/ffmpeg-export.serial.spec.ts \
                                          tests/unit/ass-captions.serial.spec.ts

# Expected

Both CI jobs green. Smokes run wherever they *can* run and skip honestly where they
cannot — without ever silently disappearing on macOS, where they must run.

# Actual

3 test failures on ubuntu + `npm ci` failure on macOS. See run 31293580008.

# Acceptance Criteria
- [x] `videotoolboxAvailable()` capability probe added to the fixtures harness
- [x] The two GPU-path cases guard on the capability, not on mere ffmpeg presence
- [x] `forceCpu` / libx264 cases stay portable and still run on Linux
- [x] Version-parity smoke scoped to darwin, with the per-platform drift documented
- [x] `smoke-strict` (OPENCLIP_REQUIRE_SMOKES) fails loudly if macOS loses the GPU encoder,
      so the new guard cannot silently disable the layer where it counts
- [x] `GITHUB_TOKEN` passed to both `npm ci` steps
- [x] CI green on main

# Related Files

- `tests/harness/fixtures.ts` — new `videotoolboxAvailable()`
- `tests/unit/ffmpeg-export.serial.spec.ts`, `tests/unit/ass-captions.serial.spec.ts`
- `tests/unit/ffmpeg-version.serial.spec.ts`, `tests/unit/smoke-strict.spec.ts`
- `.github/workflows/ci.yml`

# Attachments

Local verification before push (all on darwin-arm64):

| what | result |
|---|---|
| `npm run typecheck` / `npm run lint` | pass |
| `npm test` | 932 passed, 2 skipped |
| full suite via VideoToolbox-less ffmpeg (**emulated Linux gates job**) | 930 passed, 4 skipped, **0 failed** |
| `npm run test:smoke` (**what the macos job runs**) | 934 passed, 0 skipped |
| `npm run build` | pass |
| `npm run test:e2e` | 12 passed, 1 skipped (network-gated) |

## Round 2 — macos runner, `-12903`

Fixing the above got the macos job past `npm ci` and into steps that had NEVER run, which
surfaced a second, unrelated environmental limit: GitHub's macos-14 runners are **VMs with
no hardware video-encode session**. `h264_videotoolbox` is LISTED by `ffmpeg -encoders`
there and then fails to open — `cannot create compression session: -12903`. So the
grep-the-encoder-list guard answered "available" and the GPU smokes ran and died anyway.

Listing a codec ≠ being able to use it. `videotoolboxAvailable()` now runs a **one-frame
encode** and reports whether it actually succeeded — one definition of "can this machine
encode", shared by the @serial smokes AND the E2E specs (two definitions is exactly what
let this through twice). The strict guard is scoped to non-CI darwin: no change here can
give a VM a HW encoder, so requiring one on CI would pin the job red forever, while on a
dev/release Mac it stays loud.

Round 3: the same `-12903` then surfaced in Playwright — `export.e2e.spec.ts` and
`timeline.e2e.spec.ts:67` drive a REAL export through the app. Same guard applied. The
honest CPU-fallback fix (thread `forceCpu`, keep export E2E on CI) is filed as
**BUG-jt3d62** — it changes the FROZEN `jobs.ts` contract, so it is deliberately not
folded in here.

**Known coverage cost:** the HW-encode path is not exercised on CI. The libx264/`forceCpu`
specs still cover export, caption-burn, split and jump-cut there, and the GPU path runs on
any real Mac — but CI alone will not catch a VideoToolbox-specific regression until
BUG-jt3d62 lands.

Each environment was verified by wrapping the real ffmpeg to reproduce its exact failure:

| emulated environment | result |
|---|---|
| macos-VM (`CI=true`, encoder listed, `-12903` on use) + `test:smoke` | 931 passed, 3 skipped, 0 failed |
| macos-VM + `test:e2e` | 10 passed, 3 skipped, 0 failed (the 2 export specs skip) |
| linux gates (`Unknown encoder`) + `npm test` | 930 passed, 4 skipped, 0 failed |
| dev Mac, strict | 934 passed, **0 skipped** — GPU specs + strict assertion both run |
| dev Mac, `test:e2e` | 12 passed, 1 skipped — both export specs run |

## Work Evidence

Closed by `pine close --evidence` on 2026-08-14.

- Base: `16eefe29` (last commit at or before ticket created 2026-08-09)
- Commits (6):
  - `e807f107` — feat(test): renderer test harness, and the job-port race it found (FEAT-26tkya, BUG-zcqyb7)
  - `742daaa2` — fix(e2e): make the per-job port handoff diagnosable instead of a silent 60s hang (BUG-zcqyb7)
  - `cab4d2e6` — fix(ci): skip the yt-dlp download instead of trying to authenticate it (BUG-zcqyb7)
  - `14e19185` — fix(ci): the E2E exports need a usable GPU encoder too (BUG-zcqyb7)
  - `8533c6bc` — fix(ci): probe the videotoolbox encoder by using it, not by listing it (BUG-zcqyb7)
  - `84bb3eea` — fix(ci): smokes guard on the encoder they use, not on ffmpeg existing (BUG-zcqyb7)
- Files changed (base → working tree):

```
 .github/workflows/ci.yml                       |  18 +
 .pine/memory/ci.md                             |  18 +
 .pine/memory/renderer.md                       |   4 +-
 .pine/tickets/BUG-jt3d62.md                    |  70 +++
 .pine/tickets/BUG-zcqyb7.md                    | 135 +++++
 .pine/tickets/FEAT-26tkya.md                   | 101 +++-
 .pine/tickets/FEAT-d8b6bj.md                   | 212 ++++++-
 CODE_OF_CONDUCT.md                             | 131 +++++
 CONTRIBUTING.md                                | 191 +++++++
 LICENSE                                        |  31 ++
 README.md                                      | 163 ++++++
 THIRD-PARTY-LICENSES.md                        |  49 ++
 build/licenses/ffmpeg/COPYING.GPLv3            | 674 +++++++++++++++++++++++
 build/licenses/ffmpeg/README.md                |  69 +++
 docs/PACKAGING.md                              |  71 ++-
 docs/screenshots/01-welcome.png                | Bin 0 -> 32645 bytes
 docs/screenshots/02-editor.png                 | Bin 0 -> 92473 bytes
 electron-builder.yml                           |  25 +
 package-lock.json                              | 730 ++++++++++++++++++++++---
 package.json                                   |  13 +-
 scripts/bundle-binaries.mjs                    |  57 ++
 scripts/capture-screenshots.mjs                | 130 +++++
 scripts/verify-package.mjs                     |  60 +-
 src/main/index.ts                              |  10 +
 src/renderer/src/components/SettingsPanel.tsx  |  12 +-
 src/renderer/src/hooks/jobPort.ts              |  25 +-
 src/renderer/src/hooks/useImportController.ts  |  10 +
 tests/e2e/export.e2e.spec.ts                   |  17 +-
 tests/e2e/timeline.e2e.spec.ts                 |  14 +-
 tests/e2e/vertical-slice.e2e.spec.ts           |  75 ++-
 tests/fixtures/contract/index.ts               |  19 +-
 tests/harness/fixtures.ts                      |  47 ++
 tests/harness/renderer-env.ts                  |  59 ++
 tests/mocks/openclip.ts                        |  27 +-
 tests/unit/ass-captions.serial.spec.ts         |  21 +-
 tests/unit/ffmpeg-export.serial.spec.ts        |  21 +-
 tests/unit/ffmpeg-version.serial.spec.ts       |  35 +-
 tests/unit/import-panel-drop.spec.tsx          | 136 +++++
 tests/unit/job-port-window-delivery.spec.tsx   |  81 +++
 tests/unit/settings-panel-model-draft.spec.tsx | 141 +++++
 tests/unit/smoke-strict.spec.ts                |  25 +-
 tests/unit/use-import-controller.spec.tsx      | 145 +++++
 tests/unit/use-readiness.spec.tsx              | 117 ++++
 tsconfig.test.json                             |   1 +
 vitest.config.ts                               |  12 +-
 45 files changed, 3869 insertions(+), 133 deletions(-)
```
