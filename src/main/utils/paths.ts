/**
 * src/main/utils/paths.ts — binary + filesystem path resolution (TRUNK INFRA).
 *
 * FROZEN after Stage 3 (plan E.2: "Trunk-owned (consumed-by-many) infra,
 * frozen after P0"). Every fan-out track imports from here; none re-author it.
 *
 * Resolves, for both dev and prod (PRD §13):
 *   - ffmpeg / ffprobe binaries
 *       dev  → node_modules (`ffmpeg-static` / `ffmpeg-ffprobe-static`)
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

import { existsSync } from 'node:fs'
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
 * dev → ffmpeg-static (default string export); prod → bundled extraResource.
 * `OPENCLIP_FFMPEG` overrides everything (used by tests / smoke harness).
 */
export function ffmpegPath(): string {
  if (process.env.OPENCLIP_FFMPEG) return process.env.OPENCLIP_FFMPEG
  if (isDev()) {
    // ffmpeg-static's default export is the absolute path string.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const p = require('ffmpeg-static') as string | null
    if (p) return p
  }
  return join(process.resourcesPath, 'ffmpeg', platArch(), 'ffmpeg')
}

/**
 * Absolute path to the `ffprobe` binary.
 * dev → ffmpeg-ffprobe-static; prod → bundled extraResource.
 */
export function ffprobePath(): string {
  if (process.env.OPENCLIP_FFPROBE) return process.env.OPENCLIP_FFPROBE
  if (isDev()) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require('ffmpeg-ffprobe-static') as { ffprobePath?: string | null }
    if (m.ffprobePath) return m.ffprobePath
  }
  return join(process.resourcesPath, 'ffmpeg', platArch(), 'ffprobe')
}

/**
 * Absolute path to the `whisper-cli` binary.
 * dev → PATH / brew (whisper.cpp installed locally); prod → bundled extraResource.
 * `OPENCLIP_WHISPER_CLI` overrides everything (dev + smoke harness).
 */
export function whisperCliPath(): string {
  if (process.env.OPENCLIP_WHISPER_CLI) return process.env.OPENCLIP_WHISPER_CLI
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
  if (process.env.OPENCLIP_YTDLP) return process.env.OPENCLIP_YTDLP
  if (isDev()) {
    // Prefer the self-contained standalone binary staged in resources/ (the
    // `yt-dlp_macos` release — only libSystem+libz, NO Python). youtube-dl-exec's
    // managed binary is a Python zipapp needing python ≥3.10, which is unreliable
    // on hosts that ship an older python3 (e.g. macOS 3.9), so it's only a fallback.
    const bundled = join(process.cwd(), 'resources', 'yt-dlp', platArch(), 'yt-dlp')
    if (existsSync(bundled)) return bundled
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require('youtube-dl-exec') as { constants?: { YOUTUBE_DL_PATH?: string } }
    const p = m.constants?.YOUTUBE_DL_PATH
    if (p) return p
  }
  return join(process.resourcesPath, 'yt-dlp', platArch(), 'yt-dlp')
}

/**
 * Directory holding `default.metallib` (Metal kernels) next to whisper-cli.
 * Whisper-cli loads it relative to its own dir; in prod it ships beside the
 * binary, in dev brew places it in the cellar — resolved as the binary's dir.
 */
export function whisperResourcesDir(): string {
  if (isDev()) return join(process.resourcesPath ?? '', 'whisper', platArch())
  return join(process.resourcesPath, 'whisper', platArch())
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
  if (process.env.OPENCLIP_FONTS_DIR) return process.env.OPENCLIP_FONTS_DIR
  if (isDev()) return join(process.cwd(), 'build', 'fonts')
  return join(process.resourcesPath, 'fonts')
}

/**
 * The bundled caption font's ASS `Fontname` / `CaptionStyle.fontFamily` default.
 * Must match the family libass resolves from `build/fonts/DejaVuSans.ttf`.
 */
export const DEFAULT_CAPTION_FONT = 'DejaVu Sans'

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

// ============================================================================
// Temp-file lifecycle roots (PRD §17) — pure given a base temp dir
// ============================================================================

/** The OpenClip temp root: `<temp>/openclip`. Pure (base injectable for tests). */
export function openclipTempRoot(baseTemp?: string): string {
  const base = baseTemp ?? appTemp()
  return join(base, 'openclip')
}

/** Per-project temp root `<temp>/openclip/<projectId>` (PRD §17). */
export function tempRootFor(projectId: string, baseTemp?: string): string {
  return join(openclipTempRoot(baseTemp), projectId)
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
