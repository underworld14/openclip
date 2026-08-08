/**
 * generate-clips-button.e2e.spec.ts — the "Auto Generate Clips" HEADER BUTTON is actually
 * WIRED (audit fix openclip-0i3).
 *
 * The pure click-handler core (createGenerateClipsHandler) and the disabled-state are
 * unit-tested, and the binding is typecheck-guaranteed — but nothing asserted the LITERAL
 * JSX onClick, i.e. the exact class of bug the P0 fix addressed (a button with no onClick).
 * This drives the real app: import → transcribe (so the button enables) → CLICK the button
 * (not the store action) → assert clip cards render, proving onClick → handler →
 * generateClips fires end to end. The AI provider is the deterministic fake transport
 * (OPENCLIP_FAKE_TRANSCRIBE), so no key/network is needed.
 */

import { test, expect, _electron as electron } from '@playwright/test'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

test('the Auto Generate Clips header button is wired: click → clips render (openclip-0i3)', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'openclip-e2e-0i3-'))
  const app = await electron.launch({
    args: [join(process.cwd(), 'out', 'main', 'index.js'), `--user-data-dir=${userDataDir}`],
    env: { ...process.env, NODE_ENV: 'production', OPENCLIP_FAKE_TRANSCRIBE: '1' }
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')

    // Satisfy the first-run readiness gate the way a user does (FEAT-c5a15c):
    // the header button is disabled until a provider key and a model id exist.
    // Transcription readiness comes from the fake-transcribe mode itself.
    await win.evaluate(async () => {
      // Drive the STORE actions, not the raw bridge: the store is what keeps
      // `keyStatus` in sync, and that is what the readiness chips read.
      const s = window.__openclipTest!.settingsStore.getState()
      await s.save({ aiProvider: 'openai', model: 'gpt-5' })
      await s.setApiKey('openai', 'sk-e2e-test')
    })

    // Import + transcribe through the real pipeline (fake transcribe) so the open project
    // has a transcript and the header button becomes enabled.
    await win.evaluate(async () => {
      const h = window.__openclipTest!
      const store = h.store
      const result = await h.runImportPipeline({
        bridge: window.openclip,
        filePath: '/tmp/sample.mp4',
        projectId: 'p1',
        model: 'base',
        onPartial: (partial) => store.getState().appendTranscriptPartial(partial),
        onTranscript: (t) => store.getState().hydrateTranscript(t)
      })
      // The pipeline alone does NOT make a project current — in the app that is the
      // import controller's `hydrateProject` step. Without it `composeProject()`
      // returns null, the handler bails, and this spec asserted nothing while
      // looking green-able (audit fix BUG-19bt2k). Commit the project like the
      // controller does.
      const now = Date.now()
      store.getState().setCurrentProject({
        id: 'p1',
        name: 'Generate Clips E2E',
        createdAt: now,
        updatedAt: now,
        sourceVideo: {
          path: '/tmp/sample.mp4',
          duration: 60,
          resolution: { width: 1920, height: 1080 },
          fps: 30,
          format: 'mp4'
        },
        transcript: result.transcript,
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
      })
      return result.transcript.segments.length
    })
    await expect(win.getByTestId('transcript-panel')).toBeVisible()

    // The button must be present + enabled (hasTranscript) — and clicking it must fire the
    // generate flow. A "button with no onClick" regression would leave the sidebar empty.
    const button = win.getByTestId('auto-generate-clips')
    await expect(button).toBeEnabled()
    await button.click()

    await expect(win.getByTestId('clip-card').first()).toBeVisible({ timeout: 15000 })
    const clipCount = await win.evaluate(() => window.__openclipTest!.store.getState().clips.length)
    expect(clipCount).toBeGreaterThan(0)
  } finally {
    await app.close()
  }
})
