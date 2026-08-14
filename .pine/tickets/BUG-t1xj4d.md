---
id: BUG-t1xj4d
title: Shipped .app is 634 MB with ~95 MB of dead weight inside onnxruntime-web
status: done
priority: medium
labels:
    - perf
    - packaging
parent: EPIC-c2gg45
created: "2026-08-08T15:57:27Z"
updated: "2026-08-14T11:59:35Z"
---

## Verdict

**PARTIAL** (high confidence) · severity **P2**

This finding was produced by a finder agent and then handed to an independent adversarial
verifier whose instructions were to *refute* it, defaulting to REFUTED when uncertain. It
survived. Four sibling claims in the same pass did not — see `.pine/MEMORY.md`.

## User impact

Two very different real impacts, neither matching the claim's framing.

REAL: Download/install bloat. Users download a 634 MB .app whose app.asar is 176 MB, of which ~95 MB (74 MB unused .wasm + 21 MB sourcemaps inside onnxruntime-web) is never read at runtime — the app loads its wasm from the separate 13 MB Resources/onnx copy instead. Every user pays this on every download and update, forever. Removing it cuts app.asar from 176 MB to ~81 MB.

NOT REAL: Startup. First paint measured at 88 ms and React mounted at 133 ms in the real packaged app. Users perceive no delay from the 1.29 MB single chunk, because it loads from local disk over file:// with no transfer cost.

MARGINAL: Main-thread stalls. During an auto-reframe export the main process event loop is ~80% starved for ~2.9 s per 60 s clip, but the longest single stall measured is 49 ms. Because the UI lives in a separate renderer process, nothing visibly freezes; only IPC round-trips and job-progress events land up to ~49 ms late. On a batch of 10 clips that is ~29 s of slightly laggy IPC — survivable and almost certainly unnoticed. The numThreads=1 choice also makes detection 2.7x slower than it needs to be (20.6 ms vs 7.7 ms per frame), adding ~1.8 s per 60 s clip.

## Evidence

Every number below is measured on this machine, not estimated.

=== (a) SINGLE CHUNK — mechanically TRUE, perf impact REFUTED ===

`npx electron-vite build` (full `npm run build` fails only on a PRE-EXISTING unrelated typecheck error in tests/e2e/zz-probe-trimperf.e2e.spec.ts, a stray probe file; the bundler itself is clean):
  ../../out/renderer/assets/index-BHut_RjG.css     65.29 kB
  ../../out/renderer/assets/index-B-1jk_H_.js   1,286.01 kB
Exactly ONE JS chunk. `ls -la` confirms 1286008 bytes; gzip -c => 245039 bytes.

No code splitting anywhere in the renderer. `grep -rn "React\.lazy\|= lazy(\|Suspense\|import(" src/renderer/src` returns exactly ONE hit, and it is not a dynamic import:
  src/renderer/src/components/import-pipeline.ts:55:  const { sourceVideo } = await bridge.video.import({ filePath })

Panels are statically imported (claim's names are slightly off — they are Panels, not Dialogs):
  src/renderer/src/App.tsx:37: import { SettingsPanel } from '@renderer/components/SettingsPanel'
  src/renderer/src/App.tsx:38: import { ModelDownloadDialog } from '@renderer/components/ModelDownloadDialog'
  src/renderer/src/components/SettingsPanel.tsx:37: import { BrandKitEditor } from '@renderer/components/BrandKitEditor'
(ExportPanel.tsx likewise statically imported.)

BUT THE PERF CLAIM DOES NOT SURVIVE MEASUREMENT. I launched the REAL built app under Playwright Electron and read the renderer's own Performance API:
  STARTUP_TIMING {
    "responseEnd": 11, "domContentLoaded": 91, "loadEventEnd": 92,
    "paint": [{ "n": "first-paint", "t": 88 }],
    "now": 133   <- React had mounted into #root by here
  }
First paint at 88 ms; React mounted at ~133 ms. This is a local file:// load inside Electron — there is no network, no transfer cost, and the 245 KB gzip figure is irrelevant because nothing is gzipped over file://. index.html confirms a plain local module script:
  <script type="module" crossorigin src="./assets/index-B-1jk_H_.js"></script>
"Loads before first paint" is literally true and costs ~88 ms. There is no startup defect here.

=== (b) ONNXRUNTIME-WEB SIZE — CONFIRMED, and WORSE than claimed ===

node_modules: `du -sh node_modules/onnxruntime-web` => 130M (dist alone 126M).
It is a PRODUCTION dependency: package.json dependencies contains "onnxruntime-web": "~1.26.0" (absent from devDependencies).
It is EXTERNALIZED from the main bundle, so node_modules must ship — `grep -o` on out/main/index.js finds the literal `require("onnxruntime-web")` twice.
electron-builder.yml has no `files` rule excluding it (only src/tests/scripts/config excludes).

I did not assume — I packaged for real (`electron-builder --mac --arm64 --dir`) and extracted the resulting asar:
  stat app.asar                       => 184873703 bytes (176 MB)
  du -sh OpenClip.app                 => 634M
  npx asar list ... | grep -c onnxruntime-web => 522 entries
  du -sh (extracted) node_modules/*   =>
      129M  onnxruntime-web     <-- largest package in the asar by 4.6x
       28M  lucide-react
       14M  openai
Within the packaged copy: 74M of *.wasm and 21M of *.map.

That ~95 MB is PROVABLY DEAD. The wasm actually loaded is a SEPARATE 13 MB extraResources copy:
  reframe-detect.ts:702  ortMod.env.wasm.wasmPaths = reframeWasmDir() + '/'
  paths.ts:241-245  reframeOnnxDir() { ... return join(process.resourcesPath, 'onnx') }
  Resources/onnx => 13M { face_detection_yunet_2023mar.onnx, ort-wasm-simd-threaded.wasm, ort-wasm-simd-threaded.mjs }
The asar's package.json `main` is dist/ort.node.min.js (27 KB). So the 74 MB of .wasm + 21 MB of .map inside app.asar is never opened.

=== (b) MAIN-THREAD INFERENCE — mechanically CONFIRMED, severity OVERSTATED ===

Code is exactly as claimed (line numbers verified):
  reframe-detect.ts:701  ortMod = require('onnxruntime-web') as typeof OrtModule
  reframe-detect.ts:703  ortMod.env.wasm.numThreads = 1
  reframe-detect.ts:722  const out = await session.run({ input })
`grep -rn "worker_threads\|utilityProcess\|new Worker" src/main/` => only doc-comment mentions in sidecar-manager.ts. No worker is used for detection. export-runner.ts:35 statically imports planReframe, and runners execute in the main process. Default rate: reframe-detect.ts:429 `const sampleFps = opts.sampleFps ?? 2`.

Measured inference (real model, real ort, 30 iters after warmup):
  numThreads=1: mean 20.63 ms, p50 20.58, max 21.78
  numThreads=4: mean  7.70 ms, p50  7.12          <- the single-thread choice costs 2.7x

I MUST CORRECT MY OWN FIRST BENCHMARK. A tight `for (120) await run()` loop showed a 2508 ms CONTIGUOUS block (a 5 ms timer fired ONCE in 2514 ms) — but that is NOT the real code path and would have been a false positive. The real loop consumes ffmpeg stdout, and pipe I/O yields between frames. Faithful replication (real ffmpeg spawn with the exact frameSampleArgs filtergraph, real 60 s 1080p clip, detectFromFrameChunks logic, 5 ms event-loop lag probe):
  frames: 120  wallclock ms: 2874
  timer samples fired: 113 (ideal ~575)
  loop lag p50: 17.7  p95: 41.1  p99: 43.0  MAX: 49.0
  lag samples >16ms: 91   >50ms: 0   >100ms: 0   >500ms: 0
So: the main-process event loop is ~80% starved for the ~2.9 s detection pass, but NEVER blocked longer than 49 ms. There is no multi-second freeze. And the renderer is a separate OS process, so UI painting/animation is not blocked at all — only main-process IPC and job-progress delivery are delayed by up to ~49 ms, which is imperceptible (a cancel click or a progress tick arriving 50 ms late).

## Fix

Ranked by measured payoff.

1. P2 — strip the dead onnxruntime-web payload from app.asar (~95 MB saved, the only impact worth engineering time). In /Users/izzadev/projects/openclip/electron-builder.yml, add to `files:`:
     - '!node_modules/onnxruntime-web/dist/**/*.map'
     - '!node_modules/onnxruntime-web/dist/*.wasm'
     - '!node_modules/onnxruntime-web/docs/**'
   The runtime wasm is already shipped independently via extraResources `build/onnx` and located through ort.env.wasm.wasmPaths = reframeWasmDir() (paths.ts:253) -> process.resourcesPath/onnx, so nothing at runtime reads those files. Keep dist/ort.node.min.js (the package `main`) and the JS entry graph. Verify with `npx asar list` + a run of the existing Gate-D `diag:reframe-probe` IPC (probeReframeModel, reframe-detect.ts:757) against the packaged app, which exercises the real load+inference path.
   Consider also trimming lucide-react (28 MB in asar) the same way — it is fully bundled into the renderer chunk, so its node_modules copy is dead in the main process too.

2. P3 — recover 2.7x detection speed: raise `ortMod.env.wasm.numThreads` at reframe-detect.ts:703 from 1 to something like `Math.min(4, os.cpus().length >> 1)`. Measured 20.63 ms -> 7.70 ms per frame. This also proportionally shortens the window of IPC degradation. Do the same at line 762 in probeReframeModel.

3. P3 (optional) — if IPC latency during export ever becomes a real complaint, move detection off the main thread with `electron.utilityProcess` (the sidecar-manager doc comments at sidecar-manager.ts:22-27 already anticipate this seam) or a worker_thread. Given the measured 49 ms worst-case stall and the fact that the renderer is a separate process, this is NOT currently justified.

4. NOT RECOMMENDED — do not add React.lazy/Suspense code splitting for startup reasons. Measured first paint is 88 ms; splitting a local file:// bundle would add complexity for no measurable user gain.

Unrelated but blocking `npm run build`: tests/e2e/zz-probe-trimperf.e2e.spec.ts fails typecheck (missing `confidence` on transcript segment literals at lines 106 and 118). It is a stray probe file and should be fixed or deleted.

## Regression test

1. Packaging-size regression guard (the finding that matters). Extend /Users/izzadev/projects/openclip/scripts/verify-package.mjs — already run by `npm run verify:package` — to assert, after `electron-builder --dir`:
   - `statSync(app.asar).size < 100 * 1024 * 1024` (fails today at 184,873,703 bytes; passes at ~85 MB after the filter)
   - `asar.listPackage(app.asar).filter(p => /onnxruntime-web\/dist\/.*\.(wasm|map)$/.test(p)).length === 0` (fails today with the 74 MB of .wasm and 21 MB of .map present; passes after)
   - positive control so the filter cannot over-delete: `existsSync(<Resources>/onnx/ort-wasm-simd-threaded.wasm)` and the model file remain present.

2. Runtime proof the trimmed package still infers. In the packaged-app E2E (tests/e2e/packaged-app.e2e.spec.ts), invoke the existing `diag:reframe-probe` IPC and assert it resolves with the 9 expected YuNet output names (cls_8/16/32, obj_8/16/32, bbox_8/16/32). This fails loudly if the asar filter strips something the loader actually needs, and passes both before and after the fix.

3. Thread-count assertion (for fix #2), as a @serial smoke beside the existing reframe smoke: assert `ort.env.wasm.numThreads > 1` on a multi-core host, and assert mean per-frame inference over 20 iters is under 15 ms. Fails today at 20.6 ms / numThreads===1; passes after.

Note on what NOT to test: an event-loop-lag threshold test would be flaky and would encode a non-problem — the measured worst-case stall is 49 ms and the UI runs in a separate process. And any "bundle must be code-split" assertion should be skipped outright given the measured 88 ms first paint.

## Work Evidence

Closed by `pine close --evidence` on 2026-08-14.

- Base: `3ea7b027` (last commit at or before ticket created 2026-08-08)
- Commits (2):
  - `04da25e1` — perf(package): strip 114 MB of dead weight and unpin the detector's thread count (BUG-t1xj4d)
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
 .pine/memory/renderer.md                           |  15 +
 .pine/prompts/fix.md                               |  22 +
 .pine/templates/bug.md                             |  14 +
 .pine/templates/epic.md                            |   3 +
 .pine/templates/feature.md                         |  12 +
 .pine/tickets/BUG-19bt2k.md                        | 158 +++++
 .pine/tickets/BUG-2hjt1x.md                        | 226 +++++++
 .pine/tickets/BUG-2smqpv.md                        | 250 +++++++
 .pine/tickets/BUG-88mac4.md                        | 210 ++++++
 .pine/tickets/BUG-e06a9d.md                        | 338 ++++++++++
 .pine/tickets/BUG-ery7v7.md                        | 233 +++++++
 .pine/tickets/BUG-g6zq2t.md                        | 104 +++
 .pine/tickets/BUG-j8pbj9.md                        | 146 +++++
 .pine/tickets/BUG-jt3d62.md                        | 156 +++++
 .pine/tickets/BUG-t1xj4d.md                        | 134 ++++
 .pine/tickets/BUG-y6y5mf.md                        | 300 +++++++++
 .pine/tickets/BUG-yq6qbw.md                        | 212 ++++++
 .pine/tickets/BUG-yxvrwx.md                        | 296 +++++++++
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
 .pine/tickets/FEAT-5hnsby.md                       | 261 ++++++++
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
 electron-builder.yml                               |  38 ++
 package-lock.json                                  | 730 +++++++++++++++++++--
 package.json                                       |  13 +-
 scripts/bundle-binaries.mjs                        |  57 ++
 scripts/capture-screenshots.mjs                    | 130 ++++
 scripts/verify-package.mjs                         | 107 ++-
 src/main/index.ts                                  |  19 +
 src/main/ipc/ai.ts                                 | 147 ++++-
 src/main/ipc/index.ts                              |   4 +-
 src/main/ipc/job-start-validation.ts               |  41 +-
 src/main/ipc/model.ts                              |  25 +-
 src/main/ipc/settings.ts                           |  98 ++-
 src/main/ipc/system.ts                             |  81 +++
 src/main/services/ai-client.ts                     | 216 ++++--
 src/main/services/ass-captions.ts                  |  50 +-
 src/main/services/encoder-probe.ts                 |  64 ++
 src/main/services/ffmpeg-caption.ts                |   8 +-
 src/main/services/ffmpeg-export.ts                 |  75 ++-
 src/main/services/jobs/export-runner.ts            | 117 +++-
 src/main/services/jobs/generate-clips-runner.ts    | 133 ++++
 src/main/services/model-manager.ts                 |  27 +-
 src/main/services/openrouter-models.ts             |  37 +-
 src/main/services/provider-models.ts               | 146 +++++
 src/main/services/reframe-detect.ts                |  46 +-
 src/main/services/sidecar-manager.ts               |   5 +
 src/main/services/silence-detect.ts                |   4 +
 src/main/utils/paths.ts                            |  29 +-
 src/preload/api/files.ts                           |  35 +
 src/preload/index.ts                               |   7 +-
 src/renderer/src/App.tsx                           | 112 +++-
 src/renderer/src/assets/index.css                  |  29 +
 src/renderer/src/components/ClipSidebar.tsx        |  51 +-
 src/renderer/src/components/ExportPanel.tsx        | 128 +++-
 src/renderer/src/components/ImportPanel.tsx        |  74 ++-
 src/renderer/src/components/JobStatusBar.tsx       | 256 ++++++++
 .../src/components/ModelDownloadDialog.tsx         | 100 ++-
 src/renderer/src/components/ReadinessBar.tsx       |  75 +++
 src/renderer/src/components/SettingsPanel.tsx      | 575 ++++++++++------
 .../src/components/TranscriptionSettings.tsx       | 176 +++++
 src/renderer/src/components/batch-export.ts        |   7 +
 src/renderer/src/components/export-run.ts          |  14 +-
 src/renderer/src/components/formatBytes.ts         |  15 +
 src/renderer/src/components/generate-clips-run.ts  |  54 ++
 src/renderer/src/components/generateClips.ts       |  12 +-
 src/renderer/src/components/import-pipeline.ts     |  42 +-
 src/renderer/src/components/jobStatus.ts           | 322 +++++++++
 src/renderer/src/components/model-download.ts      |   7 +
 src/renderer/src/components/readinessView.ts       | 132 ++++
 src/renderer/src/components/settingsView.ts        |  95 ++-
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
 .../src/stores/projectStore/exportSlice.ts         |  11 +-
 src/renderer/src/stores/uiStore.ts                 |  37 +-
 src/shared/channels.ts                             | 125 +++-
 src/shared/jobs.ts                                 |  98 ++-
 tests/e2e/export.e2e.spec.ts                       |  27 +-
 tests/e2e/generate-clips-button.e2e.spec.ts        |  41 ++
 tests/e2e/integration-wave1.e2e.spec.ts            |  31 +-
 tests/e2e/job-status-bar.e2e.spec.ts               | 127 ++++
 tests/e2e/model-gate.e2e.spec.ts                   |  53 ++
 tests/e2e/ping.e2e.spec.ts                         |  72 +-
 tests/e2e/timeline.e2e.spec.ts                     |  27 +-
 tests/e2e/vertical-slice.e2e.spec.ts               |  75 ++-
 tests/fixtures/contract/index.ts                   |  19 +-
 tests/harness/fixtures.ts                          |  47 ++
 tests/harness/renderer-env.ts                      |  59 ++
 tests/mocks/openclip.ts                            |  47 +-
 tests/unit/ai-components.spec.ts                   |  57 +-
 tests/unit/ai-ipc.spec.ts                          | 160 ++++-
 tests/unit/ai-mapreduce.spec.ts                    | 112 ++++
 tests/unit/ai-stores.spec.ts                       | 162 +++--
 tests/unit/ass-captions.serial.spec.ts             |  21 +-
 tests/unit/ass-playres.serial.spec.ts              | 116 ++++
 tests/unit/ass-playres.spec.ts                     | 127 ++++
 tests/unit/autosave-subscriber.spec.ts             |  73 +++
 tests/unit/contract.spec.ts                        |  24 +
 tests/unit/dialog-scroll.spec.tsx                  | 101 +++
 tests/unit/export-runner.spec.ts                   |  67 +-
 tests/unit/ffmpeg-export.serial.spec.ts            |  63 +-
 tests/unit/ffmpeg-export.spec.ts                   |  56 +-
 tests/unit/ffmpeg-version.serial.spec.ts           |  35 +-
 tests/unit/force-cpu.spec.ts                       | 160 +++++
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
 tests/unit/openrouter-curated.serial.spec.ts       | 111 ++++
 tests/unit/preload-parity.spec.ts                  |  18 +-
 tests/unit/project-id-path-safety.spec.ts          | 104 +++
 tests/unit/provider-models.spec.ts                 | 118 ++++
 tests/unit/readiness-view.spec.ts                  | 117 ++++
 tests/unit/reframe.serial.spec.ts                  |  35 +-
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
 212 files changed, 19108 insertions(+), 884 deletions(-)
```
