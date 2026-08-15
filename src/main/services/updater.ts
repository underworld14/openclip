/**
 * src/main/services/updater.ts — a thin wrapper around `electron-updater`
 * (EPIC-k83ghw / FEAT-x9femg).
 *
 * CHECK_UPDATE was an honest stub that always reported no update — nothing
 * ever actually read the `latest-mac.yml`/`app-update.yml` electron-builder
 * already generates at package time. This wires the real thing:
 * `autoUpdater.checkForUpdates()` reads that SAME feed and compares it
 * against the running app's version.
 *
 * `autoDownload` is deliberately OFF: this app's whole pitch is local-first
 * and BYOK — nothing happens without the user asking. CHECK_UPDATE only
 * reports availability; downloading is a separate, explicit action (today,
 * the update dialog just opens the releases page in the browser).
 */

import { app } from 'electron'
import { autoUpdater } from 'electron-updater'

export interface UpdateStatus {
  updateAvailable: boolean
  version?: string
}

let latest: UpdateStatus = { updateAvailable: false }
let wired = false

function wire(): void {
  if (wired) return
  wired = true
  autoUpdater.autoDownload = false
  autoUpdater.on('update-available', (info) => {
    latest = { updateAvailable: true, version: info.version }
  })
  autoUpdater.on('update-not-available', () => {
    latest = { updateAvailable: false }
  })
  autoUpdater.on('error', (err) => {
    console.error('[updater]', err instanceof Error ? err.message : err)
  })
}

/**
 * Check the update feed. A no-op outside a packaged build — there is no
 * `app-update.yml` to read in dev, and electron-updater's own error there is
 * noise, not signal — and never throws: a failed check (offline, no feed
 * configured yet) reports "no update" rather than surfacing a raw network
 * error to the user for a background convenience check.
 */
export async function checkForUpdate(): Promise<UpdateStatus> {
  if (!app.isPackaged) return { updateAvailable: false }
  wire()
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    console.error('[updater] check failed:', err instanceof Error ? err.message : err)
  }
  return latest
}
