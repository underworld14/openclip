/**
 * tests/unit/updater.spec.ts — the electron-updater wrapper behind
 * CHECK_UPDATE (EPIC-k83ghw / FEAT-x9femg).
 *
 * CHECK_UPDATE used to be an honest stub that always reported no update.
 * What matters here: it stays a no-op (and never calls the real feed)
 * outside a packaged build, it reflects electron-updater's own
 * available/not-available events, it never throws on a feed failure, and it
 * never enables background downloading.
 *
 * NOTE: `checkForUpdate`'s module-level `wired`/`latest` state is
 * process-global by design (there is only ever one main process) and so is
 * shared across the `it()`s below, mirroring the same pattern already used
 * for the job-runner registry in sidecar-manager.spec.ts.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'

// `vi.mock` factories are hoisted above ordinary top-level declarations, so
// anything they reference must go through `vi.hoisted` (Vitest's documented
// pattern) rather than a plain `const`.
const { handlers, checkForUpdatesMock, autoUpdaterMock, packagedRef } = vi.hoisted(() => {
  type Handler = (arg?: unknown) => void
  const handlers: Record<string, Handler> = {}
  const checkForUpdatesMock = vi.fn(async () => undefined)
  const autoUpdaterMock = {
    autoDownload: true,
    on: (event: string, cb: Handler) => {
      handlers[event] = cb
    },
    checkForUpdates: checkForUpdatesMock
  }
  return { handlers, checkForUpdatesMock, autoUpdaterMock, packagedRef: { packaged: true } }
})

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return packagedRef.packaged
    },
    getVersion: () => '2.0.0'
  }
}))
vi.mock('electron-updater', () => ({ autoUpdater: autoUpdaterMock }))

import { checkForUpdate } from '@main/services/updater'

beforeEach(() => {
  packagedRef.packaged = true
  checkForUpdatesMock.mockReset()
  checkForUpdatesMock.mockResolvedValue(undefined)
})

describe('checkForUpdate', () => {
  it('reports no update outside a packaged build, without touching the feed', async () => {
    packagedRef.packaged = false
    const status = await checkForUpdate()
    expect(status).toEqual({ updateAvailable: false })
    expect(checkForUpdatesMock).not.toHaveBeenCalled()
  })

  it('turns autoDownload off — nothing downloads without the user asking', async () => {
    autoUpdaterMock.autoDownload = true
    await checkForUpdate()
    expect(autoUpdaterMock.autoDownload).toBe(false)
  })

  it('reports an update once autoUpdater emits update-available', async () => {
    checkForUpdatesMock.mockImplementation(async () => {
      handlers['update-available']?.({ version: '2.1.0' })
    })
    const status = await checkForUpdate()
    expect(status).toEqual({ updateAvailable: true, version: '2.1.0' })
  })

  it('reports no update once autoUpdater emits update-not-available', async () => {
    checkForUpdatesMock.mockImplementation(async () => {
      handlers['update-not-available']?.()
    })
    const status = await checkForUpdate()
    expect(status).toEqual({ updateAvailable: false })
  })

  it('never throws — a feed failure (offline, no feed configured) reports no update', async () => {
    checkForUpdatesMock.mockRejectedValue(new Error('network down'))
    await expect(checkForUpdate()).resolves.toEqual({ updateAvailable: false })
  })
})
