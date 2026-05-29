/**
 * tests/unit/video-open-dialog.spec.ts — the SHOW_OPEN_DIALOG main handler (F.3).
 *
 * Mirrors the existing IPC-handler test style (fake ipcMain + fake IpcContext,
 * `electron` mocked). Asserts the handler calls `dialog.showOpenDialog` with the
 * native picker defaults (openFile + the video extension filter) and maps the
 * result to `{ canceled, filePaths }`, including the canceled path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPCChannels } from '@shared/channels'

// Mock electron BEFORE importing the handler (which imports dialog/shell).
const showOpenDialog = vi.fn()
vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: (...args: unknown[]) => showOpenDialog(...args),
    showSaveDialog: vi.fn()
  },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn() }
}))
// Stub the runner modules so registerVideoHandlers' registerRunner calls are cheap
// and don't pull real yt-dlp / ffmpeg.
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

describe('SHOW_OPEN_DIALOG handler (F.3 native file picker)', () => {
  beforeEach(() => showOpenDialog.mockReset())
  afterEach(() => vi.clearAllMocks())

  it('opens the native picker with openFile + the video filter and returns filePaths', async () => {
    showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/Users/me/Movies/source.mp4']
    })
    const { ctx, handlers } = makeCtx()
    registerVideoHandlers(ctx)

    const h = handlers.get(IPCChannels.SHOW_OPEN_DIALOG)
    expect(h).toBeTruthy()
    const res = (await h!({}, {})) as { canceled: boolean; filePaths: string[] }

    expect(res).toEqual({ canceled: false, filePaths: ['/Users/me/Movies/source.mp4'] })
    // win is null in tests → no-window overload (single options arg).
    const opts = showOpenDialog.mock.calls[0][0] as Electron.OpenDialogOptions
    expect(opts.properties).toEqual(['openFile'])
    expect(opts.filters).toEqual([
      { name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi'] }
    ])
  })

  it('maps a canceled dialog to { canceled:true, filePaths:[] }', async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    const { ctx, handlers } = makeCtx()
    registerVideoHandlers(ctx)
    const h = handlers.get(IPCChannels.SHOW_OPEN_DIALOG)!
    const res = (await h({}, {})) as { canceled: boolean; filePaths: string[] }
    expect(res).toEqual({ canceled: true, filePaths: [] })
  })

  it('honors caller-provided properties/filters overrides', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/x'] })
    const { ctx, handlers } = makeCtx()
    registerVideoHandlers(ctx)
    const h = handlers.get(IPCChannels.SHOW_OPEN_DIALOG)!
    await h({}, { properties: ['openDirectory'], filters: [{ name: 'All', extensions: ['*'] }] })
    const opts = showOpenDialog.mock.calls[0][0] as Electron.OpenDialogOptions
    expect(opts.properties).toEqual(['openDirectory'])
    expect(opts.filters).toEqual([{ name: 'All', extensions: ['*'] }])
  })
})
