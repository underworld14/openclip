/**
 * tests/e2e/model-gate.e2e.spec.ts — the missing-whisper-model gate opens the
 * download dialog (regression guard for the singleton wiring bug).
 *
 * WHY THIS EXISTS: making the import controller a module singleton silently
 * disconnected `onNeedModel`. The controller captured the callback of whichever
 * component constructed it first — always App, the parent — so ImportPanel's
 * callback was never seen. A first-run import with no GGML model then did
 * NOTHING: no dialog, no error, no progress. Every existing test missed it —
 * the unit specs inject `onNeedModel` directly into the framework-free core, and
 * every other E2E calls `runImportPipeline` instead of driving the UI.
 *
 * So this drives the real UI against a userData dir with no models installed.
 */

import { test, expect, _electron as electron } from '@playwright/test'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

test('importing with no whisper model installed opens the download dialog', async () => {
  // A fresh userData dir means `userData/models` is empty, so MODEL_STATUS
  // reports every model absent and the gate must fire.
  const userDataDir = mkdtempSync(join(tmpdir(), 'openclip-e2e-model-gate-'))
  const app = await electron.launch({
    args: [join(process.cwd(), 'out', 'main', 'index.js'), `--user-data-dir=${userDataDir}`],
    env: { ...process.env, NODE_ENV: 'production', OPENCLIP_FAKE_TRANSCRIBE: '1' }
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')

    // Sanity: no model is installed, so the gate genuinely has something to do.
    const installed = await win.evaluate(async () => {
      const rows = await window.openclip.model.status({})
      return rows.filter((r) => r.installed).map((r) => r.model)
    })
    expect(installed).toEqual([])

    // Drive the REAL import entry point — typing a path and pressing Import —
    // rather than the test harness, so the controller's gate is exercised.
    await win.getByTestId('import-file-input').fill('/tmp/sample.mp4')
    await win.getByTestId('import-start').click()

    await expect(win.getByTestId('model-download-dialog')).toBeVisible({ timeout: 10_000 })

    // And the dialog must be escapable — it used to have no way out at all.
    await win.keyboard.press('Escape')
    await expect(win.getByTestId('model-download-dialog')).toBeHidden({ timeout: 5_000 })
  } finally {
    await app.close()
  }
})
