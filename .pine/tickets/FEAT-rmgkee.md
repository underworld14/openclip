---
id: FEAT-rmgkee
title: Nothing tells the user what an API key is, where to get one, or that it costs money
status: done
priority: high
labels:
    - copy
parent: EPIC-k83ghw
phase: p1
created: "2026-08-15T11:28:11Z"
updated: "2026-08-15T14:25:14Z"
---

## Problem
The product's one hard prerequisite is presented as a password box with no context.

## Evidence
Read from the **running packaged app**, AI tab, clean profile:
```
AI Provider (BYOK)              ← "BYOK" is the first label a new user sees
Model  [Load models] [Test]
No models loaded — add your OpenAI key, then press Load models.
Clip detection needs a model that supports strict JSON output. Not every listed
model does — press Test to check one before relying on it.
API key for OpenAI — No key set
The key is encrypted with the OS keychain (safeStorage) and used only on this device…
```
- `grep -rn "platform.openai.com|console.anthropic|openrouter.ai/keys|ollama.com" src/`
  → **zero hits**. The only such URL in the repo is `README.md:61`.
- No cost estimate is shown for any provider except OpenRouter, and only if Settings was
  opened that session.
- `Ollama (local)` — the one no-key, no-cost path — is in the provider list but the default
  is OpenAI and nothing says Ollama needs neither a key nor money (it is separate software).

## Impact
A creator who has never used an LLM API is told *what* is missing and never *how* to get
it. Setup is a 5-step chain (paste key → Save → Load models → pick model → Test) with no
guidance, wrapped in vocabulary from the implementation (`BYOK`, `safeStorage`, "strict
JSON output").

## Fix
Add a per-provider "Get a key →" external link beside the key field, one plain sentence
explaining what an API key is and that the user pays the provider directly, a rough cost
per hour of video, and a "no key needed" badge on Ollama. Replace `BYOK`, `safeStorage`
and "strict JSON output" with user-facing words.

## Acceptance Criteria
- [x] Each provider links to its key page
- [x] The AI tab explains what a key is and who charges for it
- [x] Ollama is presented as the free, no-key option
- [x] No implementation vocabulary remains in the AI tab

## Resolution
- `shared/ai-providers.ts`: new `providerKeyUrl(provider)` (real key-page URLs for
  openai/anthropic/google/openrouter; `undefined` for `ollama` — no key at all — and
  `custom` — an arbitrary self-hosted server with no one fixed page) and
  `providerCostHint(provider)` — a deliberately QUALITATIVE, hedged cost hint ("Typically a
  few cents per hour of video with an efficient model"), not a hard dollar figure that would
  drift out of date independent of any OpenClip release.
- `components/SettingsPanel.tsx` AI tab:
  - New plain-language explainer paragraph at the TOP of the tab, before any
    provider-specific control: what clip detection sends (transcript text only, never
    video), who gets paid (the provider, directly — OpenClip never bills or sees the key),
    and that Ollama is the free/no-key option.
  - "AI Provider (BYOK)" → "AI Provider"; the Ollama option in the dropdown itself now reads
    "Ollama (local) — free, no key".
  - Selecting Ollama shows a distinct badge ("Free · runs on this Mac · no key needed") with
    a real link to ollama.com (separate, free software) — and the key field is hidden
    entirely for it, since there is nothing to fill in.
  - A "Get a key ↗" link (opens in the OS browser via the app's existing
    `setWindowOpenHandler`, never in-app) appears beside the key label for every provider
    `providerKeyUrl` covers; absent for ollama/custom.
  - A cost-hint line under the key field for every provider `providerCostHint` covers.
  - "The key is encrypted... (safeStorage)" → explains what a key even IS ("a password that
    identifies YOUR account to {provider}") before the storage detail, and drops the
    internal mechanism name.
  - "needs a model that supports strict JSON output" → "needs a model that can reliably
    follow the exact result format it asks for".

## Verification
- `tests/unit/ai-providers-meta.spec.ts` (6 new tests): every keyed provider's URL is a real
  https link; ollama/custom have none; every keyed provider has a cost hint; ollama has
  none; no hint ever contains a hard `$` figure.
- `tests/unit/settings-panel-copy.spec.tsx` (7 new tests): "BYOK"/"safeStorage"/"strict
  JSON" appear NOWHERE in the rendered AI tab across all 5 providers; the explainer
  paragraph is present and names the actual facts (transcript-only, who pays, Ollama free);
  the "Get a key" link has the correct href and opens externally; it is absent for
  ollama/custom; Ollama's free badge appears only for Ollama and hides the key field
  entirely; the cost hint renders with no `$` figure.
- `tests/unit/settings-tabs.spec.tsx`: updated the one assertion that named the old "(BYOK)"
  label.
- Full suite: `npm run typecheck` (all 4), `npm run lint`, `npm test` — 1568 passed / 10
  skipped, run twice for determinism, clean.
- **Live, against the real packaged app**, on a genuinely clean profile (fresh
  `--user-data-dir`, matching the ticket's own "clean profile" evidence): screenshots
  confirm — the explainer paragraph renders at the top of the AI tab; selecting Ollama shows
  the green free badge with a working ollama.com link and no key field; OpenAI shows a
  working "Get a key ↗" link to platform.openai.com, the plain-language key explanation, and
  the qualitative cost hint; body-text scan across both providers found zero occurrences of
  "BYOK", "safeStorage", or "strict JSON".

## Work Evidence

Closed by `pine close --evidence` on 2026-08-15.

- Base: `216f85f1` (last commit at or before ticket created 2026-08-15)
- Commits (1):
  - `0ab7f99d` — chore(pine): file the production-readiness & UX audit (EPIC-k83ghw)
- Files changed (base → working tree):

```
 .pine/MEMORY.md                                    |   2 +
 .pine/memory/renderer.md                           |   4 +-
 .pine/memory/testing.md                            |   3 +-
 .pine/tickets/BUG-08sb0x.md                        |  36 +++
 .pine/tickets/BUG-12bxbk.md                        |  33 +++
 .pine/tickets/BUG-15cddx.md                        | 138 ++++++++++
 .pine/tickets/BUG-1m642d.md                        |  59 ++++
 .pine/tickets/BUG-44fgyv.md                        |  38 +++
 .pine/tickets/BUG-4c3gj3.md                        | 118 ++++++++
 .pine/tickets/BUG-5jwaxf.md                        | 118 ++++++++
 .pine/tickets/BUG-8kgcxs.md                        | 129 +++++++++
 .pine/tickets/BUG-93txd0.md                        | 126 +++++++++
 .pine/tickets/BUG-9v667j.md                        | 128 +++++++++
 .pine/tickets/BUG-adfj3b.md                        | 119 +++++++++
 .pine/tickets/BUG-aryvgg.md                        | 214 +++++++++++++++
 .pine/tickets/BUG-bxqmex.md                        | 134 ++++++++++
 .pine/tickets/BUG-fcg251.md                        | 119 +++++++++
 .pine/tickets/BUG-gasxqq.md                        | 122 +++++++++
 .pine/tickets/BUG-hfwbeb.md                        | 133 +++++++++
 .pine/tickets/BUG-hkmsng.md                        | 209 +++++++++++++++
 .pine/tickets/BUG-hqbett.md                        |  40 +++
 .pine/tickets/BUG-phta04.md                        | 127 +++++++++
 .pine/tickets/BUG-prkcq1.md                        |  33 +++
 .pine/tickets/BUG-qcvhcn.md                        |  44 +++
 .pine/tickets/BUG-sg6kqg.md                        | 203 ++++++++++++++
 .pine/tickets/BUG-t19z5j.md                        | 186 +++++++++++++
 .pine/tickets/BUG-tdgtfb.md                        | 125 +++++++++
 .pine/tickets/BUG-vv87d6.md                        | 120 +++++++++
 .pine/tickets/BUG-w2jv3w.md                        | 106 ++++++++
 .pine/tickets/BUG-whdqsc.md                        | 231 ++++++++++++++++
 .pine/tickets/BUG-y9km1j.md                        |  60 +++++
 .pine/tickets/EPIC-k83ghw.md                       |  66 +++++
 .pine/tickets/FEAT-azvb5c.md                       |  57 ++++
 .pine/tickets/FEAT-rmgkee.md                       | 100 +++++++
 .pine/tickets/FEAT-vz5vya.md                       | 118 ++++++++
 .pine/tickets/FEAT-x9femg.md                       | 125 +++++++++
 README.md                                          |  45 +++-
 package-lock.json                                  | 100 ++++++-
 package.json                                       |   1 +
 src/main/index.ts                                  | 120 ++++++++-
 src/main/ipc/audio.ts                              |  50 ++--
 src/main/ipc/job-start-validation.ts               |  13 +-
 src/main/ipc/media.ts                              |  15 +-
 src/main/ipc/system.ts                             |  20 +-
 src/main/ipc/video.ts                              |   8 +-
 src/main/menu.ts                                   |  24 +-
 src/main/services/ai-client.ts                     |  26 +-
 src/main/services/ffmpeg-extract.ts                |   6 +
 src/main/services/jobs/extract-audio-runner.ts     |  93 +++++++
 src/main/services/jobs/generate-clips-runner.ts    |  26 ++
 src/main/services/media-store.ts                   |  29 ++
 src/main/services/sidecar-errors.ts                | 172 ++++++++++++
 src/main/services/sidecar-manager.ts               |  54 +++-
 src/main/services/updater.ts                       |  59 ++++
 src/main/utils/ffprobe.ts                          |  26 +-
 src/preload/api/audio.ts                           |  12 -
 src/preload/index.ts                               |   4 -
 src/renderer/src/App.tsx                           | 130 +++++++--
 src/renderer/src/assets/index.css                  |  36 +++
 src/renderer/src/components/ErrorBoundary.tsx      |  86 ++++++
 src/renderer/src/components/ExportPanel.tsx        |  30 ++-
 .../src/components/GeneratePreflightDialog.tsx     |  39 ++-
 src/renderer/src/components/ImportPanel.tsx        |  28 +-
 src/renderer/src/components/PreviewPlayer.tsx      | 297 +++++++++++++++++++--
 src/renderer/src/components/SettingsPanel.tsx      | 121 +++++++--
 src/renderer/src/components/Timeline.tsx           |  65 +++--
 src/renderer/src/components/batch-export.ts        |  42 ++-
 src/renderer/src/components/caption-css.ts         |  40 ++-
 src/renderer/src/components/import-pipeline.ts     |  90 ++++++-
 src/renderer/src/components/jobStatus.ts           |  15 ++
 src/renderer/src/components/model-download.ts      |   5 +-
 src/renderer/src/components/preview-crop.ts        |  49 +++-
 src/renderer/src/components/timeline-math.ts       |  57 ++++
 src/renderer/src/hooks/import-controller.ts        | 219 ++++++++++++++-
 src/renderer/src/hooks/useGlobalShortcuts.ts       |   9 +-
 src/renderer/src/hooks/useImportController.ts      |   9 +-
 src/renderer/src/hooks/useProject.ts               |  58 +++-
 src/renderer/src/main.tsx                          |   5 +-
 src/renderer/src/stores/jobsStore.ts               |  11 +-
 src/renderer/src/stores/projectStore/clipsSlice.ts | 121 +++++++--
 .../src/stores/projectStore/previewSlice.ts        |   8 +
 src/shared/ai-providers.ts                         |  39 +++
 src/shared/channels.ts                             |  17 +-
 src/shared/jobs.ts                                 |  26 ++
 src/shared/schema.ts                               |  12 +-
 src/shared/shortcuts.ts                            |  32 +++
 tests/e2e/vertical-slice.e2e.spec.ts               |  78 +++++-
 tests/harness/renderer-env.ts                      |  25 ++
 tests/mocks/openclip.ts                            |  11 +-
 tests/unit/ai-mapreduce.spec.ts                    |  75 ++++++
 tests/unit/ai-stores.spec.ts                       |  93 ++++++-
 tests/unit/app-menu.spec.ts                        |  23 ++
 tests/unit/batch-export.spec.ts                    |  62 +++++
 tests/unit/caption-css.spec.ts                     |  16 +-
 tests/unit/clip-reject-undo.spec.tsx               |  29 ++
 tests/unit/dialog-handlers.spec.ts                 |  10 +-
 tests/unit/error-boundary.spec.tsx                 |  64 +++++
 tests/unit/export-cancel.spec.tsx                  |  26 ++
 tests/unit/extract-audio-runner.spec.ts            | 100 +++++++
 tests/unit/ffprobe.spec.ts                         |  24 +-
 tests/unit/generate-clips-runner.spec.ts           |  87 ++++++
 tests/unit/generate-preflight-dialog.spec.tsx      |  37 ++-
 tests/unit/global-shortcuts.spec.tsx               |  44 +++
 tests/unit/import-controller.spec.ts               |  16 +-
 tests/unit/import-pipeline.spec.ts                 |  93 ++++++-
 tests/unit/import-url.spec.ts                      |  35 ++-
 tests/unit/ipc-media.spec.ts                       |  25 +-
 tests/unit/job-start-validation.spec.ts            |  55 ++++
 tests/unit/job-status.spec.ts                      |  24 ++
 tests/unit/onboarding-handlers.spec.ts             |  58 +++-
 tests/unit/preload-parity.spec.ts                  |   6 +-
 tests/unit/preview-crop.spec.ts                    |  72 ++++-
 tests/unit/preview-fitmode.spec.tsx                | 201 ++++++++++++++
 tests/unit/reframe-visibility.spec.tsx             |  15 +-
 tests/unit/settings-tabs.spec.tsx                  |   4 +-
 tests/unit/shortcuts.spec.ts                       |  25 ++
 tests/unit/sidecar-errors.spec.ts                  | 142 ++++++++++
 tests/unit/sidecar-manager.spec.ts                 |  63 +++++
 tests/unit/timeline-math.spec.ts                   |  80 ++++++
 tests/unit/updater.spec.ts                         |  88 ++++++
 tests/unit/use-project.spec.ts                     |  50 +++-
 121 files changed, 7846 insertions(+), 332 deletions(-)
```
