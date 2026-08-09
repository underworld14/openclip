/**
 * tests/e2e/job-status-bar.e2e.spec.ts — the persistent job surface, in the real
 * app (EPIC-zpa1nd).
 *
 * This is the claim the whole epic rests on and the one thing unit tests cannot
 * make: that progress, stage, and Cancel are rendered by app-level chrome which
 * SURVIVES the layout swap that used to destroy them.
 *
 * The regression, verified previously in a real Electron run: for a second or
 * two the user saw a progress bar, a stage label and a Cancel button; the moment
 * whisper closed its first sentence — roughly 1% into a ten-minute transcription
 * — the Welcome screen unmounted and took all three with it, so a failure at 80%
 * was completely silent.
 */

import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

/** Launch the built app against a throwaway userData dir (the house pattern). */
async function launch(tag: string): Promise<ElectronApplication> {
  const userDataDir = mkdtempSync(join(tmpdir(), `openclip-e2e-${tag}-`))
  return electron.launch({
    args: [join(process.cwd(), 'out', 'main', 'index.js'), `--user-data-dir=${userDataDir}`],
    env: { ...process.env, NODE_ENV: 'production', OPENCLIP_FAKE_TRANSCRIBE: '1' }
  })
}

test('the status bar renders running work and survives the Welcome→editor swap', async () => {
  const app = await launch('bar')
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  try {
    // Start on Welcome: no project, so no editor.
    await expect(win.getByTestId('import-panel')).toBeVisible()

    // Register a running activity the way an import does.
    await win.evaluate(() => {
      const jobs = window.__openclipTest!.jobsStore
      jobs.getState().beginTask({
        id: 'e2e-import',
        kind: 'import',
        label: 'talk.mp4',
        stages: ['probing', 'extracting', 'transcribing'],
        cancel: async () => {
          ;(window as unknown as { __canceled?: boolean }).__canceled = true
        }
      })
      jobs.getState().updateTask('e2e-import', { pct: 40, stage: 'transcribing' })
    })

    const bar = win.getByTestId('job-status-bar')
    await expect(bar).toBeVisible()
    // A human stage, not the raw 'transcribing' token (FEAT-8559h1).
    await expect(win.getByTestId('job-status-stage')).toContainText('Transcribing talk.mp4')
    await expect(win.getByTestId('job-status-cancel')).toBeVisible()

    // Now commit a project — exactly what the import controller does at probe
    // time, and what used to unmount the only progress surface.
    await win.evaluate(() => {
      const now = Date.now()
      window.__openclipTest!.store.getState().setCurrentProject({
        id: 'p-bar',
        name: 'Status bar E2E',
        createdAt: now,
        updatedAt: now,
        sourceVideo: {
          path: '/tmp/sample.mp4',
          duration: 60,
          resolution: { width: 1920, height: 1080 },
          fps: 30,
          format: 'mp4'
        },
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
      })
    })

    // The layout swapped…
    await expect(win.getByTestId('clip-sidebar')).toBeVisible()
    await expect(win.getByTestId('import-panel')).toBeHidden()
    // …and the progress, the stage and the Cancel are all still there.
    await expect(bar).toBeVisible()
    await expect(win.getByTestId('job-status-stage')).toContainText('Transcribing talk.mp4')

    // Cancel is reachable from the editor, not just from the screen that started it.
    await win.getByTestId('job-status-cancel').click()
    expect(
      await win.evaluate(() => (window as unknown as { __canceled?: boolean }).__canceled)
    ).toBe(true)
  } finally {
    await app.close()
  }
})

test('a failure stays on screen with its message instead of vanishing', async () => {
  const app = await launch('fail')
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  try {
    await win.evaluate(() => {
      const jobs = window.__openclipTest!.jobsStore
      jobs.getState().beginTask({ id: 'e2e-fail', kind: 'import', label: 'talk.mp4' })
      jobs.getState().settleTask('e2e-fail', 'error', { error: 'whisper died at 80%' })
    })

    // The silent-failure bug, inverted into an assertion.
    await expect(win.getByTestId('job-status-bar')).toBeVisible()
    await expect(win.getByTestId('job-status-bar')).toContainText('whisper died at 80%')

    // And it does not clear itself — an error on a timer is the same bug, slower.
    await win.waitForTimeout(1500)
    await expect(win.getByTestId('job-status-bar')).toContainText('whisper died at 80%')
  } finally {
    await app.close()
  }
})
