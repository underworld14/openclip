/**
 * src/main/utils/paths.ts — binary + filesystem path resolution (TRUNK INFRA).
 *
 * FROZEN after Stage 3 (plan E.2: "Trunk-owned (consumed-by-many) infra,
 * frozen after P0"). Every fan-out track imports from here; none re-author it.
 *
 * Resolves, for both dev and prod (PRD §13):
 *   - ffmpeg / ffprobe binaries
 *       dev  → build/ffmpeg-cache redistributable, else `ffmpeg-static`/`ffmpeg-ffprobe-static`
 *       prod → `process.resourcesPath/ffmpeg/<platArch>/{ffmpeg,ffprobe}`
 *   - whisper-cli binary
 *       dev  → a locally-installed `whisper-cli` (brew: /opt/homebrew/bin) via
 *              the `OPENCLIP_WHISPER_CLI` override or PATH lookup
 *       prod → `process.resourcesPath/whisper/<platArch>/whisper-cli`
 *   - userData/models   (GGML weights, downloaded on demand — never bundled)
 *   - temp roots        (`app.getPath('temp')/openclip/<projectId>/<jobId>/`)
 *   - libass fontsDir   (bundled fonts so the caption burn filtergraph can
 *                        `subtitles=…:fontsdir=…` deterministically — fix M3)
 *
 * IMPORTANT — `electron` is imported lazily (inside functions) so that the pure
 * path-shape helpers (`tempRootFor`, `jobTempDir`, `cacheDirFor`, the synthetic
 * `audio.16k.wav` / scratch naming) can be unit-tested without an Electron
 * runtime. `app.getPath(...)` is only touched by the resolver functions.
 */

import { existsSync, readdirSync } from 'node:fs'
import { join, delimiter } from 'node:path'
import type { App } from 'electron'

/** Lazy, typed access to Electron's `app` (kept lazy so pure helpers stay testable). */
function electronApp(): App {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('electron') as { app: App }).app
}

// ============================================================================
// platform/arch token used to find per-arch bundled binaries (PRD §13 layout)
// ============================================================================

/** e.g. "darwin-arm64" — matches `resources/<tool>/<platArch>/` in §13. */
export function platArch(): string {
  return `${process.platform}-${process.arch}`
}

function isDev(): boolean {
  // electron-vite sets ELECTRON_RENDERER_URL in dev; is.dev also honours
  // app.isPackaged. We avoid importing `is` here to keep this module testable.
  return !!process.env.ELECTRON_RENDERER_URL || process.env.NODE_ENV === 'development'
}

/**
 * Is this a REAL packaged Electron app (the shipped .app), as opposed to dev,
 * a unit test, CI, or the `@serial` smoke harness — all of which run `paths.ts`
 * under plain Node/vitest, never inside a packaged Electron main process
 * (BUG-hqbett). `electronApp()` throws outside a real Electron runtime
 * (`require('electron')` resolves to the Electron BINARY PATH — a string — so
 * `.app` is `undefined` and `.isPackaged` throws), which is exactly the signal:
 * anywhere this throws, it is by construction not a packaged app.
 *
 * The `OPENCLIP_*` overrides below gate on this rather than `isDev()`: an
 * override must keep working in every non-packaged context (dev AND a
 * `NODE_ENV=production` test run AND the smoke harness), and must be IGNORED
 * only in the one context that matters for the vulnerability this closes — the
 * real shipped app, where "anything that can set an env var for the process
 * redirects every sidecar to an arbitrary executable" (BUG-hqbett evidence).
 */
let packagedOverrideForTests: boolean | null = null

/**
 * TEST-ONLY: force `isPackagedApp()`'s verdict. The lazy `require('electron')`
 * it checks cannot be intercepted by `vi.mock('electron')` (the same native-require
 * constraint `media-protocol.spec.ts` documents), so this mirrors that file's
 * injectable-override pattern instead of fighting the mock system. `null` restores
 * the real check (always `false` outside a genuine Electron runtime).
 */
export function __setPackagedOverrideForTests(value: boolean | null): void {
  packagedOverrideForTests = value
}

export function isPackagedApp(): boolean {
  if (packagedOverrideForTests !== null) return packagedOverrideForTests
  try {
    return electronApp().isPackaged === true
  } catch {
    return false
  }
}

/** Look an executable up on PATH (dev-only fallback for whisper-cli). */
function whichOnPath(bin: string): string | null {
  const dirs = (process.env.PATH ?? '').split(delimiter)
  for (const dir of dirs) {
    if (!dir) continue
    const candidate = join(dir, bin)
    if (existsSync(candidate)) return candidate
  }
  // brew's default arm64 prefix, in case PATH is stripped in a packaged context.
  const brew = `/opt/homebrew/bin/${bin}`
  if (existsSync(brew)) return brew
  return null
}

// ============================================================================
// Binary resolution
// ============================================================================

/**
 * Absolute path to the `ffmpeg` binary.
 * dev → the SAME pinned redistributable as prod (build/ffmpeg-cache), else the
 * version-matched ffmpeg-ffprobe-static; prod → bundled extraResource.
 * `OPENCLIP_FFMPEG` overrides everything (used by tests / smoke harness).
 */
export function ffmpegPath(): string {
  if (!isPackagedApp() && process.env.OPENCLIP_FFMPEG) return process.env.OPENCLIP_FFMPEG
  if (isDev()) return devFfmpegBinary('ffmpeg')
  return join(process.resourcesPath, 'ffmpeg', platArch(), 'ffmpeg')
}

/**
 * Absolute path to the `ffprobe` binary.
 * dev → build/ffmpeg-cache redistributable, else ffmpeg-ffprobe-static; prod → bundled.
 */
export function ffprobePath(): string {
  if (!isPackagedApp() && process.env.OPENCLIP_FFPROBE) return process.env.OPENCLIP_FFPROBE
  if (isDev()) return devFfmpegBinary('ffprobe')
  return join(process.resourcesPath, 'ffmpeg', platArch(), 'ffprobe')
}

/**
 * Resolve a dev ffmpeg/ffprobe binary (audit fixes openclip-d22/592). PREFER the pinned,
 * SHA-verified redistributable that `bundle-binaries.mjs` caches under
 * `build/ffmpeg-cache/<build>/<tool>/<tool>` — so once a dev has packaged once, dev runs
 * the EXACT same build prod ships (libass-enabled, ffmpeg+ffprobe from ONE build → no
 * version skew). When the cache isn't seeded yet, fall back to the npm packages so a
 * fresh checkout still runs: ffmpeg from `ffmpeg-static` (the only one with libass, which
 * the caption burn requires) and ffprobe from `ffmpeg-ffprobe-static`. (Fully dropping the
 * nonfree `ffmpeg-static` is gated on the cache always being seeded — see the ticket.)
 */
function devFfmpegBinary(tool: 'ffmpeg' | 'ffprobe'): string {
  const cached = devCachedFfmpeg(tool)
  if (cached) return cached
  if (tool === 'ffmpeg') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const p = require('ffmpeg-static') as string | null
    if (p) return p
  } else {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require('ffmpeg-ffprobe-static') as { ffprobePath?: string | null }
    if (m.ffprobePath) return m.ffprobePath
  }
  // Last resort: the prod layout (lets a manually-staged resources/ dir work in dev too).
  return join(process.resourcesPath ?? process.cwd(), 'ffmpeg', platArch(), tool)
}

/** First `build/ffmpeg-cache/<build>/<tool>/<tool>` that exists, or null (cache unseeded). */
function devCachedFfmpeg(tool: 'ffmpeg' | 'ffprobe'): string | null {
  try {
    const root = join(process.cwd(), 'build', 'ffmpeg-cache')
    for (const build of readdirSync(root)) {
      const bin = join(root, build, tool, tool)
      if (existsSync(bin)) return bin
    }
  } catch {
    /* no cache dir yet → caller falls back */
  }
  return null
}

/**
 * Absolute path to the `whisper-cli` binary.
 * dev → PATH / brew (whisper.cpp installed locally); prod → bundled extraResource.
 * `OPENCLIP_WHISPER_CLI` overrides everything (dev + smoke harness).
 */
export function whisperCliPath(): string {
  if (!isPackagedApp() && process.env.OPENCLIP_WHISPER_CLI) return process.env.OPENCLIP_WHISPER_CLI
  if (isDev()) {
    const found = whichOnPath('whisper-cli')
    if (found) return found
  }
  return join(process.resourcesPath, 'whisper', platArch(), 'whisper-cli')
}

/**
 * Absolute path to the `yt-dlp` binary used for URL/YouTube imports (F.4).
 * dev → PREFERS the staged self-contained standalone binary
 * (`resources/yt-dlp/<platArch>/yt-dlp` — the `yt-dlp_macos` release, no Python),
 * falling back to `youtube-dl-exec`'s managed binary only when it isn't staged;
 * prod → bundled extraResource `resources/yt-dlp/<platArch>/yt-dlp`.
 * `OPENCLIP_YTDLP` overrides everything (tests / smoke harness).
 *
 * Mirrors `whisperCliPath`: the binary is large + platform-specific, so it is
 * NOT committed; `scripts/bundle-binaries.mjs` downloads the PINNED, SHA-256
 * verified standalone release into `resources/` at package time (plan F.6 / G.6).
 */
export function ytDlpPath(): string {
  if (!isPackagedApp() && process.env.OPENCLIP_YTDLP) return process.env.OPENCLIP_YTDLP
  // The staged binary keeps its platform extension so Windows can spawn it by an
  // absolute path (CreateProcess does not auto-append .exe).
  const bin = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
  if (isDev()) {
    // Prefer the self-contained standalone binary staged in resources/ (the
    // `yt-dlp_macos` release — only libSystem+libz, NO Python). youtube-dl-exec's
    // managed binary is a Python zipapp needing python ≥3.10, which is unreliable
    // on hosts that ship an older python3 (e.g. macOS 3.9), so it's only a fallback.
    const bundled = join(process.cwd(), 'resources', 'yt-dlp', platArch(), bin)
    if (existsSync(bundled)) return bundled
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require('youtube-dl-exec') as { constants?: { YOUTUBE_DL_PATH?: string } }
    const p = m.constants?.YOUTUBE_DL_PATH
    if (p) return p
  }
  return join(process.resourcesPath, 'yt-dlp', platArch(), bin)
}

/**
 * Directory holding `default.metallib` (Metal kernels) next to whisper-cli, i.e.
 * `<resourcesPath>/whisper/<platArch>`. In PROD this ships beside the staged binary.
 * In DEV `process.resourcesPath` is Electron's OWN resources dir (the project's
 * binaries aren't staged there), so this path typically does NOT exist — and
 * `resolveWhisperCwd` (whisper-spawn) `existsSync`-guards it and falls back to
 * `process.cwd()`. A brew `whisper-cli` normally embeds its Metal shaders, so the
 * dev cwd not being the binary's directory is harmless.
 *
 * (audit fix openclip-13j: the dev/prod branches were byte-identical apart from a
 * `?? ''` guard, and the old comment falsely claimed dev "resolved the binary's dir";
 * collapsed to one expression and corrected the comment.)
 */
export function whisperResourcesDir(): string {
  return join(process.resourcesPath ?? '', 'whisper', platArch())
}

// ============================================================================
// libass fonts (fix M3 — bundled fonts so the burn filtergraph is deterministic)
// ============================================================================

/**
 * Directory passed to libass as `subtitles=…:fontsdir=<dir>` so caption burns
 * resolve a bundled font regardless of the host's installed fonts (PRD §6.4,
 * plan E.2 media smoke). dev → repo `build/fonts`; prod → `<resources>/fonts`.
 * `OPENCLIP_FONTS_DIR` overrides (smoke harness / tests).
 *
 * IMPORTANT (verified by the Stage-4 libass smoke): libass attempts to parse
 * EVERY file in this directory as a font, so it MUST contain only font files —
 * the DejaVu license lives in `build/licenses/`, not here. The bundled face is
 * `DejaVuSans.ttf` (libre, OFL-compatible Bitstream-Vera derivative — PRD §20).
 * Its ASS `Fontname` is exactly `DejaVu Sans` (the family name libass reports as
 * `fontselect: (DejaVu Sans, …) -> DejaVuSans`); `DEFAULT_CAPTION_FONT` mirrors
 * that so `CaptionStyle.fontFamily` and the burn filtergraph stay in sync.
 *
 * `electron-builder.yml` must ship `build/fonts/` as `extraResources` →
 * `<resources>/fonts/` (packaging phase, plan E.6) so the prod path resolves.
 */
export function fontsDir(): string {
  if (!isPackagedApp() && process.env.OPENCLIP_FONTS_DIR) return process.env.OPENCLIP_FONTS_DIR
  if (isDev()) return join(process.cwd(), 'build', 'fonts')
  return join(process.resourcesPath, 'fonts')
}

/**
 * The bundled caption font's ASS `Fontname` / `CaptionStyle.fontFamily` default.
 * Must match the family libass resolves from `build/fonts/DejaVuSans.ttf`.
 */
export const DEFAULT_CAPTION_FONT = 'DejaVu Sans'

// ============================================================================
// Auto-reframe ONNX assets (Part J — the YuNet face model + onnxruntime-web
// WASM, bundled so detection is local + cross-platform with NO native addon).
// ============================================================================

/** The bundled YuNet face-detection model file name (OpenCV Zoo 2023mar, MIT). */
export const REFRAME_MODEL_FILE = 'face_detection_yunet_2023mar.onnx'

/**
 * Directory holding the YuNet `.onnx` model AND the `onnxruntime-web` `.wasm`
 * (the detector sets `ort.env.wasm.wasmPaths` to this). dev → repo `build/onnx`;
 * prod → `<resources>/onnx` (shipped via `electron-builder.yml` extraResources).
 * `OPENCLIP_ONNX_DIR` overrides (tests / smoke).
 */
export function reframeOnnxDir(): string {
  if (!isPackagedApp() && process.env.OPENCLIP_ONNX_DIR) return process.env.OPENCLIP_ONNX_DIR
  if (isDev()) return join(process.cwd(), 'build', 'onnx')
  return join(process.resourcesPath, 'onnx')
}

/** Absolute path to the bundled YuNet model. */
export function reframeModelPath(): string {
  return join(reframeOnnxDir(), REFRAME_MODEL_FILE)
}

/** Directory passed to `onnxruntime-web` as `ort.env.wasm.wasmPaths` (the `.wasm` lives beside the model). */
export function reframeWasmDir(): string {
  return reframeOnnxDir()
}

// ============================================================================
// userData-rooted directories (models, projects)
// ============================================================================

/** `userData/models` — where GGML weights are downloaded (PRD §13). */
export function modelsDir(): string {
  return join(electronApp().getPath('userData'), 'models')
}

/** Absolute path to a specific GGML model file (PRD §6.2 invocation). */
export function modelFilePath(model: string): string {
  return join(modelsDir(), `ggml-${model}.bin`)
}

/** `userData/projects` — where `.ocproj` documents live (PRD §17 / plan P5). */
export function projectsDir(): string {
  return join(electronApp().getPath('userData'), 'projects')
}

/**
 * `userData/media` — PERSISTENT store for app-OWNED source videos (URL/YouTube
 * downloads), one subdir per project: `<userData>/media/<projectId>/<file>` (Part
 * H). Unlike temp, this survives OS temp cleanup; it's reclaimed on project
 * delete + a launch-time orphan sweep. File-imported originals live OUTSIDE this
 * dir and are never touched.
 */
export function mediaDir(): string {
  return join(electronApp().getPath('userData'), 'media')
}

/**
 * `userData/brands` — PERSISTENT store for the app-level brand library (Part K),
 * one subdir per brand: `<userData>/brands/<brandId>/{meta.json, logo.png}`. Logos
 * are COPIED in so a brand survives the user moving/deleting the original PNG.
 * Mirrors `mediaDir()`; the brand-store service is handed this root (Electron-free).
 */
export function brandsDir(): string {
  return join(electronApp().getPath('userData'), 'brands')
}

// ============================================================================
// Temp-file lifecycle roots (PRD §17) — pure given a base temp dir
// ============================================================================

/** The OpenClip temp root: `<temp>/openclip`. Pure (base injectable for tests). */
export function openclipTempRoot(baseTemp?: string): string {
  const base = baseTemp ?? appTemp()
  return join(base, 'openclip')
}

/**
 * A projectId is interpolated into a path as ONE segment, so it must actually be
 * one (audit fix BUG-e06a9d). These builders were a bare `join`, which happily
 * resolves `..` — `tempRootFor('../../../../victim')` produced a directory well
 * outside the temp root, and the app then created it and wrote into it.
 *
 * `media-store.ts` has guarded this since it was written, but only on the media
 * path; the temp path had no guard at all and both of its feeders (`JOB_START`
 * and `audio:extract`) passed the renderer's value straight through. Guarding
 * here — at CONSTRUCTION — covers every present and future caller, rather than
 * relying on each entry point to remember. `job-start-validation.ts` additionally
 * rejects it at the trust boundary so the renderer gets a typed INPUT_INVALID
 * instead of an internal throw.
 */
export function assertSafeProjectId(projectId: string): string {
  if (
    !projectId ||
    /[\\/]/.test(projectId) ||
    projectId === '.' ||
    projectId === '..' ||
    projectId.includes('\0')
  ) {
    throw new Error(`unsafe project id: ${JSON.stringify(projectId)}`)
  }
  return projectId
}

/** Per-project temp root `<temp>/openclip/<projectId>` (PRD §17). */
export function tempRootFor(projectId: string, baseTemp?: string): string {
  return join(openclipTempRoot(baseTemp), assertSafeProjectId(projectId))
}

/** Per-job scratch dir `<temp>/openclip/<projectId>/<jobId>` (deleted in finally). */
export function jobTempDir(projectId: string, jobId: string, baseTemp?: string): string {
  return join(tempRootFor(projectId, baseTemp), jobId)
}

/** Content-addressed WAV cache dir `<temp>/openclip/<projectId>/cache` (PRD §17). */
export function cacheDirFor(projectId: string, baseTemp?: string): string {
  return join(tempRootFor(projectId, baseTemp), 'cache')
}

/** Canonical scratch file names within a `<jobId>/` dir (PRD §17). */
export const TEMP_NAMES = {
  audioWav: 'audio.16k.wav',
  cutMp4: (clipId: string) => `clip-${clipId}.cut.mp4`,
  captionsAss: (clipId: string) => `clip-${clipId}.captions.ass`,
  thumbJpg: (clipId: string) => `thumb-${clipId}.jpg`
} as const

function appTemp(): string {
  return electronApp().getPath('temp')
}
