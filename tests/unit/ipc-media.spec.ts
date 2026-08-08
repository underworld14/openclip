/**
 * tests/unit/ipc-media.spec.ts — the media IPC registrar (Part H). Drives the
 * registered MEDIA_ADOPT_SOURCE handler against a real temp media root (mocking
 * only the Electron-bound `mediaDir`), asserting it adopts a downloaded file into
 * media/<projectId>/ and rejects an unsafe projectId.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let mediaRoot: string
let work: string

vi.mock('@main/utils/paths', () => ({
  mediaDir: (): string => mediaRoot
}))

import { registerMediaHandlers } from '@main/ipc/media'
import type { IpcContext } from '@main/ipc/index'
import { IPCChannels } from '@shared/channels'

type Handler = (event: unknown, ...args: unknown[]) => unknown

function makeFakeContext(): {
  ctx: IpcContext
  invoke: (ch: string, req?: unknown) => Promise<unknown>
} {
  const handlers = new Map<string, Handler>()
  const ctx = {
    ipcMain: { handle: (c: string, h: Handler) => handlers.set(c, h) },
    getMainWindow: () => null,
    sidecar: {} as IpcContext['sidecar'],
    keyVault: {} as IpcContext['keyVault']
  } as unknown as IpcContext
  const invoke = async (ch: string, req?: unknown): Promise<unknown> => {
    const h = handlers.get(ch)
    if (!h) throw new Error(`no handler for ${ch}`)
    return h({}, req)
  }
  return { ctx, invoke }
}

beforeEach(async () => {
  mediaRoot = await mkdtemp(join(tmpdir(), 'oc-ipcmedia-'))
  work = await mkdtemp(join(tmpdir(), 'oc-ipcwork-'))
})
afterEach(async () => {
  await rm(mediaRoot, { recursive: true, force: true })
  await rm(work, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('registerMediaHandlers', () => {
  it('registers MEDIA_ADOPT_SOURCE and MEDIA_RECLAIM', () => {
    const { ctx } = makeFakeContext()
    const spy = vi.spyOn(ctx.ipcMain, 'handle')
    registerMediaHandlers(ctx)
    expect(spy.mock.calls.map((c) => c[0])).toEqual([
      IPCChannels.MEDIA_ADOPT_SOURCE,
      IPCChannels.MEDIA_RECLAIM
    ])
  })

  it('MEDIA_RECLAIM deletes the project media dir (openclip-e5s)', async () => {
    const { ctx, invoke } = makeFakeContext()
    registerMediaHandlers(ctx)
    // Adopt a file so media/<projectId>/ exists, then reclaim it.
    const src = join(work, 'v.mp4')
    await writeFile(src, 'VID')
    const { path } = (await invoke(IPCChannels.MEDIA_ADOPT_SOURCE, {
      projectId: 'p9',
      filePath: src
    })) as { path: string }
    expect(await readFile(path, 'utf8')).toBe('VID')
    const res = (await invoke(IPCChannels.MEDIA_RECLAIM, { projectId: 'p9' })) as {
      reclaimed: boolean
    }
    expect(res.reclaimed).toBe(true)
    await expect(readFile(path, 'utf8')).rejects.toThrow() // dir gone
  })

  it('adopts a downloaded file into media/<projectId>/ and returns its new path', async () => {
    const { ctx, invoke } = makeFakeContext()
    registerMediaHandlers(ctx)
    const src = join(work, 'M5XbNdzPuDQ.mp4')
    await writeFile(src, 'VID')
    const res = (await invoke(IPCChannels.MEDIA_ADOPT_SOURCE, {
      projectId: 'p1',
      filePath: src
    })) as { path: string }
    expect(res.path).toBe(join(mediaRoot, 'p1', 'M5XbNdzPuDQ.mp4'))
    expect(await readFile(res.path, 'utf8')).toBe('VID')
  })

  it('rejects a projectId with path separators (trust boundary)', async () => {
    const { ctx, invoke } = makeFakeContext()
    registerMediaHandlers(ctx)
    const src = join(work, 'v.mp4')
    await writeFile(src, 'x')
    await expect(
      invoke(IPCChannels.MEDIA_ADOPT_SOURCE, { projectId: '../escape', filePath: src })
    ).rejects.toThrow()
  })
})
