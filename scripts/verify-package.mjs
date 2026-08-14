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
 * the caption burn filtergraph (`subtitles=…:fontsdir=…`) resolves a font, AND
 * that a font LICENSE file (`fonts/OFL.txt` / `LICENSE*`) ships beside it so the
 * fonts' redistribution terms travel with the bundle (openclip-hk7).
 *
 * AND the auto-reframe ONNX assets (Part J): asserts
 * `Contents/Resources/onnx/face_detection_yunet_2023mar.onnx` +
 * `ort-wasm-simd-threaded.wasm` exist, then a GATE-style proof that
 * onnxruntime-web can `InferenceSession.create` the BUNDLED model (with
 * `wasmPaths` = the bundled onnx dir, `numThreads=1`) and run one
 * `[1,3,640,640]` dummy inference — so a broken extraResources mapping or a
 * model/runtime mismatch is caught before shipping.
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
import {
  existsSync,
  statSync,
  lstatSync,
  openSync,
  readSync,
  closeSync,
  readFileSync,
  readdirSync
} from 'node:fs'
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
 * True iff the file begins with a NATIVE-executable magic (Mach-O / ELF / PE) and
 * is NOT a `#!`-shebang script. This is what makes the "no Python" guarantee real:
 * a yt-dlp PYTHON ZIPAPP starts with `#!/usr/bin/env python3` and would otherwise
 * run `--version` via the host's python3 (a false pass on any box with python3).
 */
function isNativeExecutable(bin) {
  const fd = openSync(bin, 'r')
  const buf = Buffer.alloc(4)
  try {
    readSync(fd, buf, 0, 4, 0)
  } finally {
    closeSync(fd)
  }
  if (buf[0] === 0x23 && buf[1] === 0x21) return false // '#!' shebang → script, reject
  const be = buf.readUInt32BE(0)
  const MACHO = [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca]
  if (MACHO.includes(be)) return true // Mach-O (thin LE/BE + fat)
  if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return true // ELF
  if (buf[0] === 0x4d && buf[1] === 0x5a) return true // 'MZ' PE
  return false
}

/**
 * yt-dlp from the bundle (F.4 / G.6). We ship the SELF-CONTAINED standalone
 * release (no Python). Assert it is a NATIVE executable (not a python zipapp —
 * otherwise a host python3 would falsely satisfy --version), then that it runs
 * `--version` directly and emits a date-stamped version (e.g. "2026.03.17").
 */
function verifyYtDlpFromBundle(bin) {
  if (!isNativeExecutable(bin)) {
    fail(
      `bundled yt-dlp is NOT a native standalone executable (looks like a #!/script ` +
        `or unknown format). It must be the standalone yt-dlp release (no Python dependency).`
    )
  }
  const versionOk = (out) => /^\s*\d{4}\.\d{2}\.\d{2}\b/m.test(out)
  const direct = spawnSync(bin, ['--version'], { encoding: 'utf8' })
  if (!direct.error && direct.status === 0 && versionOk(direct.stdout ?? '')) {
    log(
      `yt-dlp --version runs from bundle (native standalone) → ${(direct.stdout ?? '').trim().split('\n')[0]}`
    )
    return
  }
  fail(
    `bundled yt-dlp did not run a self-contained --version ` +
      `(status=${direct.status}, out=${JSON.stringify((direct.stdout ?? '').trim().slice(0, 80))}). ` +
      `It must be the standalone yt-dlp release (no Python dependency).`
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

// 3b) Supply-chain guardrail (audit fix openclip-79x, follow-up to openclip-fh2):
// NO bundled binary may report a `--enable-nonfree` build. fh2 moved ffmpeg-static/
// ffmpeg-ffprobe-static to devDependencies and hard-fails on a nonfree STAGED
// binary, but nothing scanned INSIDE app.asar — a future dependency that pulls a
// nonfree ffmpeg into node_modules would be packed into the asar and ship silently.
// ffmpeg embeds its configure flags as a readable string, so a byte scan finds it.
const NONFREE_MARKER = Buffer.from('--enable-nonfree')
const scanNonfree = (label, path) => {
  if (!existsSync(path)) return
  if (readFileSync(path).includes(NONFREE_MARKER)) {
    fail(
      `${label} reports a --enable-nonfree build (${path}). OpenClip ships LGPL ffmpeg only; ` +
        `a nonfree binary in the bundle is a redistribution/supply-chain regression.`
    )
  }
}
scanNonfree('bundled ffmpeg', bins.ffmpeg)
scanNonfree('bundled ffprobe', bins.ffprobe)
const asarPath = join(resourcesDir, 'app.asar')
/**
 * app.asar is a single packed blob, so a plain byte-scan can only say "somewhere
 * in here" — which is a genuinely bad place to leave whoever hits it (finding the
 * culprit meant extracting the archive by hand, twice, during FEAT-d8b6bj). When
 * the marker IS present, walk the archive and name the exact packed files, so the
 * failure distinguishes a real nonfree ffmpeg binary from a document that merely
 * mentions the flag.
 */
if (existsSync(asarPath) && readFileSync(asarPath).includes(NONFREE_MARKER)) {
  let culprits = []
  try {
    const asar = await import('@electron/asar')
    culprits = asar
      .listPackage(asarPath)
      .filter((entry) => {
        try {
          return asar.extractFile(asarPath, entry.replace(/^\//, '')).includes(NONFREE_MARKER)
        } catch {
          return false // directories and unreadable entries
        }
      })
      .map((entry) => {
        const buf = asar.extractFile(asarPath, entry.replace(/^\//, ''))
        // A real ffmpeg build embeds its configure line in an executable; prose
        // that discusses the flag is valid UTF-8 text. Say which one this is.
        const isText = Buffer.compare(Buffer.from(buf.toString('utf8'), 'utf8'), buf) === 0
        return `${entry}${isText ? '  (text — likely documentation, not a binary)' : '  (BINARY)'}`
      })
  } catch {
    culprits = ['(could not enumerate the archive — @electron/asar unavailable)']
  }
  fail(
    `packaged app.asar contains the --enable-nonfree marker. OpenClip ships a ` +
      `redistributable ffmpeg only; a nonfree binary in the bundle is a ` +
      `redistribution/supply-chain regression.\n  offending entries:\n    ` +
      culprits.join('\n    ') +
      `\n  If these are documentation rather than a binary, exclude them from ` +
      `app.asar in electron-builder.yml \`files\` — prose does not belong in the ` +
      `code archive.`
  )
}
const asarUnpacked = join(resourcesDir, 'app.asar.unpacked')
if (existsSync(asarUnpacked)) {
  // Native binaries are commonly asarUnpack'd; scan each file in the unpacked tree.
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      // lstat (don't follow symlinks) so a directory-symlink loop can't infinite-recurse;
      // a symlinked file is still byte-scanned (readFileSync follows the link).
      if (lstatSync(p).isDirectory()) walk(p)
      else scanNonfree(`app.asar.unpacked/${name}`, p)
    }
  }
  walk(asarUnpacked)
}
log('nonfree scan OK: no --enable-nonfree marker in ffmpeg/ffprobe, app.asar, or unpacked binaries')

// 3c) app.asar must not carry the dead onnxruntime-web payload (BUG-t1xj4d).
// onnxruntime-web ships every wasm build variant plus sourcemaps — ~95 MB that
// is never read, because the runtime points `ort.env.wasm.wasmPaths` at the
// separate <Resources>/onnx copy. Users were downloading it on every install and
// every update. This is a SIZE regression guard, so it asserts both the absence
// of those files and a ceiling on the archive, and a positive control so a
// future over-broad filter cannot quietly delete the wasm the app does use.
const ASAR_MAX_BYTES = 110 * 1024 * 1024
if (existsSync(asarPath)) {
  const asarBytes = statSync(asarPath).size
  let deadOnnx = []
  try {
    const asar = await import('@electron/asar')
    deadOnnx = asar
      .listPackage(asarPath)
      .filter((p) => /onnxruntime-web[/\\]dist[/\\].*\.(wasm|map)$/.test(p))
  } catch {
    log('note: @electron/asar unavailable — checking archive size only')
  }
  if (deadOnnx.length > 0) {
    fail(
      `app.asar carries ${deadOnnx.length} dead onnxruntime-web file(s) the app never reads ` +
        `(the runtime loads wasm from <Resources>/onnx). Check the ` +
        `'!node_modules/onnxruntime-web/dist/*' entries in electron-builder.yml \`files\`.\n  ` +
        deadOnnx.slice(0, 5).join('\n  ')
    )
  }
  if (asarBytes > ASAR_MAX_BYTES) {
    fail(
      `app.asar is ${(asarBytes / 1024 / 1024).toFixed(1)} MB, over the ` +
        `${ASAR_MAX_BYTES / 1024 / 1024} MB ceiling. Something large was added to the ` +
        `bundle — check for a dependency shipping prebuilt binaries or sourcemaps.`
    )
  }
  log(`app.asar size OK: ${(asarBytes / 1024 / 1024).toFixed(1)} MB, no dead onnxruntime payload`)
}
// Positive control: the wasm + model the app ACTUALLY loads must still be there.
// Asserted again below with the other onnx checks; named here so an over-broad
// asar filter fails with a message about the filter rather than a puzzling
// runtime error.
for (const required of ['ort-wasm-simd-threaded.wasm', 'face_detection_yunet_2023mar.onnx']) {
  const p = join(resourcesDir, 'onnx', required)
  if (!existsSync(p)) {
    fail(`the onnx asset the app actually loads is missing: ${p} (over-broad packaging filter?)`)
  }
}

// 4) bundled libass font present (fontsdir for deterministic caption burns)
const font = join(resourcesDir, 'fonts', 'DejaVuSans.ttf')
if (!existsSync(font)) fail(`bundled caption font missing: ${font}`)
log(`bundled caption font OK: ${font}`)

// 4b) the bundled fonts MUST ship their license (OFL.txt / LICENSE*) so the
// redistribution terms travel with the binaries (supply-chain guardrail —
// openclip-hk7). The shipped faces are OFL (Anton/Archivo/Bebas/Noto/Poppins);
// electron-builder must include the OFL.txt / LICENSE next to the .ttf files.
const fontsResDir = join(resourcesDir, 'fonts')
const fontLicenseNames = readdirSync(fontsResDir).filter((n) => /^OFL\.txt$|^LICENSE/i.test(n))
if (fontLicenseNames.length === 0) {
  fail(
    `no font license file (OFL.txt / LICENSE*) shipped under ${fontsResDir} — ` +
      `bundled fonts must carry their license. Check electron-builder.yml fonts extraResources filter.`
  )
}
log(`bundled font license OK: ${fontsResDir}/${fontLicenseNames.join(', ')}`)

// 4c) the bundled ffmpeg/ffprobe are GPL-3.0-or-later (--enable-gpl
// --enable-version3), so the packaged app MUST carry a verbatim copy of the GPL
// and a written offer of source — `ffmpeg -L` literally tells the user they
// should have received one. Shipping the binary without it is a redistribution
// violation, and it was the state of the app before FEAT-d8b6bj.
const ffmpegResDir = join(resourcesDir, 'ffmpeg', platArch)
for (const name of ['COPYING.GPLv3', 'README.md']) {
  const p = join(ffmpegResDir, name)
  if (!existsSync(p) || statSync(p).size === 0) {
    fail(
      `bundled ffmpeg is GPL-3.0-or-later but ${name} did not ship beside it (${p}). ` +
        `Check the resources/ffmpeg extraResources filter in electron-builder.yml and ` +
        `scripts/bundle-binaries.mjs stageFfmpegLicense().`
    )
  }
}
log(`bundled ffmpeg GPL license + written offer OK: ${ffmpegResDir}`)

// 5) auto-reframe ONNX assets (Part J): the YuNet model + the onnxruntime-web
// WASM the detector loads via `ort.env.wasm.wasmPaths`. Both ship under
// <Resources>/onnx (electron-builder extraResources → paths.ts reframeOnnxDir()).
const REFRAME_MODEL_FILE = 'face_detection_yunet_2023mar.onnx'
const onnxDir = join(resourcesDir, 'onnx')
const onnxModel = join(onnxDir, REFRAME_MODEL_FILE)
const onnxWasm = join(onnxDir, 'ort-wasm-simd-threaded.wasm')
if (!existsSync(onnxModel)) fail(`bundled YuNet model missing: ${onnxModel}`)
if (!existsSync(onnxWasm)) fail(`bundled onnxruntime-web wasm missing: ${onnxWasm}`)
log(`bundled onnx model OK: ${onnxModel} (${(statSync(onnxModel).size / 1024).toFixed(0)} KB)`)
log(`bundled onnx wasm OK: ${onnxWasm} (${(statSync(onnxWasm).size / 1024).toFixed(0)} KB)`)

// GATE proof: onnxruntime-web must `InferenceSession.create` the BUNDLED model
// (wasmPaths = the bundled onnx dir, single-threaded) and run one [1,3,640,640]
// dummy inference. Catches a model/runtime mismatch or a broken extraResources
// mapping before shipping. Uses the external-wasm entry (onnxruntime-web/wasm)
// so the runtime loads ort-wasm-simd-threaded.wasm from the bundled dir, not a CDN.
await verifyOnnxModelLoads(onnxDir, onnxModel)

log(
  'packaged bundle verified ✓ (4 sidecars exist + run from Contents/Resources; ' +
    'font present; onnx model + wasm present and load-tested)'
)

/**
 * Prove the bundled YuNet model loads + infers via onnxruntime-web with the
 * bundled WASM (Part J Gate). This proof imports the `onnxruntime-web/wasm`
 * (browser-style) entry, which has no fs loader — so HERE the model must be passed
 * as BYTES (this entry would `fetch()` a path string and fail). NOTE: the PRODUCTION
 * runtime instead uses `require('onnxruntime-web')` (the `node` entry), which DOES
 * accept the model PATH directly; the packaged-app Gate-D e2e covers that real path
 * via the `diag:reframe-probe` IPC. Both honor `ort.env.wasm.wasmPaths` (pointed at
 * the bundled onnx dir) and load the SAME ort-wasm-simd-threaded.wasm from disk.
 * numThreads=1 (no SharedArrayBuffer / cross-origin-isolation requirement).
 * Prints OK on success; fails loudly otherwise.
 */
async function verifyOnnxModelLoads(dir, modelPath) {
  let ort
  try {
    ort = await import('onnxruntime-web/wasm')
  } catch (e) {
    fail(`could not import onnxruntime-web/wasm for the model-load proof: ${e.message}`)
  }
  // wasmPaths must end with a separator so the loader appends the .wasm name.
  ort.env.wasm.wasmPaths = dir.endsWith('/') ? dir : `${dir}/`
  ort.env.wasm.numThreads = 1
  ort.env.logLevel = 'error'
  try {
    const bytes = new Uint8Array(readFileSync(modelPath))
    const session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] })
    const inputName = session.inputNames[0]
    if (inputName !== 'input') {
      fail(`bundled YuNet model has unexpected input name "${inputName}" (expected "input")`)
    }
    if (session.outputNames.length !== 12) {
      fail(
        `bundled YuNet model has ${session.outputNames.length} outputs (expected 12 — ` +
          `cls/obj/bbox/kps at strides 8/16/32). Model/runtime mismatch.`
      )
    }
    // One dummy [1,3,640,640] NCHW float32 inference — the model's FIXED input shape.
    const input = new ort.Tensor('float32', new Float32Array(1 * 3 * 640 * 640), [1, 3, 640, 640])
    const results = await session.run({ [inputName]: input })
    if (Object.keys(results).length !== 12) {
      fail(`bundled YuNet inference returned ${Object.keys(results).length} tensors (expected 12)`)
    }
    log(
      `onnx model-load proof OK: InferenceSession.create + 1×[1,3,640,640] inference (12 outputs)`
    )
  } catch (e) {
    fail(
      `bundled YuNet model failed to load/infer via onnxruntime-web (wasmPaths=${ort.env.wasm.wasmPaths}): ` +
        `${e && e.message ? e.message : e}`
    )
  }
}
