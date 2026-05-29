/**
 * tests/unit/paths-prod.spec.ts — PRODUCTION binary path resolution (P7 / PRD §13).
 *
 * Asserts that the prod branch of src/main/utils/paths.ts resolves the bundled
 * sidecars under `process.resourcesPath/{ffmpeg,whisper,fonts}` EXACTLY as the
 * electron-builder.yml `extraResources` mapping ships them:
 *
 *   resources/ffmpeg  → <Resources>/ffmpeg   ⇒ ffmpeg/<plat-arch>/{ffmpeg,ffprobe}
 *   resources/whisper → <Resources>/whisper  ⇒ whisper/<plat-arch>/whisper-cli
 *   build/fonts       → <Resources>/fonts    ⇒ fonts/DejaVuSans.ttf
 *
 * The prod branch is selected by: NOT dev (no ELECTRON_RENDERER_URL, NODE_ENV
 * != development) and the OPENCLIP_* overrides cleared. We set a fake
 * `process.resourcesPath` and re-import the module fresh per case so the env is
 * honored deterministically.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import type * as PathsModule from '@main/utils/paths'

const RESOURCES = '/Applications/OpenClip.app/Contents/Resources'

// Env keys the prod branch is sensitive to (overrides + dev detection).
const SENSITIVE = [
  'OPENCLIP_FFMPEG',
  'OPENCLIP_FFPROBE',
  'OPENCLIP_WHISPER_CLI',
  'OPENCLIP_FONTS_DIR',
  'ELECTRON_RENDERER_URL',
  'NODE_ENV'
] as const

// `process.env` is typed with some read-only augmented keys (electron-vite adds
// ELECTRON_RENDERER_URL); treat it as a plain mutable record for save/restore.
const env = process.env as unknown as Record<string, string | undefined>

let saved: Record<string, string | undefined>
let savedResourcesPath: string | undefined

beforeEach(() => {
  saved = {}
  for (const k of SENSITIVE) {
    saved[k] = env[k]
    delete env[k]
  }
  // Force the prod (packaged) branch: not dev, with a known resourcesPath.
  env.NODE_ENV = 'production'
  savedResourcesPath = (process as { resourcesPath?: string }).resourcesPath
  ;(process as { resourcesPath?: string }).resourcesPath = RESOURCES
  vi.resetModules()
})

afterEach(() => {
  for (const k of SENSITIVE) {
    if (saved[k] === undefined) delete env[k]
    else env[k] = saved[k]
  }
  ;(process as { resourcesPath?: string }).resourcesPath = savedResourcesPath
  vi.resetModules()
})

async function loadPaths(): Promise<typeof PathsModule> {
  return await import('@main/utils/paths')
}

describe('paths.ts prod branch ↔ electron-builder extraResources (PRD §13)', () => {
  it('ffmpeg resolves under <Resources>/ffmpeg/<plat-arch>/ffmpeg', async () => {
    const { ffmpegPath, platArch } = await loadPaths()
    expect(ffmpegPath()).toBe(join(RESOURCES, 'ffmpeg', platArch(), 'ffmpeg'))
  })

  it('ffprobe resolves under <Resources>/ffmpeg/<plat-arch>/ffprobe', async () => {
    const { ffprobePath, platArch } = await loadPaths()
    expect(ffprobePath()).toBe(join(RESOURCES, 'ffmpeg', platArch(), 'ffprobe'))
  })

  it('whisper-cli resolves under <Resources>/whisper/<plat-arch>/whisper-cli', async () => {
    const { whisperCliPath, platArch } = await loadPaths()
    expect(whisperCliPath()).toBe(join(RESOURCES, 'whisper', platArch(), 'whisper-cli'))
  })

  it('whisper resources dir (embedded metallib lives beside the binary)', async () => {
    const { whisperResourcesDir, platArch } = await loadPaths()
    expect(whisperResourcesDir()).toBe(join(RESOURCES, 'whisper', platArch()))
  })

  it('fonts dir resolves under <Resources>/fonts (libass fontsdir)', async () => {
    const { fontsDir } = await loadPaths()
    expect(fontsDir()).toBe(join(RESOURCES, 'fonts'))
  })

  it('the three prod roots match the extraResources "to" targets', async () => {
    const { ffmpegPath, ffprobePath, whisperCliPath, fontsDir } = await loadPaths()
    // extraResources: resources/ffmpeg→ffmpeg, resources/whisper→whisper, build/fonts→fonts
    expect(ffmpegPath().startsWith(join(RESOURCES, 'ffmpeg') + '/')).toBe(true)
    expect(ffprobePath().startsWith(join(RESOURCES, 'ffmpeg') + '/')).toBe(true)
    expect(whisperCliPath().startsWith(join(RESOURCES, 'whisper') + '/')).toBe(true)
    expect(fontsDir()).toBe(join(RESOURCES, 'fonts'))
  })

  it('OPENCLIP_* overrides still win over the prod branch (smoke/test escape hatch)', async () => {
    env.OPENCLIP_FFMPEG = '/override/ffmpeg'
    env.OPENCLIP_WHISPER_CLI = '/override/whisper-cli'
    env.OPENCLIP_FONTS_DIR = '/override/fonts'
    vi.resetModules()
    const { ffmpegPath, whisperCliPath, fontsDir } = await loadPaths()
    expect(ffmpegPath()).toBe('/override/ffmpeg')
    expect(whisperCliPath()).toBe('/override/whisper-cli')
    expect(fontsDir()).toBe('/override/fonts')
  })
})
