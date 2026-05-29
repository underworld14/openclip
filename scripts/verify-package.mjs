#!/usr/bin/env node
/**
 * scripts/verify-package.mjs — reusable PACKAGED-BUNDLE smoke (Gate D, PRD §13).
 *
 * Asserts that the three native sidecars the PRODUCTION app resolves via
 * `process.resourcesPath` actually exist under a built `.app`'s
 * `Contents/Resources/<tool>/<platArch>/` and that EACH one RUNS:
 *   - ffmpeg     → `ffmpeg -version`     (and exposes the libass `subtitles`
 *                  filter + `h264_videotoolbox` encoder — the caption-burn +
 *                  HW-export invariants the packaged flow depends on)
 *   - ffprobe    → `ffprobe -version`
 *   - whisper-cli→ `whisper-cli -h`      (emits its usage/help banner)
 *   - yt-dlp     → `yt-dlp --version`    (URL/YouTube import, F.4)
 * Also confirms the bundled libass font (`fonts/DejaVuSans.ttf`) is present so
 * the caption burn filtergraph (`subtitles=…:fontsdir=…`) resolves a font.
 *
 * This is the bundle-level counterpart to scripts/bundle-binaries.mjs --verify
 * (which checks the staging `resources/` tree): this script checks the FINAL
 * packaged `.app` so a broken extraResources mapping / asarUnpack regression is
 * caught before shipping.
 *
 * Usage:
 *   node scripts/verify-package.mjs [path/to/OpenClip.app]
 * If no path is given it auto-discovers `dist/mac-arm64/OpenClip.app`.
 * Exits 0 on success, 1 (loud) on any failure.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')

const platArch = `${process.platform}-${process.arch}`

function log(msg) {
  console.log(`[verify-package] ${msg}`)
}
function fail(msg) {
  console.error(`[verify-package] ERROR: ${msg}`)
  process.exit(1)
}

/** Resolve the .app to verify (arg → default dist location). */
function resolveAppPath() {
  const arg = process.argv[2]
  if (arg) return resolve(arg)
  const candidates = [
    join(repoRoot, 'dist', 'mac-arm64', 'OpenClip.app'),
    join(repoRoot, 'dist', `mac-${process.arch}`, 'OpenClip.app'),
    join(repoRoot, 'dist', 'mac', 'OpenClip.app')
  ]
  for (const c of candidates) if (existsSync(c)) return c
  fail(
    `no .app found. Build one first (npm run build:mac:unsigned) or pass a path:\n` +
      `  node scripts/verify-package.mjs dist/mac-arm64/OpenClip.app`
  )
  return '' // unreachable
}

const appPath = resolveAppPath()
if (!existsSync(appPath)) fail(`.app not found: ${appPath}`)
log(`verifying packaged bundle: ${appPath}`)

const resourcesDir = join(appPath, 'Contents', 'Resources')
if (!existsSync(resourcesDir)) fail(`Contents/Resources missing: ${resourcesDir}`)

// The three sidecars at their PRODUCTION resolution location (PRD §13 layout —
// must match src/main/utils/paths.ts process.resourcesPath joins exactly).
const bins = {
  ffmpeg: join(resourcesDir, 'ffmpeg', platArch, 'ffmpeg'),
  ffprobe: join(resourcesDir, 'ffmpeg', platArch, 'ffprobe'),
  'whisper-cli': join(resourcesDir, 'whisper', platArch, 'whisper-cli'),
  'yt-dlp': join(resourcesDir, 'yt-dlp', platArch, 'yt-dlp')
}

// 1) existence
for (const [name, p] of Object.entries(bins)) {
  if (!existsSync(p)) fail(`bundled ${name} missing under Contents/Resources: ${p}`)
  const mb = (statSync(p).size / (1024 * 1024)).toFixed(1)
  log(`found ${name}: ${p} (${mb} MB)`)
}

// 2) each binary RUNS from the bundle
function runVersion(bin, args, label, mustMatch) {
  // Capture BOTH stdout and stderr — whisper-cli prints its help banner to
  // stderr (and may exit 0 or non-zero depending on the build), so checking
  // only stdout would spuriously fail. spawnSync gives us both streams + the
  // status without throwing on a non-zero exit.
  const r = spawnSync(bin, args, { encoding: 'utf8' })
  if (r.error) fail(`${label} did not run from the bundle: ${r.error.message}`)
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  if (!out.trim()) fail(`${label} ran but produced no output`)
  const first = out.split('\n').find((l) => l.trim()) ?? ''
  if (mustMatch && !mustMatch.test(out)) {
    fail(`${label} ran but produced unexpected output: ${first.slice(0, 120)}`)
  }
  log(`${label} runs from bundle → ${first.slice(0, 80)}`)
  return out
}

runVersion(bins.ffmpeg, ['-hide_banner', '-version'], 'ffmpeg -version', /ffmpeg version/i)
runVersion(bins.ffprobe, ['-hide_banner', '-version'], 'ffprobe -version', /ffprobe version/i)
runVersion(bins['whisper-cli'], ['-h'], 'whisper-cli -h', /usage:|whisper|model/i)
verifyYtDlpFromBundle(bins['yt-dlp'])

/**
 * yt-dlp from the bundle (F.4). youtube-dl-exec ships the yt-dlp PYTHON ZIPAPP
 * (`/usr/bin/env python3`), so it needs Python >= 3.10 at runtime. Verify it
 * emits a date-stamped version line (e.g. "2026.03.17"); if the default python3
 * is too old (a 3.9 traceback would otherwise sneak past a loose regex), retry
 * with an explicit modern interpreter so this smoke is not a false pass/fail.
 */
function verifyYtDlpFromBundle(bin) {
  const versionOk = (out) => /^\s*\d{4}\.\d{2}\.\d{2}\b/m.test(out)
  const direct = spawnSync(bin, ['--version'], { encoding: 'utf8' })
  if (!direct.error && direct.status === 0 && versionOk(direct.stdout ?? '')) {
    log(`yt-dlp --version runs from bundle → ${(direct.stdout ?? '').trim().split('\n')[0]}`)
    return
  }
  for (const py of ['python3.13', 'python3.12', 'python3.11', 'python3.10']) {
    const r = spawnSync(py, [bin, '--version'], { encoding: 'utf8' })
    if (!r.error && r.status === 0 && versionOk(r.stdout ?? '')) {
      log(`yt-dlp --version runs from bundle via ${py} → ${(r.stdout ?? '').trim().split('\n')[0]}`)
      return
    }
  }
  fail(
    `bundled yt-dlp did not run --version. It is a Python zipapp needing ` +
      `Python >= 3.10 on PATH (F.9). Ship a Python >= 3.10 or the standalone yt-dlp_macos binary.`
  )
}

// 3) caption-burn + HW-export invariants on the BUNDLED ffmpeg (PRD §6.4 / §6.9)
const filters = execFileSync(bins.ffmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8' })
if (!/\bsubtitles\b/.test(filters)) {
  fail(`bundled ffmpeg lacks the libass 'subtitles' filter — caption burns would fail`)
}
const encoders = execFileSync(bins.ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' })
if (!/h264_videotoolbox/.test(encoders)) {
  fail(`bundled ffmpeg lacks 'h264_videotoolbox' — HW export would fail`)
}
log(`bundled ffmpeg OK: libass 'subtitles' filter + h264_videotoolbox present`)

// 4) bundled libass font present (fontsdir for deterministic caption burns)
const font = join(resourcesDir, 'fonts', 'DejaVuSans.ttf')
if (!existsSync(font)) fail(`bundled caption font missing: ${font}`)
log(`bundled caption font OK: ${font}`)

log('packaged bundle verified ✓ (4 sidecars exist + run from Contents/Resources; font present)')
