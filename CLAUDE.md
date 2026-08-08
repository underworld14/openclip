# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

OpenClip Desktop is an open-source, local-first, **BYOK** (Bring Your Own Key) AI video-clipping app (Electron + React, macOS Apple Silicon first). It turns long videos into vertical short-form clips: local transcription (whisper.cpp), AI viral-moment detection (cloud LLM, **transcript text only — never the video**), FFmpeg cut/reframe/caption-burn, and a minimal trim timeline. The authoritative spec is `docs/prd.md` (PRD v2.0.0); auto-reframe is detailed in `docs/auto-reframe-design.md`; packaging in `docs/PACKAGING.md`.

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **Note remaining work** - Write down anything that needs follow-up in the hand-off
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   git push
   git status  # MUST show "up to date with origin"
   ```
4. **Clean up** - Clear stashes, prune remote branches
5. **Verify** - All changes committed AND pushed
6. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds


## Build & Test

```bash
npm run dev              # electron-vite dev (HMR; renderer over http, CSP relaxed for Vite/Fast-Refresh)
npm start                # electron-vite preview (run the built bundle)

npm run typecheck        # ALL FOUR projects: node + web + shared + test (see note below)
npm run lint             # eslint --cache .
npm run format           # prettier --write .
npm run build            # typecheck + electron-vite build  (run before packaging)

npm test                 # vitest run (unit + integration; real-binary smokes self-skip — see below)
npm run test:watch       # vitest watch
npx vitest run tests/unit/clip-bounds.spec.ts   # a single file
npx vitest run -t "clamps overlapping spans"    # by test-name pattern
npm run test:e2e         # Playwright Electron E2E (workers:1, serialized)

# Packaging (macOS arm64; see docs/PACKAGING.md)
npm run build:mac:unsigned   # dmg, no Apple account needed
npm run build:mac            # signed + notarized (needs your Apple Developer creds + build/notarize.cjs)
npm run verify:package       # scripts/verify-package.mjs — asserts the .app resolves sidecars from Contents/Resources
```

**Typecheck is split into four tsconfig *projects*** (`tsconfig.node.json` = main, `.web.json` = renderer, `.shared.json` = `src/shared`, `.test.json` = tests). Editing anything in `src/shared/` can break several at once — always run the full `npm run typecheck`, not just one. `npm run build` runs it for you.

**Real-binary "smoke" tests** (`*.serial.spec.ts`, tagged `@serial`) run the *actual* ffmpeg / whisper-cli / libass / ONNX YuNet against tiny fixtures. They `describe.skipIf`/`it.skipIf` themselves when the binaries or the `.smoke-cache/` model/WAV are absent, so `npm test` stays green on a bare checkout. To exercise them locally you need ffmpeg + a `whisper-cli` on PATH (`brew install whisper-cpp`) and the cached fixtures, or point the overrides at your own: `OPENCLIP_FFMPEG`, `OPENCLIP_FFPROBE`, `OPENCLIP_WHISPER_CLI`, `OPENCLIP_FONTS_DIR`, `OPENCLIP_ONNX_DIR`, `OPENCLIP_SMOKE_MODEL/_WAV/_SRC/_ASS`. They carry the `@serial` tag because they share one machine GPU and must run single-file.

## Architecture Overview

Three Electron processes (built by **electron-vite**, three Vite sub-configs in `electron.vite.config.ts`). Path aliases `@main`, `@shared`, `@preload`, `@renderer` are defined identically in `electron.vite.config.ts`, `vitest.config.ts`, and `tsconfig.json`.

- **`src/main/`** — Node.js: filesystem, IPC handlers, sidecar/job orchestration, AI client. Entry `src/main/index.ts`.
- **`src/preload/`** — the `contextBridge`. Exposes `window.openclip` (typed `OpenClipBridge`).
- **`src/renderer/src/`** — React 19 + Tailwind v4 + shadcn/ui (`components/ui/`) + **Zustand** stores.
- **`src/shared/`** — code imported by BOTH processes: the Zod data model and the IPC/job contracts.

### The contract seams (this is the load-bearing design — read before changing IPC/data shapes)

The codebase was built trunk-first: a set of files are explicitly **FROZEN contracts** (their headers say so). Treat changes to them as cross-cutting — they ripple to both processes and to drift-detection tests. The four seams:

1. **`src/shared/schema.ts`** — THE Zod source of truth for the data model (`Project`, `Transcript`, `Clip`, `Settings`, and the AI `ClipSchema`). TS types are inferred from the Zod schemas; both processes import from here. Used for `.ocproj` load-validation, AI structured-output parsing, and contract-fixture tests. The AI-facing schemas use `z.strictObject` (→ `additionalProperties:false`, all required) so they satisfy OpenAI strict `json_schema` / Anthropic `zodOutputFormat`.

2. **`src/shared/channels.ts`** — the request/response control-plane: `IPCChannels` enum + `ChannelMap` (channel → `{req, res}`). The preload bridge type is **derived** from this map via mapped types — never hand-written.

3. **`src/shared/jobs.ts`** — the streaming-job contract: `JobKind` (`transcribe | export | model-download | url-download`), `JobParams[K]`, `JobResult[K]`, `JobPartial[K]`, and the `JobEvent` discriminated union (`progress | partial | done | error`). Invariant: **every job always terminates with `done` xor `error` — never a silent hang.**

4. **`src/preload/index.ts`** — assembles `window.openclip` from per-domain builders in `src/preload/api/*`. `preload-parity.spec.ts` and `tests/unit/contract.spec.ts` fail the build if the runtime bridge drifts from the type-level contract.

### Two IPC planes

- **Control plane** (request/response): `ipcRenderer.invoke`. Handlers live one-per-domain in `src/main/ipc/<domain>.ts` and are registered by looping the frozen `HANDLER_REGISTRARS` array in `src/main/ipc/index.ts`. Every handler receives a single `IpcContext` (the DI seam built once in `main/index.ts`) — handlers never reach for module singletons.
- **Streaming-job plane**: `JOB_START` is a plain `invoke` returning `{ jobId }`. The per-job **`MessagePort`** is delivered *out-of-band* over the `JOB_PORT` channel (`event.senderFrame.postMessage(..., [port2])`) because a MessagePort can neither ride `invoke` nor survive crossing the contextBridge. The renderer pairs the live port to the jobId (`renderer/src/hooks/jobPort.ts`, `useJob.ts`). `JOB_CANCEL` stays a separate `invoke` so cancel can't be starved by a busy data port.

### Sidecar host + job runners

`src/main/services/sidecar-manager.ts` (`SidecarManager`, FROZEN) is the host: it owns p-queue concurrency (`transcribe` = 1, `export` = `min(2, ceil(cores/4))`, downloads overlap), PID tracking + kill-on-quit (SIGTERM→SIGKILL after a 3 s grace, on quit / `child-process-gone` / renderer port-close), and cancellation. It does **not** know about specific jobs: each job kind registers a runner via `registerRunner(kind, runner)` from its own `src/main/services/jobs/<kind>-runner.ts`. Add a new long job by adding the kind to `jobs.ts` and a runner file — don't edit the manager.

### Native-first sidecars (no Python)

All heavy work is bundled binaries spawned/loaded natively: **ffmpeg / ffprobe** (cut, 9:16 reframe, libass caption burn, silence jump-cuts), **whisper-cli** (whisper.cpp, Metal/Core ML on Apple Silicon, word-level timestamps), **yt-dlp** (URL/YouTube import), and **ONNX YuNet** face detection via `onnxruntime-web` (WASM — no native addon) for speaker-following auto-reframe. `src/main/utils/paths.ts` resolves every binary/asset: **dev** → `node_modules` / PATH / brew / repo `build/` dirs; **prod** → `process.resourcesPath/...`. GGML whisper models are **not bundled** — downloaded on demand to `userData/models/` (the `model-download` job + `ModelDownloadDialog`). Binaries are staged into `resources/` at package time by `scripts/bundle-binaries.mjs` (pinned + SHA-verified), not committed.

The FFmpeg pipeline is composed from `services/ffmpeg-*.ts` (core / extract / export / caption); ASS karaoke captions are generated in `services/ass-captions.ts`; the export runner stitches cut + reframe + caption burn (+ optional silence-removal and reframe plan) in one re-encode.

### AI client

`src/main/services/ai-client.ts` adapts the single `ClipSchema` to OpenAI / Anthropic / Ollama / OpenRouter structured-output modes behind a thin `RawTransport` seam (`(prompt) => Promise<{rawText}>`). Everything downstream is pure and unit-tested by injecting a fake transport — **no network runs in tests**. It implements the PRD §16 repair ladder (structured mode → `safeParse` → one repair round-trip → tolerant brace/fence extraction → typed `INPUT_INVALID`) then clamps in code (`end>start`, clamp to `[0,duration]`, drop overlaps, enforce min/max). Long transcripts are chunked map-reduce; results cached by `(transcriptHash, promptVersion, model, style)`.

### Renderer state

`src/renderer/src/stores/projectStore/` is one Zustand store split into **one-writer slices** (`core` + `transcriptSlice` / `clipsSlice` / `exportSlice` / `timelineSlice`) combined in `index.ts`. Thin store actions call `window.openclip` directly so backend code never imports a store. Plus `settingsStore.ts` and `uiStore.ts`.

### Security & privacy baseline (`src/main/index.ts`)

`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`; a strict CSP installed on every response (prod = no inline/eval; dev relaxes `script-src` only for Vite HMR / React Fast Refresh). API keys are stored via Electron **`safeStorage`** and the raw key **never crosses IPC** (settings expose only `hasKey`/`last4`). The source video is streamed to the preview `<video>` over a privileged `openclip-media:` scheme. Only transcript *text* ever leaves the machine.

### Data & files on disk

- `.ocproj` = a Zod-validated JSON project document under `userData/projects/`. Transcript `words` are kept **local** (drive karaoke captions); only segment-level text is sent to the LLM (token budget).
- App-**owned** source media (URL/YouTube downloads) lives at `userData/media/<projectId>/` and is deleted with the project; file-imported originals outside this dir are never touched. A launch-time sweeper reclaims orphan media dirs.
- Per-job scratch lives at `<temp>/openclip/<projectId>/<jobId>/` and is deleted in a `finally`; the extracted WAV is content-addressed cached under `<projectId>/cache/`. Final exports always go to a user-chosen folder.

## Conventions & Patterns

- **Respect the FROZEN headers.** If a file's doc comment says it's a frozen contract/seam, a change there is a deliberate contract change (update `schema.ts`/`channels.ts`/`jobs.ts` together with the drift tests), not a casual edit. Add new behavior by filling a domain handler, a job runner, or a store slice — not by editing the hub/registry/manager.
- **Import via the aliases** (`@shared/...`, `@main/...`, etc.), never deep relative paths across process boundaries.
- **Testing strategy** (PRD §18): Vitest is the bulk — mock the LLM at the `ai-client` boundary, mock `safeStorage`, assert exact ASS `\k` cue strings, repair-ladder/clamp edge cases, temp-path lifecycle. Real-binary assertions are *structural* (run the binary on a fixture, `ffprobe` the output for duration/resolution/codec — no pixel diffs) and live in the `@serial` smokes. Playwright E2E stubs the sidecar/provider.
- **Code style**: ESLint (`@electron-toolkit` configs) + Prettier; no semicolons, single quotes (see `.prettierrc.yaml`). `npm run lint` is cached.
- **Project lingo**: code comments reference the build plan's "Parts" (e.g. Part H/I/J), "Gates" (A–D), "Stages", and "Waves", and cite PRD sections (e.g. "PRD §10.2"). When in doubt about *why* something is shaped a certain way, grep the cited PRD section in `docs/prd.md`.

<!-- pine:begin recipe=claude profile=full version=0.1.0-dev hash=f0181633a844fa84 -->
Claude Code: read this before working in the repository.

## Pine issue tracking

This repository uses [Pine](https://github.com/underworld14/pine) — git-native issue tracking in `.pine/` (tickets + learnings, branch-scoped, committed with your code).

### Always do

- Track work with **Pine tickets** — do **not** use markdown TODO lists for issue tracking.
- Start with `pine context`; pick work with `pine ready`.
- Planning a non-trivial change? `pine create --type feature --title "…"` first, move it to `doing`, and when done `pine close <ID> --evidence` (marks done + attaches the file-change evidence). Run `pine inject` for a compact agent prompt-injector.
- Write progress back to `.pine/tickets/<ID>.md` (or `pine update` / `pine close`). Move tickets by editing `status` (board columns: todo, doing, testing, done).
- Capture durable insights with `pine learn "…"` into `.pine/MEMORY.md` or `.pine/memory/<topic>.md` (not a new LRN file per ticket). Use `--scope ticket` only for ephemeral ticket notes.
- Preferences that apply in **every** repo (your tools, style, habits) belong in your machine-wide memory: `pine learn -g "…"` → `~/.pine/`. Project memory wins on conflict.

### Full workflow

When you need the complete Pine workflow (commands, write-back rules, learnings lifecycle), **load the pine skill**:

- Codex / Factory / Gemini / generic agents: `.agents/skills/pine/SKILL.md`
- Claude Code: `.claude/skills/pine/SKILL.md`

If no skill file is installed, use `pine context` and `pine --help`.
<!-- pine:end -->
