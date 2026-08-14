#!/usr/bin/env node
/**
 * scripts/capture-screenshots.mjs — capture the README screenshots from the REAL
 * built app (FEAT-d8b6bj).
 *
 * A GUI video app whose README shows nothing gives a visitor nothing to
 * evaluate, so these have to exist — and they have to be honest. Rather than
 * mock up an interface, this drives the actual production bundle over the same
 * binary-free harness the E2E suite uses (`OPENCLIP_FAKE_TRANSCRIBE=1` + the
 * fake AI transport in ipc/ai.ts): a real import pipeline, a real streamed
 * transcript, real `ai:generate-clips` output, rendered by the real components.
 * Nothing here is a mockup; the only thing faked is the sidecar/provider I/O.
 *
 * Prereqs: `npm run build` (needs out/main/index.js).
 * Usage:   node scripts/capture-screenshots.mjs
 * Output:  docs/screenshots/*.png
 */

import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(repoRoot, 'docs', 'screenshots')
const VIEWPORT = { width: 1440, height: 900 }

const log = (m) => console.log(`[screenshots] ${m}`)

mkdirSync(outDir, { recursive: true })

const userDataDir = mkdtempSync(join(tmpdir(), 'openclip-shots-'))

/**
 * A real decodable file for the preview pane. The fake import handler echoes the
 * path it is given and grants it to the `openclip-media://` scheme, so passing a
 * real file makes the `<video>` show ACTUAL decoded frames instead of a black
 * rectangle. Generated at capture time (never committed — a demo video has no
 * business in the repo), 240s to match the duration the fake handler reports.
 */
const ffmpegBin =
  process.env.OPENCLIP_FFMPEG || join(repoRoot, 'resources', 'ffmpeg', 'darwin-arm64', 'ffmpeg')
const demoVideo = join(mkdtempSync(join(tmpdir(), 'openclip-demo-')), 'sample.mp4')
if (existsSync(ffmpegBin)) {
  execFileSync(
    ffmpegBin,
    // prettier-ignore
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=15:duration=240',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      demoVideo
    ],
    { stdio: 'inherit' }
  )
  log(`generated a real 240s demo source → ${demoVideo}`)
} else {
  log(`no ffmpeg at ${ffmpegBin} — the preview pane will render empty`)
}
const app = await electron.launch({
  args: [join(repoRoot, 'out', 'main', 'index.js'), `--user-data-dir=${userDataDir}`],
  env: { ...process.env, NODE_ENV: 'production', OPENCLIP_FAKE_TRANSCRIBE: '1' }
})

const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.setViewportSize(VIEWPORT)

// ── 1) Welcome / import screen — the first thing a new user sees ──────────────
await win.waitForSelector('[data-testid="import-panel"]', { timeout: 15_000 })
await win.screenshot({ path: join(outDir, '01-welcome.png') })
log('captured 01-welcome.png')

// ── 2) Drive a real import + transcribe, then the real clip generation ────────
await win.evaluate(async (filePath) => {
  const h = window.__openclipTest
  const store = h.store
  const now = Date.now()
  await h.runImportPipeline({
    bridge: window.openclip,
    filePath,
    projectId: 'demo',
    model: 'base',
    onProbed: (sourceVideo) =>
      store.getState().setCurrentProject({
        id: 'demo',
        name: 'Podcast — Episode 12',
        createdAt: now,
        updatedAt: now,
        sourceVideo,
        transcript: { language: '', segments: [], words: [] },
        clips: [],
        settings: {
          targetPlatform: 'tiktok',
          aspectRatio: '9:16',
          clipStyle: 'all',
          maxClips: 3,
          minDuration: 5,
          maxDuration: 60
        },
        exportHistory: []
      }),
    onPartial: (partial) => store.getState().appendTranscriptPartial(partial),
    onTranscript: (t) => store.getState().hydrateTranscript(t)
  })
}, demoVideo)
await win.waitForSelector('[data-testid="transcript-segment"]', { timeout: 15_000 })

await win.evaluate(async () => {
  const store = window.__openclipTest.store
  await store.getState().generateClips({
    projectId: 'demo',
    provider: 'openai',
    model: 'gpt-4o',
    segments: store.getState().transcript.segments,
    videoTitle: 'Podcast — Episode 12',
    durationSeconds: 240,
    clipStyle: 'all',
    numClips: 5,
    targetPlatform: 'all'
  })
})
await win.waitForTimeout(500)
await win.screenshot({ path: join(outDir, '02-editor.png') })
log('captured 02-editor.png (3-pane editor: clips · preview · transcript)')

await app.close()
log(`done → ${outDir}`)
