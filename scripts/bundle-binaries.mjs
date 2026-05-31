#!/usr/bin/env node
/**
 * scripts/bundle-binaries.mjs — populate `resources/` with the native sidecars
 * the PRODUCTION app resolves via `process.resourcesPath` (PRD §13, plan E.6).
 *
 * Reproducible bundling: large binaries are NOT committed; this downloads pinned
 * + SHA-256-verified FFmpeg/ffprobe and yt-dlp, and copies a locally-built
 * whisper-cli, into:
 *
 *   resources/ffmpeg/<plat-arch>/ffmpeg     ← pinned REDISTRIBUTABLE GPL build (libass + videotoolbox, NOT nonfree), SHA-256 verified (openclip-fh2 / -hk7)
 *   resources/ffmpeg/<plat-arch>/ffprobe    ← same pinned redistributable build, SHA-256 verified
 *   resources/whisper/<plat-arch>/whisper-cli ← static Metal-embedded build
 *   resources/yt-dlp/<plat-arch>/yt-dlp     ← pinned standalone yt-dlp_macos release, SHA-256 verified (F.4 / G.6 — no Python)
 *
 * It ALSO stages the auto-reframe ONNX runtime (Part J) into a SINGLE shared dir
 * (not per-arch — the wasm is portable + the model is platform-agnostic):
 *
 *   build/onnx/face_detection_yunet_2023mar.onnx  ← committed YuNet model (must exist)
 *   build/onnx/ort-wasm-simd-threaded.wasm        ← onnxruntime-web WASM (from node_modules)
 *   build/onnx/ort-wasm-simd-threaded.mjs         ← onnxruntime-web WASM loader (from node_modules)
 *
 * This makes DEV work (paths.ts reframeOnnxDir() → build/onnx, used as
 * ort.env.wasm.wasmPaths) AND stages the dir so electron-builder ships it as
 * <Resources>/onnx. The wasm/loader are NOT committed (large); we fail loudly if
 * node_modules is missing them, and assert the committed model is present.
 *
 * Gate-A invariants honored (verified here, build fails loudly otherwise):
 *   - the bundled ffmpeg MUST expose the libass `subtitles` filter and the
 *     `h264_videotoolbox` encoder (caption burns + HW export).
 *   - the bundled ffmpeg/ffprobe MUST be REDISTRIBUTABLE: the build configuration
 *     may NOT contain `--enable-nonfree` (legal guardrail — openclip-fh2).
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

/**
 * Pinned REDISTRIBUTABLE FFmpeg/ffprobe (openclip-fh2 / openclip-hk7). The
 * `ffmpeg-static` / `ffmpeg-ffprobe-static` builds report `--enable-nonfree`,
 * which is legally NON-redistributable in a public MIT dmg. We instead bundle a
 * pinned, SHA-256-verified GPL build from Martin Riedl's FFmpeg Build Server
 * (`ffmpeg.martin-riedl.de`): native macOS arm64 static, GPL (NOT nonfree),
 * keeps the libass `subtitles` filter + `h264_videotoolbox`, signed+notarized,
 * publishes a per-asset `.sha256` sidecar.
 *
 * FFMPEG_MR_BUILD is the pinned build id (`<unix-ts>_<version>`) that scopes the
 * download URL: https://ffmpeg.martin-riedl.de/download/macos/<arch>/<build>/{ffmpeg,ffprobe}.zip
 * Each zip has a `<name>.zip.sha256` sidecar (`<hex>  <name>.zip`). We ALSO pin
 * the expected hashes as consts below so a future bump is intentional (the build
 * fails loudly if the published sidecar or the download drifts from these). The
 * detail page exposes the build id at `/info/detail/macos/<arch>/<build>`.
 *
 * Override the build id (to bump) via OPENCLIP_FFMPEG_MR_BUILD; when bumping you
 * MUST also update the two FFMPEG_*_ZIP_SHA256 consts to the new sidecar values.
 */
const FFMPEG_MR_BUILD = process.env.OPENCLIP_FFMPEG_MR_BUILD || '1778761665_8.1.1'
const FFMPEG_ZIP_SHA256 = 'a05b1a47bb3ac89a95a55eec713f8bbb347051bb07015f3b7d08fb62ed81a21e'
const FFPROBE_ZIP_SHA256 = '135e70d2518beeb568183952dbc4bdeca1628dd49a7376d57e6b27dbc57d209f'

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

/** sha256 of a file, lowercase hex. */
function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** curl a URL to stdout (utf8) — used for the small SHA2-256SUMS / .sha256 manifests. */
function curlText(url, offlineHint) {
  const r = spawnSync('curl', ['-fsSL', url], { encoding: 'utf8' })
  if (r.error || r.status !== 0) {
    fail(
      `failed to fetch ${url} (curl status=${r.status}${r.error ? `, ${r.error.message}` : ''}).\n` +
        (offlineHint ??
          `For an offline/air-gapped build, set OPENCLIP_YTDLP_SRC=<path to a yt-dlp binary> ` +
            `or pre-seed build/yt-dlp-cache/<plat-arch>/.`)
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

/**
 * Resolve a pinned, REDISTRIBUTABLE FFmpeg/ffprobe binary (openclip-fh2 / -hk7).
 * Clones the `resolveYtDlp()` gold-standard: download a PINNED build's zip, look
 * up its published `.sha256` sidecar, verify the download, AND cross-check that
 * sidecar against the hash committed as a const (so a swapped sidecar can't slip
 * a new binary past review). Unzips into build/ffmpeg-cache/<build>/<tool>/ and
 * returns the staged binary path. macOS arm64 only — the GPL (NOT nonfree) build
 * keeps the libass `subtitles` filter + `h264_videotoolbox` (proven downstream by
 * verifyFfmpeg + verifyNotNonfree).
 *
 *   tool       = 'ffmpeg' | 'ffprobe'  (the zip + the binary inside share the name)
 *   expected   = the committed FFMPEG_*_ZIP_SHA256 const (must match the sidecar)
 *   srcEnv     = an env override pointing at an already-extracted binary (offline)
 */
function resolveFfmpegBuildAsset(tool, expected, srcEnv) {
  if (srcEnv && process.env[srcEnv] && existsSync(process.env[srcEnv])) {
    return process.env[srcEnv]
  }
  if (!isMac || process.arch !== 'arm64') {
    fail(
      `the pinned redistributable FFmpeg build is macOS arm64 only (got ${platArch}). ` +
        `Set ${srcEnv}=<path to a redistributable ${tool}> for other platforms.`
    )
  }
  const base = `https://ffmpeg.martin-riedl.de/download/macos/arm64/${FFMPEG_MR_BUILD}`
  const zipUrl = `${base}/${tool}.zip`
  const offlineHint =
    `For an offline/air-gapped build, set ${srcEnv}=<path to a redistributable ${tool} binary> ` +
    `or pre-seed build/ffmpeg-cache/${FFMPEG_MR_BUILD}/${tool}/.`

  // 1) Fetch the published per-asset sidecar ("<hex>  <tool>.zip") and confirm it
  //    equals the hash we pinned in code — refuse a drifted/MITM'd sidecar.
  const sidecar = curlText(`${zipUrl}.sha256`, offlineHint)
  const published = sidecar.trim().split(/\s+/)[0]?.toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(published ?? '')) {
    fail(
      `could not parse ${tool}.zip.sha256 sidecar from ${zipUrl}.sha256 (got: ${JSON.stringify(sidecar.slice(0, 80))})`
    )
  }
  if (published !== expected) {
    const constName = tool === 'ffmpeg' ? 'FFMPEG_ZIP_SHA256' : 'FFPROBE_ZIP_SHA256'
    fail(
      `${tool} ${FFMPEG_MR_BUILD} published .sha256 does NOT match the pinned const — ` +
        `the upstream build changed. Review + bump ${constName} (and OPENCLIP_FFMPEG_MR_BUILD).\n` +
        `  pinned    ${expected}\n  published ${published}`
    )
  }

  const cacheDir = join(repoRoot, 'build', 'ffmpeg-cache', FFMPEG_MR_BUILD, tool)
  const zipPath = join(cacheDir, `${tool}.zip`)
  const binPath = join(cacheDir, tool)

  // Reuse the extracted binary only if the cached zip still matches the pin.
  if (existsSync(binPath) && existsSync(zipPath) && sha256File(zipPath) === expected) {
    return binPath
  }

  mkdirSync(cacheDir, { recursive: true })
  log(`downloading pinned redistributable ${tool} ${FFMPEG_MR_BUILD} → ${zipPath}`)
  const dl = spawnSync('curl', ['-fsSL', '-o', zipPath, zipUrl], { stdio: 'inherit' })
  if (dl.error || dl.status !== 0) {
    fail(
      `failed to download ${zipUrl} (curl status=${dl.status}${dl.error ? `, ${dl.error.message}` : ''}).\n${offlineHint}`
    )
  }

  // 2) Verify the downloaded ZIP against the pinned/published hash before extracting.
  const actual = sha256File(zipPath)
  if (actual !== expected) {
    fail(
      `${tool} ${FFMPEG_MR_BUILD} SHA-256 MISMATCH — refusing to bundle a possibly-tampered binary.\n` +
        `  expected ${expected}\n  actual   ${actual}`
    )
  }
  log(`${tool} ${FFMPEG_MR_BUILD} zip checksum OK (sha256 ${expected.slice(0, 16)}…)`)

  // 3) Extract the single binary out of the zip (each zip holds just `<tool>`).
  const uz = spawnSync('unzip', ['-o', '-q', zipPath, tool, '-d', cacheDir], { stdio: 'inherit' })
  if (uz.error || uz.status !== 0) {
    fail(
      `failed to unzip ${zipPath} (unzip status=${uz.status}${uz.error ? `, ${uz.error.message}` : ''})`
    )
  }
  if (!existsSync(binPath)) fail(`unzip of ${tool}.zip did not yield expected binary: ${binPath}`)
  chmodSync(binPath, 0o755)
  return binPath
}

/** Pinned redistributable ffmpeg (replaces the nonfree ffmpeg-static). */
function resolveFfmpegRedistributable() {
  return resolveFfmpegBuildAsset('ffmpeg', FFMPEG_ZIP_SHA256, 'OPENCLIP_FFMPEG_SRC')
}

/** Pinned redistributable ffprobe (replaces the nonfree ffmpeg-ffprobe-static). */
function resolveFfprobeRedistributable() {
  return resolveFfmpegBuildAsset('ffprobe', FFPROBE_ZIP_SHA256, 'OPENCLIP_FFPROBE_SRC')
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

// ── Auto-reframe ONNX runtime (Part J) ───────────────────────────────────────

/**
 * The bundled YuNet model file name. Mirrors `REFRAME_MODEL_FILE` in
 * src/main/utils/paths.ts (this build script is plain .mjs, so it can't import
 * the TS contract — kept in lock-step here the way verify-package.mjs hardcodes
 * the sidecar names). The model itself IS committed at build/onnx/<this>.
 */
const REFRAME_MODEL_FILE = 'face_detection_yunet_2023mar.onnx'

/**
 * The onnxruntime-web WASM + loader the detector loads via `ort.env.wasm.wasmPaths`.
 * We ship the SIMD + multithreaded build (`ort-wasm-simd-threaded.*`) — detection
 * runs single-threaded (numThreads=1), but this is the only WASM the package's
 * external-wasm entry (`onnxruntime-web/wasm`) references by name. These are LARGE
 * and copied from node_modules at build time (NOT committed — see build/onnx/SOURCES.md).
 */
const ONNX_WASM_FILES = ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']

/** Resolve onnxruntime-web's dist dir (where its prebuilt .wasm/.mjs ship). */
function resolveOnnxDistDir() {
  // The package's main entry resolves inside dist/; take its directory so we find
  // the sibling ort-wasm-simd-threaded.{wasm,mjs} regardless of the entry file.
  const entry = require.resolve('onnxruntime-web')
  const dist = dirname(entry)
  if (!existsSync(dist)) fail(`onnxruntime-web dist dir not found: ${dist}`)
  return dist
}

/**
 * Stage the auto-reframe ONNX assets into build/onnx (a single shared dir):
 *   - assert the COMMITTED YuNet model is present (it backs dev + prod detection);
 *   - copy the onnxruntime-web WASM + loader out of node_modules (fail loudly if
 *     either is missing — a CDN/embedded fallback would break the offline,
 *     resources-resolved prod path).
 * Data files (not executables), so we copy without chmod +x.
 */
function bundleOnnx() {
  const onnxDir = join(repoRoot, 'build', 'onnx')
  mkdirSync(onnxDir, { recursive: true })

  const model = join(onnxDir, REFRAME_MODEL_FILE)
  if (!existsSync(model)) {
    fail(
      `committed YuNet model missing: ${model}\n` +
        `It must be checked in at build/onnx/${REFRAME_MODEL_FILE} ` +
        `(OpenCV Zoo 2023mar, MIT — see build/onnx/SOURCES.md).`
    )
  }
  log(`onnx model OK: ${model} (${(statSync(model).size / 1024).toFixed(0)} KB)`)

  const dist = resolveOnnxDistDir()
  for (const name of ONNX_WASM_FILES) {
    const src = join(dist, name)
    if (!existsSync(src)) {
      fail(
        `onnxruntime-web is missing ${name} in ${dist}.\n` +
          `Reinstall dependencies (the prebuilt WASM ships with onnxruntime-web) — ` +
          `we refuse to bundle an incomplete onnx runtime.`
      )
    }
    const dest = join(onnxDir, name)
    copyFileSync(src, dest)
    const kb = (statSync(dest).size / 1024).toFixed(0)
    log(`copied ${src} → ${dest} (${kb} KB)`)
  }
}

/** Assert build/onnx has the model + the staged onnxruntime-web WASM/loader. */
function verifyOnnx() {
  const onnxDir = join(repoRoot, 'build', 'onnx')
  for (const name of [REFRAME_MODEL_FILE, ...ONNX_WASM_FILES]) {
    const p = join(onnxDir, name)
    if (!existsSync(p)) fail(`expected onnx asset missing: ${p}`)
  }
  log(`onnx OK: model + onnxruntime-web wasm/loader staged in ${onnxDir}`)
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

/**
 * Hard-guard against shipping a NON-redistributable build (openclip-fh2). The
 * `--enable-nonfree` configure flag taints the binary so it cannot be legally
 * redistributed in a public MIT dmg. Read the build configuration straight from
 * the binary and FAIL THE BUILD if the flag is present — applies to BOTH the
 * staged ffmpeg AND ffprobe (ffprobe shares the same configure line).
 */
function verifyNotNonfree(bin, label) {
  let conf
  try {
    conf = execFileSync(bin, ['-hide_banner', '-buildconf'], { encoding: 'utf8' })
  } catch (e) {
    // Fall back to -version, whose `configuration:` line carries the same flags.
    conf = `${e.stdout ?? ''}`
    if (!/configuration:/i.test(conf)) {
      conf = execFileSync(bin, ['-hide_banner', '-version'], { encoding: 'utf8' })
    }
  }
  if (/--enable-nonfree/.test(conf)) {
    fail(
      `${label} is built with --enable-nonfree — that build is NOT redistributable in a ` +
        `public MIT dmg. Bundle a GPL/LGPL redistributable build instead (openclip-fh2).`
    )
  }
  log(`${label} OK: redistributable (no --enable-nonfree in build configuration)`)
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
  // Assert it's a NATIVE executable (Mach-O/ELF/PE), not a `#!` python zipapp —
  // otherwise a host python3 would satisfy --version (a false pass on the "no
  // Python" guarantee). Magic-byte check mirrors verify-package.mjs.
  const head = readFileSync(bin).subarray(0, 4)
  const be = head.length >= 4 ? head.readUInt32BE(0) : 0
  const MACHO = [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca]
  const isNative =
    !(head[0] === 0x23 && head[1] === 0x21) && // not '#!'
    (MACHO.includes(be) ||
      (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) || // ELF
      (head[0] === 0x4d && head[1] === 0x5a)) // 'MZ' PE
  if (!isNative) {
    fail(
      `bundled yt-dlp is NOT a native standalone executable (looks like a #!/script). ` +
        `It must be the standalone yt-dlp release (no Python).`
    )
  }
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8' })
  const out = (r.stdout ?? '').trim()
  if (r.error || r.status !== 0 || !/^\d{4}\.\d{2}\.\d{2}/.test(out)) {
    fail(
      `bundled yt-dlp did not run a self-contained --version (got: ${JSON.stringify(out)} ` +
        `status=${r.status}). It must be the standalone yt-dlp release (no Python).`
    )
  }
  log(`yt-dlp OK: native standalone, runs (--version → ${out.split('\n')[0]})`)
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
  // Keep the .exe on win32 so paths.ytDlpPath() (which appends .exe on Windows)
  // resolves the staged binary — CreateProcess won't auto-append it (G.7/G.6).
  ytdlp: join(
    repoRoot,
    'resources',
    'yt-dlp',
    platArch,
    process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
  )
}

log(`target plat-arch: ${platArch}`)

if (!verifyOnly) {
  // ffmpeg/ffprobe: pinned, SHA-256-verified, REDISTRIBUTABLE GPL build (NOT the
  // nonfree ffmpeg-static — openclip-fh2 / openclip-hk7).
  installBinary(resolveFfmpegRedistributable(), dest.ffmpeg)
  installBinary(resolveFfprobeRedistributable(), dest.ffprobe)
  installBinary(resolveWhisperCli(), dest.whisper)
  installBinary(resolveYtDlp(), dest.ytdlp)
  // Auto-reframe ONNX runtime (Part J): assert the committed YuNet model + stage
  // the onnxruntime-web WASM/loader from node_modules into build/onnx.
  bundleOnnx()
}

// Verify whatever is now bundled (works for both modes).
for (const [name, p] of Object.entries(dest)) {
  if (!existsSync(p)) fail(`expected bundled binary missing: ${name} (${p})`)
}
verifyFfmpeg(dest.ffmpeg)
// Legal guardrail (openclip-fh2): refuse to ship a --enable-nonfree build.
verifyNotNonfree(dest.ffmpeg, 'ffmpeg')
verifyNotNonfree(dest.ffprobe, 'ffprobe')
verifyPortable(dest.ffmpeg, 'ffmpeg')
verifyPortable(dest.ffprobe, 'ffprobe')
verifyPortable(dest.whisper, 'whisper-cli')
verifyWhisperRuns(dest.whisper)
// yt-dlp is a self-contained standalone executable (not a dylib-linking Mach-O
// in the relocatable sense), so we only assert it RUNS — no otool linkage check.
verifyYtDlpRuns(dest.ytdlp)
// Auto-reframe ONNX assets staged in build/onnx (model + onnxruntime-web wasm).
verifyOnnx()

log('all sidecars bundled and verified ✓')

// Allow `import`-style reuse without auto-running (e.g. from the cjs wrapper).
export { platArch }

// If invoked directly via `node scripts/bundle-binaries.mjs`, the side effects
// above have already run by the time module evaluation completes.
void pathToFileURL
