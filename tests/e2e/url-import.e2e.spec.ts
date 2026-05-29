/**
 * tests/e2e/url-import.e2e.spec.ts — REAL-NETWORK end-to-end proof of the unified
 * YouTube/URL import (F.4): the production `url-download` job runs the bundled
 * standalone yt-dlp against a real URL, streams progress over the transferred
 * MessagePort, and produces a local mp4 that probes to a valid SourceVideo —
 * driving the exact renderer path the Welcome screen / ImportPanel use.
 *
 * Gated behind RUN_NETWORK_E2E (mirrors the model-presence skips) because it hits
 * YouTube (network + anti-bot/geo can make it flaky). OPENCLIP_YTDLP points the
 * app at the self-contained binary (the packaged build is unsigned here).
 */

import { test, expect, _electron as electron } from '@playwright/test'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const FFMPEG = require('ffmpeg-static') as string
// eslint-disable-next-line @typescript-eslint/no-require-imports
const FFPROBE = (require('ffmpeg-ffprobe-static') as { ffprobePath: string }).ffprobePath

const URL = 'https://youtu.be/M5XbNdzPuDQ'
const YTDLP = join(
  process.cwd(),
  'resources',
  'yt-dlp',
  `${process.platform}-${process.arch}`,
  'yt-dlp'
)

test.skip(!process.env.RUN_NETWORK_E2E, 'network E2E (set RUN_NETWORK_E2E=1 to run)')
test.skip(!existsSync(YTDLP), `standalone yt-dlp not staged at ${YTDLP}`)

test('URL import: real yt-dlp download → probe a valid SourceVideo', async () => {
  test.setTimeout(180_000) // a real download can take a while
  const app = await electron.launch({
    args: [join(process.cwd(), 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      OPENCLIP_YTDLP: YTDLP,
      OPENCLIP_FFMPEG: FFMPEG,
      OPENCLIP_FFPROBE: FFPROBE
    }
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  try {
    const result = await win.evaluate(async (url) => {
      const h = window.__openclipTest!
      const progress: number[] = []
      // Real url-download job over the transferred MessagePort (production path).
      const dl = await h.runUrlDownload({
        bridge: window.openclip,
        url,
        onProgress: (pct) => progress.push(pct)
      })
      // Feed the downloaded file into the real probe (import) step.
      const { sourceVideo } = await window.openclip.video.import({ filePath: dl.filePath })

      // PLAYBACK CHECK (G.1/G.4): the downloaded mp4 must actually PLAY in a
      // Chromium <video> over the privileged openclip-media:// scheme — this is
      // what ffprobe alone never proved. Catches codec (VP9/AV1) + faststart
      // regressions. We wait for `canplay` (codec decodable) + a finite duration.
      const mediaUrl =
        'openclip-media://file' + dl.filePath.split('/').map(encodeURIComponent).join('/')
      const v = document.createElement('video')
      v.muted = true
      v.src = mediaUrl
      document.body.appendChild(v)
      const canPlay = await new Promise<boolean>((resolve) => {
        let settled = false
        const done = (ok: boolean): void => {
          if (!settled) {
            settled = true
            resolve(ok)
          }
        }
        v.addEventListener('canplay', () => done(true), { once: true })
        v.addEventListener('error', () => done(false), { once: true })
        setTimeout(() => done(false), 20_000)
      })
      let played = false
      if (canPlay) {
        try {
          await v.play()
          await new Promise((r) => setTimeout(r, 400))
          played = v.currentTime > 0
          v.pause()
        } catch {
          played = false
        }
      }

      return {
        filePath: dl.filePath,
        bytes: dl.bytes,
        title: dl.title,
        sawProgress: progress.some((p) => p > 0),
        duration: sourceVideo.duration,
        width: sourceVideo.resolution.width,
        height: sourceVideo.resolution.height,
        canPlay,
        videoDuration: v.duration,
        played
      }
    }, URL)

    expect(result.filePath).toMatch(/\.mp4$/)
    expect(result.bytes).toBeGreaterThan(1_000_000)
    expect(result.sawProgress).toBe(true)
    // title is now populated from yt-dlp metadata (G.2).
    expect(result.title && result.title.length).toBeGreaterThan(0)
    expect(result.duration).toBeGreaterThan(60)
    expect(result.width).toBeGreaterThan(0)
    expect(result.height).toBeGreaterThan(0)
    // The downloaded mp4 plays in <video>: H.264/AAC + faststart (G.1).
    expect(result.canPlay).toBe(true)
    expect(result.videoDuration).toBeGreaterThan(60)
    expect(result.played).toBe(true)
  } finally {
    await app.close()
  }
})
