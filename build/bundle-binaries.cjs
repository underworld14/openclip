// build/bundle-binaries.cjs — electron-builder `beforePack` hook (plan E.6).
//
// Runs scripts/bundle-binaries.mjs before packaging so resources/{ffmpeg,whisper}
// are populated (and verified) from node_modules + the local whisper build. This
// keeps the large native binaries out of git while guaranteeing the dmg ships
// them. A thin wrapper because beforePack is loaded as CommonJS; the real logic
// (and Gate-A verification) lives in the ESM script.

const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

exports.default = async function bundleBinariesHook() {
  const repoRoot = join(__dirname, '..')
  const script = join(repoRoot, 'scripts', 'bundle-binaries.mjs')
  execFileSync(process.execPath, [script], { stdio: 'inherit', cwd: repoRoot })
}
