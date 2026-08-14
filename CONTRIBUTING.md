# Contributing to OpenClip Desktop

Thanks for looking. This document covers the things that are genuinely easy to
get wrong in this codebase — the frozen contract seams, the four-project
typecheck, and the packaging prerequisite that is not discoverable from the
build error alone.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting set up

```bash
npm install
npm run dev        # electron-vite dev server with HMR
```

You need Node 20+ and macOS on Apple Silicon. `npm install` runs
`electron-builder install-app-deps` as a postinstall step.

The heavy binaries are **not committed**. For `npm run dev` you do not need them:
`src/main/utils/paths.ts` falls back to your PATH / Homebrew. Installing
`ffmpeg` and `whisper-cpp` via Homebrew is enough for day-to-day work:

```bash
brew install ffmpeg whisper-cpp
```

## Quality gates

Run these before opening a PR. CI runs the same things.

```bash
npm run typecheck   # ALL FOUR tsconfig projects — see below
npm run lint        # eslint (cached)
npm test            # vitest: unit + integration
npm run test:e2e    # Playwright against the real Electron app
npm run build       # typecheck + electron-vite build
```

### Typecheck is four projects, not one

`npm run typecheck` runs `tsconfig.node.json` (main), `.web.json` (renderer),
`.shared.json` (`src/shared`) and `.test.json` (tests) separately, because the
three processes have genuinely different lib/globals.

**Anything you touch in `src/shared/` can break several of them at once.**
Checking one project and moving on is the most common way to push a red build —
always run the full `npm run typecheck`, or just `npm run build`, which does it
for you.

### Tests

- **Vitest is the bulk.** The LLM is mocked at the `ai-client` boundary, so **no
  network runs in tests, ever**. `safeStorage` is mocked too.
- **Real-binary "smoke" tests** (`*.serial.spec.ts`, tagged `@serial`) run the
  actual ffmpeg / whisper-cli / libass / ONNX YuNet against tiny fixtures. They
  `skipIf` themselves when the binaries or cached fixtures are absent, so
  `npm test` stays green on a bare checkout. To exercise them locally you need
  ffmpeg and `whisper-cli` on PATH; or point the overrides at your own build
  (`OPENCLIP_FFMPEG`, `OPENCLIP_WHISPER_CLI`, `OPENCLIP_ONNX_DIR`, …).
  Their assertions are _structural_ — run the binary, `ffprobe` the output for
  duration/resolution/codec. No pixel diffs.
- **Renderer components and hooks** are tested with jsdom + Testing Library. A
  spec opts into a DOM with a docblock on line 1:

  ```ts
  // @vitest-environment jsdom
  ```

  then calls `installRendererEnv()` from `tests/harness/renderer-env.ts` in a
  `beforeEach`, which installs a fresh mock bridge on `window` and resets the
  renderer's module singletons. The suite default stays `node` on purpose — most
  of it is main-process and pure view-model code.

- Pure view-models (`readinessView`, `clipView`, `timeline-math`, …) and
  framework-free cores (`import-controller`, `export-run`, `batch-export`) are
  tested directly, without React. Keep that split: put logic in the core, and
  keep the component a thin shell.

## The four frozen contract seams

Some files carry a **FROZEN** header. They are not off-limits, but a change there
is a deliberate cross-cutting contract change that ripples into both processes
_and_ the drift-detection tests — not a casual edit. The seams are:

1. **`src/shared/schema.ts`** — the Zod source of truth for the data model
   (`Project`, `Transcript`, `Clip`, `Settings`, and the AI `ClipSchema`). TS
   types are _inferred_ from the Zod schemas. The AI-facing schemas use
   `z.strictObject` so they satisfy OpenAI strict `json_schema` / Anthropic
   `zodOutputFormat` — relaxing that will break structured output at runtime
   without breaking a type.
2. **`src/shared/channels.ts`** — the request/response control plane: the
   `IPCChannels` enum plus `ChannelMap`. The preload bridge type is **derived**
   from this map via mapped types; never hand-write it.
3. **`src/shared/jobs.ts`** — the streaming-job contract. The invariant worth
   protecting: **every job terminates with `done` xor `error` — never a silent
   hang.**
4. **`src/preload/index.ts`** — assembles `window.openclip`. `preload-parity.spec.ts`
   and `tests/unit/contract.spec.ts` fail the build if the runtime bridge drifts
   from the type-level contract.

If you change one, change the others _and_ the drift tests in the same commit.

### Add behaviour at the edges, not in the hubs

The architecture is deliberately trunk-and-branches:

- A new IPC call → add the channel and fill a **domain handler** in
  `src/main/ipc/<domain>.ts`. Handlers receive a single `IpcContext` (the DI
  seam); they never reach for module singletons.
- A new long-running job → add the kind to `jobs.ts` and write a **runner** in
  `src/main/services/jobs/<kind>-runner.ts`, then `registerRunner(kind, runner)`.
  **Do not edit `sidecar-manager.ts`** — it is the host and knows nothing about
  specific jobs.
- New renderer state → add to a **one-writer slice** under
  `src/renderer/src/stores/projectStore/`. Store actions call `window.openclip`
  directly, so backend code never imports a store.

## Conventions

- **Import via the aliases** (`@shared/…`, `@main/…`, `@renderer/…`, `@preload/…`),
  never deep relative paths across process boundaries.
- ESLint (`@electron-toolkit`) + Prettier: **no semicolons, single quotes**.
  `npm run format` fixes style.
- Comments in this codebase cite the build plan ("Part H", "Gate A", "Wave 1")
  and PRD sections ("PRD §10.2"). When you cannot tell _why_ something is shaped
  the way it is, grep the cited section in [`docs/prd.md`](docs/prd.md) — the
  answer is usually there.

## Issue tracking

This repo uses [Pine](https://github.com/underworld14/pine), a git-native tracker
that lives in `.pine/` and is committed alongside the code.

```bash
pine context          # project briefing — start here
pine ready            # unblocked, actionable tickets
pine show <ID>        # one ticket in full
pine close <ID> --evidence
```

Please track non-trivial work with a ticket rather than a markdown TODO list.

## Packaging

Full detail is in [`docs/PACKAGING.md`](docs/PACKAGING.md). Two things bite
people:

### 1. You must build `whisper-cli` yourself

There is no npm package for it, and **a Homebrew `whisper-cli` will be rejected**
— brew binaries link brew dylibs, so they are not relocatable and the packaged
`.app` would break on any machine but yours. `scripts/bundle-binaries.mjs`
enforces this with an `otool -L` check.

Build a static, Metal-embedded one:

```bash
git clone --branch v1.8.4 https://github.com/ggml-org/whisper.cpp.git
cd whisper.cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
      -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DWHISPER_BUILD_EXAMPLES=ON
cmake --build build --config Release
```

Then either place the result at `build/whisper-build/bin/whisper-cli` in this
repo, or point `OPENCLIP_WHISPER_CLI_SRC` at it.

### 2. FFmpeg is GPL, and its licence must ship with it

The bundled FFmpeg is GPL-3.0-or-later. `scripts/bundle-binaries.mjs` stages
`build/licenses/ffmpeg/` next to the binaries and verifies the GPL text is
verbatim (SHA-pinned); `scripts/verify-package.mjs` fails if it did not make it
into the `.app`. Do not "clean up" those files — see
[`THIRD-PARTY-LICENSES.md`](THIRD-PARTY-LICENSES.md).

Then:

```bash
npm run build:mac:unsigned   # dmg, no Apple account needed
npm run verify:package       # asserts the .app resolves sidecars from Contents/Resources
```

## Pull requests

- One logical change per PR; keep the frozen-seam changes separate from feature work.
- Include the ticket ID in the commit subject when there is one.
- Say what you actually verified. "Tests pass" is worth less than "added a spec
  that is red before and green after, plus `npm run verify:package`".
- New behaviour needs a test. If a bug was not caught by the existing suite, say
  why — that gap is usually the more interesting half of the fix.
