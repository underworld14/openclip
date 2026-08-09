/**
 * tests/unit/system-notify.spec.ts — the SYSTEM_NOTIFY handler (EPIC-zpa1nd /
 * FEAT-ckxz8d).
 *
 * The interesting behaviour is not "it shows a notification" — it is the
 * suppression rules, which are decided MAIN-SIDE because the main process is the
 * only side that knows whether the window has focus.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { IPCChannels } from '@shared/channels'

const shown: Array<{ title: string; body: string }> = []
const dock = { setBadge: vi.fn() }
let notificationSupported = true

vi.mock('electron', () => ({
  app: {
    get dock() {
      return dock
    }
  },
  Notification: Object.assign(
    class {
      constructor(private readonly opts: { title: string; body: string }) {}
      show(): void {
        shown.push(this.opts)
      }
    },
    { isSupported: () => notificationSupported }
  )
}))

vi.mock('@main/utils/paths', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return {
    ...actual,
    ffmpegPath: () => '/bin/ffmpeg',
    ffprobePath: () => '/bin/ffprobe',
    whisperCliPath: () => '/bin/whisper-cli',
    ytDlpPath: () => '/bin/yt-dlp'
  }
})

import { registerSystemPreflightHandler } from '@main/ipc/system'
import type { IpcContext } from '@main/ipc/index'

type Handler = (event: unknown, req: unknown) => Promise<unknown> | unknown

interface FakeWindow {
  isFocused: () => boolean
  once: (event: string, cb: () => void) => void
}

function makeCtx(win: FakeWindow | null): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  const ctx = {
    ipcMain: { handle: (channel: string, h: Handler) => handlers.set(channel, h) },
    getMainWindow: () => win,
    sidecar: {} as never,
    keyVault: {} as never
  } as unknown as IpcContext
  registerSystemPreflightHandler(ctx)
  return handlers
}

function fakeWindow(focused: boolean): FakeWindow & { fireFocus: () => void } {
  let onFocus: (() => void) | undefined
  return {
    isFocused: () => focused,
    once: (_event, cb) => {
      onFocus = cb
    },
    fireFocus: () => onFocus?.()
  }
}

beforeEach(() => {
  shown.length = 0
  dock.setBadge.mockReset()
  notificationSupported = true
})

describe('SYSTEM_NOTIFY', () => {
  const REQ = { title: 'talk.mp4 finished', body: 'Ready in OpenClip.' }

  it('stays silent when the user is already looking at the window', async () => {
    // Notifying someone who is watching the progress bar finish is noise.
    const handlers = makeCtx(fakeWindow(true))
    const res = await handlers.get(IPCChannels.SYSTEM_NOTIFY)!(null, REQ)

    expect(res).toEqual({ delivered: false })
    expect(shown).toHaveLength(0)
    expect(dock.setBadge).not.toHaveBeenCalled()
  })

  it('notifies and badges the dock when the window is in the background', async () => {
    const handlers = makeCtx(fakeWindow(false))
    const res = await handlers.get(IPCChannels.SYSTEM_NOTIFY)!(null, REQ)

    expect(res).toEqual({ delivered: true })
    expect(shown).toEqual([REQ])
    expect(dock.setBadge).toHaveBeenCalledWith('•')
  })

  it('clears the badge the next time the window is focused', async () => {
    // A badge that outlives the user's attention is just a stuck dot.
    const win = fakeWindow(false)
    const handlers = makeCtx(win)
    await handlers.get(IPCChannels.SYSTEM_NOTIFY)!(null, REQ)

    win.fireFocus()
    expect(dock.setBadge).toHaveBeenLastCalledWith('')
  })

  it('reports non-delivery rather than throwing where the OS has no notifications', async () => {
    notificationSupported = false
    const handlers = makeCtx(fakeWindow(false))

    const res = await handlers.get(IPCChannels.SYSTEM_NOTIFY)!(null, REQ)

    expect(res).toEqual({ delivered: false })
    expect(shown).toHaveLength(0)
  })

  it('still notifies when there is no window to ask about focus', async () => {
    const handlers = makeCtx(null)
    const res = await handlers.get(IPCChannels.SYSTEM_NOTIFY)!(null, REQ)

    expect(res).toEqual({ delivered: true })
    expect(shown).toHaveLength(1)
  })
})
