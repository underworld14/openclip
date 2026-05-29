#!/usr/bin/env node
/**
 * scripts/bundle-binaries.mjs — populate `resources/` with the native sidecars
 * the PRODUCTION app resolves via `process.resourcesPath` (PRD §13, plan E.6).
 *
 * Reproducible bundling: large binaries are NOT committed; this copies them from
 * `node_modules` (FFmpeg/ffprobe) and a locally-built whisper-cli into:
 *
 *   resources/ffmpeg/<plat-arch>/ffmpeg     ← ffmpeg-static (libass + videotoolbox)
 *   resources/ffmpeg/<plat-arch>/ffprobe    ← ffmpeg-ffprobe-static
 *   resources/whisper/<plat-arch>/whisper-cli ← static Metal-embedded build
 *   resources/yt-dlp/<plat-arch>/yt-dlp     ← pinned standalone yt-dlp_macos release, SHA-256 verified (F.4 / G.6 — no Python)
 *
 * Gate-A invariants honored (verified here, build fails loudly otherwise):
 *   - the bundled ffmpeg MUST expose the libass `subtitles` filter and the
 *     `h264_videotoolbox` encoder (caption burns + HW export).
 *   - the bundled whisper-cli MUST be portable: `otool -L` may reference ONLY
 *     /usr/lib and /System/* dylibs (no @rpath/brew libs), and it must run `-h`.
 *
 * The whisper-cli source can be provided via OPENCLIP_WHISPER_CLI_SRC (an
 * already-built binary). If absent, the script looks for the conventional build
 * output at build/whisper-build/bin/whisper-cli. It will NOT silently fall back
 * to a brew binary (those link brew dylibs and are not relocatable).
 *
 * Usage:
 *   node scripts/bundle-binaries.mjs           # bundle for the current plat-arch
 *   node scripts/bundle-binaries.mjs --verify  # verify already-bundled binaries
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, copyFileSync, chmodSync, statSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')
const require = createRequire(import.meta.url)

/**
 * Pinned yt-dlp release (G.6): a SPECIFIC tag (not "latest") so the bundle is
 * reproducible, and we verify the download's SHA-256 against the release's
 * SHA2-256SUMS so a swapped/MITM'd asset can't be silently bundled + signed.
 * Override with OPENCLIP_YTDLP_VERSION to bump (then update the build cache).
 */
const YTDLP_VERSION = process.env.OPENCLIP_YTDLP_VERSION || '2026.03.17'

const platArch = `${process.platform}-${process.arch}`
const isMac = process.platform === 'darwin'

function log(msg) {
  console.log(`[bundle-binaries] ${msg}`)
}
function fail(msg) {
  console.error(`[bundle-binaries] ERROR: ${msg}`)
  process.exit(1)
}

/** Copy `src` → `dest`, creating parents, marking executable. Idempotent. */
function installBinary(src, dest) {
  if (!existsSync(src)) fail(`source binary not found: ${src}`)
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(src, dest)
  chmodSync(dest, 0o755)
  const sz = (statSync(dest).size / (1024 * 1024)).toFixed(1)
  log(`copied ${src} → ${dest} (${sz} MB)`)
}

/** Resolve the ffmpeg-static binary path (its default export is the path). */
function resolveFfmpegStatic() {
  const p = require('ffmpeg-static')
  if (!p || typeof p !== 'string') fail('ffmpeg-static did not resolve a binary path')
  return p
}

/** Resolve ffprobe from ffmpeg-ffprobe-static. */
function resolveFfprobeStatic() {
  const m = require('ffmpeg-ffprobe-static')
  if (!m.ffprobePath) fail('ffmpeg-ffprobe-static did not resolve ffprobePath')
  return m.ffprobePath
}

/** sha256 of a file, lowercase hex. */
function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** curl a URL to stdout (utf8) — used for the small SHA2-256SUMS manifest. */
function curlText(url) {
  const r = spawnSync('curl', ['-fsSL', url], { encoding: 'utf8' })
  if (r.error || r.status !== 0) {
    fail(
      `failed to fetch ${url} (curl status=${r.status}${r.error ? `, ${r.error.message}` : ''}).\n` +
        `For an offline/air-gapped build, set OPENCLIP_YTDLP_SRC=<path to a yt-dlp binary> ` +
        `or pre-seed build/yt-dlp-cache/<plat-arch>/.`
    )
  }
  return r.stdout
}

/**
 * Resolve the SELF-CONTAINED standalone yt-dlp binary (F.4 / F.9). We ship the
 * `yt-dlp_macos` release (a PyInstaller universal2 executable — only libSystem +
 * libz, NO Python dependency) rather than youtube-dl-exec's Python zipapp, which
 * needs python ≥3.10 on the host and fails on macOS's default python3.
 *
 * G.6: PINNED to YTDLP_VERSION (reproducible) and SHA-256 VERIFIED against the
 * release's SHA2-256SUMS before staging (tamper-evident — a swapped/MITM'd asset
 * fails the build instead of being silently signed). Cached per plat-arch.
 */
function resolveYtDlp() {
  if (process.env.OPENCLIP_YTDLP_SRC && existsSync(process.env.OPENCLIP_YTDLP_SRC)) {
    return process.env.OPENCLIP_YTDLP_SRC
  }
  const asset =
    process.platform === 'darwin'
      ? 'yt-dlp_macos'
      : process.platform === 'win32'
        ? 'yt-dlp.exe'
        : 'yt-dlp'
  const outName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
  const cacheDir = join(repoRoot, 'build', 'yt-dlp-cache', platArch)
  const cached = join(cacheDir, outName)
  const base = `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}`

  // Look up the pinned release's expected sha256 for our asset.
  const sums = curlText(`${base}/SHA2-256SUMS`)
  const row = sums.split(/\r?\n/).find((l) => l.trim().endsWith(`  ${asset}`))
  if (!row) fail(`SHA2-256SUMS for yt-dlp ${YTDLP_VERSION} has no entry for ${asset}`)
  const expected = row.trim().split(/\s+/)[0].toLowerCase()

  // Reuse the cache only if it still matches the pinned checksum.
  if (existsSync(cached) && sha256File(cached) === expected) return cached

  mkdirSync(cacheDir, { recursive: true })
  const url = `${base}/${asset}`
  log(`downloading pinned yt-dlp ${YTDLP_VERSION} (${asset}) → ${cached}`)
  const dl = spawnSync('curl', ['-fsSL', '-o', cached, url], { stdio: 'inherit' })
  if (dl.error || dl.status !== 0) {
    fail(
      `failed to download ${url} (curl status=${dl.status}${dl.error ? `, ${dl.error.message}` : ''}).\n` +
        `For an offline/air-gapped build, set OPENCLIP_YTDLP_SRC=<path to a yt-dlp binary> ` +
        `or pre-seed ${cached}.`
    )
  }
  const actual = sha256File(cached)
  if (actual !== expected) {
    fail(
      `yt-dlp ${YTDLP_VERSION} ${asset} SHA-256 MISMATCH — refusing to bundle a possibly-tampered binary.\n` +
        `  expected ${expected}\n  actual   ${actual}`
    )
  }
  chmodSync(cached, 0o755)
  log(`yt-dlp ${YTDLP_VERSION} checksum OK (sha256 ${expected.slice(0, 16)}…)`)
  return cached
}

/** Find the locally-built (static, Metal-embedded) whisper-cli. NEVER brew. */
function resolveWhisperCli() {
  const fromEnv = process.env.OPENCLIP_WHISPER_CLI_SRC
  const candidates = [
    fromEnv,
    join(repoRoot, 'build', 'whisper-build', 'bin', 'whisper-cli')
  ].filter(Boolean)
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  fail(
    'static whisper-cli not found. Build it first:\n' +
      '  git clone --branch v1.8.4 https://github.com/ggml-org/whisper.cpp.git\n' +
      '  cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \\\n' +
      '        -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DWHISPER_BUILD_EXAMPLES=ON\n' +
      '  cmake --build build --config Release\n' +
      'then set OPENCLIP_WHISPER_CLI_SRC=<.../build/bin/whisper-cli> or place it at\n' +
      '  build/whisper-build/bin/whisper-cli'
  )
}

// ── Verification helpers ────────────────────────────────────────────────────

function verifyFfmpeg(ffmpegBin) {
  const filters = execFileSync(ffmpegBin, ['-hide_banner', '-filters'], { encoding: 'utf8' })
  if (!/\bsubtitles\b/.test(filters)) {
    fail(`bundled ffmpeg lacks the libass 'subtitles' filter — caption burns would fail`)
  }
  const encoders = execFileSync(ffmpegBin, ['-hide_banner', '-encoders'], { encoding: 'utf8' })
  if (!/h264_videotoolbox/.test(encoders)) {
    fail(`bundled ffmpeg lacks 'h264_videotoolbox' — HW export would fail`)
  }
  log(`ffmpeg OK: has libass 'subtitles' filter + h264_videotoolbox`)
}

/** A portable binary may only link /usr/lib and /System/* dylibs. */
function verifyPortable(bin, label) {
  if (!isMac) {
    log(`${label}: skipping otool linkage check (not macOS)`)
    return
  }
  const out = execFileSync('otool', ['-L', bin], { encoding: 'utf8' })
  const lines = out.split('\n').slice(1) // first line is the binary path
  const offenders = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const lib = line.split(/\s+\(/)[0].trim()
    if (!lib) continue
    const portable = lib.startsWith('/usr/lib/') || lib.startsWith('/System/')
    if (!portable) offenders.push(lib)
  }
  if (offenders.length) {
    fail(
      `${label} is NOT portable — links non-system dylibs:\n  ${offenders.join('\n  ')}\n` +
        `(rebuild fully static, or relocate dylibs + fix @rpath)`
    )
  }
  log(`${label} OK: portable (only /usr/lib + /System/* dylibs)`)
}

/**
 * Run `yt-dlp --version`. The bundled binary is the SELF-CONTAINED standalone
 * release (no Python), so it must run directly with a date-stamped version
 * (e.g. "2026.03.17") — a Python traceback or empty output is a hard failure.
 */
function verifyYtDlpRuns(bin) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8' })
  const out = (r.stdout ?? '').trim()
  if (r.error || r.status !== 0 || !/^\d{4}\.\d{2}\.\d{2}/.test(out)) {
    fail(
      `bundled yt-dlp did not run a self-contained --version (got: ${JSON.stringify(out)} ` +
        `status=${r.status}). It must be the standalone yt-dlp release (no Python).`
    )
  }
  log(`yt-dlp OK: self-contained, runs (--version → ${out.split('\n')[0]})`)
}

function verifyWhisperRuns(bin) {
  // whisper-cli prints usage to stdout/stderr and exits non-zero for -h on some
  // builds; we only care that it executes and emits its help banner.
  try {
    const out = execFileSync(bin, ['-h'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    if (!/usage:|whisper/i.test(out)) {
      log(`whisper-cli -h produced unexpected output (continuing): ${out.slice(0, 120)}`)
    }
  } catch (e) {
    const combined = `${e.stdout ?? ''}${e.stderr ?? ''}`
    if (!/usage:|whisper|model/i.test(combined)) {
      fail(`bundled whisper-cli did not run -h: ${e.message}`)
    }
  }
  log(`whisper-cli OK: runs and prints help`)
}

// ── Main ─────────────────────────────────────────────────────────────────────

const verifyOnly = process.argv.includes('--verify')

const dest = {
  ffmpeg: join(repoRoot, 'resources', 'ffmpeg', platArch, 'ffmpeg'),
  ffprobe: join(repoRoot, 'resources', 'ffmpeg', platArch, 'ffprobe'),
  whisper: join(repoRoot, 'resources', 'whisper', platArch, 'whisper-cli'),
  ytdlp: join(repoRoot, 'resources', 'yt-dlp', platArch, 'yt-dlp')
}

log(`target plat-arch: ${platArch}`)

if (!verifyOnly) {
  installBinary(resolveFfmpegStatic(), dest.ffmpeg)
  installBinary(resolveFfprobeStatic(), dest.ffprobe)
  installBinary(resolveWhisperCli(), dest.whisper)
  installBinary(resolveYtDlp(), dest.ytdlp)
}

// Verify whatever is now bundled (works for both modes).
for (const [name, p] of Object.entries(dest)) {
  if (!existsSync(p)) fail(`expected bundled binary missing: ${name} (${p})`)
}
verifyFfmpeg(dest.ffmpeg)
verifyPortable(dest.ffmpeg, 'ffmpeg')
verifyPortable(dest.ffprobe, 'ffprobe')
verifyPortable(dest.whisper, 'whisper-cli')
verifyWhisperRuns(dest.whisper)
// yt-dlp is a self-contained standalone executable (not a dylib-linking Mach-O
// in the relocatable sense), so we only assert it RUNS — no otool linkage check.
verifyYtDlpRuns(dest.ytdlp)

log('all sidecars bundled and verified ✓')

// Allow `import`-style reuse without auto-running (e.g. from the cjs wrapper).
export { platArch }

// If invoked directly via `node scripts/bundle-binaries.mjs`, the side effects
// above have already run by the time module evaluation completes.
void pathToFileURL
