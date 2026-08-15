/**
 * tests/unit/dialog-handlers.spec.ts — the Part-K SHOW_DIRECTORY_DIALOG (batch
 * output folder) + SHOW_IMAGE_DIALOG (brand logo) main handlers. Mirrors
 * video-open-dialog.spec: fake ipcMain/ctx, electron mocked. Asserts each picker
 * is hard-scoped server-side (least-privilege) and maps the result correctly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPCChannels } from '@shared/channels'

const showOpenDialog = vi.fn()
vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: () => '2.0.0' },
  dialog: {
    showOpenDialog: (...args: unknown[]) => showOpenDialog(...args),
    showSaveDialog: vi.fn()
  },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn() }
}))
// checkForUpdate() short-circuits on `!app.isPackaged` before ever touching
// autoUpdater (see updater.spec.ts for the real behaviour) — mocked here only
// so importing it in an unpackaged test env is inert.
vi.mock('electron-updater', () => ({ autoUpdater: { on: vi.fn(), checkForUpdates: vi.fn() } }))
vi.mock('@main/services/jobs/export-runner', () => ({ exportRunner: vi.fn() }))
vi.mock('@main/services/jobs/url-download-runner', () => ({ urlDownloadRunner: vi.fn() }))
vi.mock('@main/utils/ffprobe', () => ({ probeVideo: vi.fn() }))

import { registerVideoHandlers } from '@main/ipc/video'
import type { IpcContext } from '@main/ipc/index'

type Handler = (event: unknown, req: unknown) => Promise<unknown>

function makeCtx(): { ctx: IpcContext; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>()
  const ctx = {
    ipcMain: { handle: (channel: string, h: Handler) => handlers.set(channel, h) },
    getMainWindow: () => null,
    sidecar: {} as never,
    keyVault: {} as never
  } as unknown as IpcContext
  return { ctx, handlers }
}

describe('SHOW_DIRECTORY_DIALOG handler (batch output folder)', () => {
  beforeEach(() => showOpenDialog.mockReset())
  afterEach(() => vi.clearAllMocks())

  it('opens an openDirectory picker and maps to { canceled, dirPath }', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/Users/me/Movies/batch'] })
    const { ctx, handlers } = makeCtx()
    registerVideoHandlers(ctx)
    const h = handlers.get(IPCChannels.SHOW_DIRECTORY_DIALOG)!
    expect(h).toBeTruthy()
    const res = (await h({}, {})) as { canceled: boolean; dirPath?: string }
    expect(res).toEqual({ canceled: false, dirPath: '/Users/me/Movies/batch' })
    const opts = showOpenDialog.mock.calls[0][0] as Electron.OpenDialogOptions
    expect(opts.properties).toEqual(['openDirectory', 'createDirectory'])
  })

  it('maps a canceled dialog to { canceled:true, dirPath:undefined }', async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    const { ctx, handlers } = makeCtx()
    registerVideoHandlers(ctx)
    const res = (await handlers.get(IPCChannels.SHOW_DIRECTORY_DIALOG)!({}, {})) as {
      canceled: boolean
      dirPath?: string
    }
    expect(res).toEqual({ canceled: true, dirPath: undefined })
  })
})

describe('CHECK_UPDATE handler (audit fix openclip-4qr — was an unhandled channel)', () => {
  afterEach(() => vi.clearAllMocks())

  it('registers a system:check-update handler so the derived bridge method does not reject', async () => {
    const { ctx, handlers } = makeCtx()
    registerVideoHandlers(ctx)
    const h = handlers.get(IPCChannels.CHECK_UPDATE)
    expect(h).toBeTruthy() // previously absent → "No handler registered" at runtime
    const res = (await h!({}, undefined)) as { updateAvailable: boolean }
    // Wired to the real electron-updater feed (EPIC-k83ghw / FEAT-x9femg), which
    // is a no-op outside a packaged build (app.isPackaged is false here) — see
    // updater.spec.ts for the packaged-build behaviour.
    expect(res).toEqual({ updateAvailable: false })
  })
})

describe('SHOW_IMAGE_DIALOG handler (brand logo)', () => {
  beforeEach(() => showOpenDialog.mockReset())
  afterEach(() => vi.clearAllMocks())

  it('opens a single-file PNG picker (least-privilege) and returns filePaths', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/Users/me/logo.png'] })
    const { ctx, handlers } = makeCtx()
    registerVideoHandlers(ctx)
    const res = (await handlers.get(IPCChannels.SHOW_IMAGE_DIALOG)!({}, {})) as {
      canceled: boolean
      filePaths: string[]
    }
    expect(res).toEqual({ canceled: false, filePaths: ['/Users/me/logo.png'] })
    const opts = showOpenDialog.mock.calls[0][0] as Electron.OpenDialogOptions
    expect(opts.properties).toEqual(['openFile'])
    expect(opts.filters).toEqual([{ name: 'PNG Image', extensions: ['png'] }])
  })
})
