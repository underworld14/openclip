/**
 * tests/unit/ipc-project.spec.ts — T-Persist IPC wiring (plan E.3 / E.4).
 *
 * `registerProjectHandlers(ctx)` is the ONLY thing the frozen
 * `HANDLER_REGISTRARS` registry calls for the project domain. It must wire the
 * four project channels (SAVE/LOAD/LIST/DELETE — PRD §10.1) to `project-store`,
 * resolving the projects dir from trunk-frozen `utils/paths.ts` (mocked here so
 * no Electron `app` is touched). We drive the registered handlers exactly as
 * `ipcMain.handle` would, with the contract request payloads.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir: string
let mediaRoot: string

// Mock the trunk-frozen paths module so projectsDir()/mediaDir() point at our temp
// dirs (the real ones call Electron app.getPath('userData'), unavailable here).
vi.mock('@main/utils/paths', () => ({
  projectsDir: (): string => dir,
  mediaDir: (): string => mediaRoot
}))

import { registerProjectHandlers } from '@main/ipc/project'
import type { IpcContext } from '@main/ipc/index'
import { IPCChannels } from '@shared/channels'
import { projectFixture } from '../fixtures/contract'

type Handler = (event: unknown, ...args: unknown[]) => unknown

/** A fake ipcMain that records `handle()` registrations so tests can invoke them. */
function makeFakeContext(): {
  ctx: IpcContext
  invoke: (ch: string, req?: unknown) => Promise<unknown>
} {
  const handlers = new Map<string, Handler>()
  const ipcMain = {
    handle: (channel: string, listener: Handler) => handlers.set(channel, listener),
    handleOnce: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn()
  }
  const ctx = {
    ipcMain,
    getMainWindow: () => null,
    sidecar: {} as IpcContext['sidecar'],
    keyVault: {} as IpcContext['keyVault'],
    // LOAD_PROJECT now grants the source path to the media allow-list (audit fix
    // openclip-8tx); a no-op stub keeps these store-focused tests unaffected.
    mediaAccess: { grant: vi.fn(), isAllowed: vi.fn() } as IpcContext['mediaAccess']
  } as unknown as IpcContext

  const invoke = async (ch: string, req?: unknown): Promise<unknown> => {
    const h = handlers.get(ch)
    if (!h) throw new Error(`no handler registered for ${ch}`)
    return h({}, req)
  }
  return { ctx, invoke }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'openclip-ipc-'))
  mediaRoot = await mkdtemp(join(tmpdir(), 'openclip-media-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  await rm(mediaRoot, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('registerProjectHandlers wires the project channels', () => {
  it('registers exactly the four project channels', () => {
    const { ctx } = makeFakeContext()
    const handle = ctx.ipcMain.handle as unknown as ReturnType<typeof vi.fn>
    const spy = vi.spyOn(ctx.ipcMain, 'handle')
    registerProjectHandlers(ctx)
    const channels = spy.mock.calls.map((c) => c[0])
    expect(new Set(channels)).toEqual(
      new Set([
        IPCChannels.SAVE_PROJECT,
        IPCChannels.LOAD_PROJECT,
        IPCChannels.LIST_PROJECTS,
        IPCChannels.DELETE_PROJECT
      ])
    )
    void handle
  })

  it('SAVE then LOAD round-trips the project (save bumps updatedAt per PRD §9.3)', async () => {
    const { ctx, invoke } = makeFakeContext()
    registerProjectHandlers(ctx)

    const before = Date.now()
    const saveRes = (await invoke(IPCChannels.SAVE_PROJECT, {
      project: projectFixture
    })) as { path: string }
    expect(saveRes.path).toContain(`${projectFixture.id}.ocproj`)

    const loaded = (await invoke(IPCChannels.LOAD_PROJECT, {
      id: projectFixture.id
    })) as typeof projectFixture
    // The save handler stamps a fresh updatedAt; everything else round-trips.
    expect(loaded.updatedAt).toBeGreaterThanOrEqual(before)
    expect({ ...loaded, updatedAt: projectFixture.updatedAt }).toEqual(projectFixture)
  })

  it('LIST returns saved-project metadata (the LIST_PROJECTS res shape)', async () => {
    const { ctx, invoke } = makeFakeContext()
    registerProjectHandlers(ctx)
    await invoke(IPCChannels.SAVE_PROJECT, { project: projectFixture })

    const list = (await invoke(IPCChannels.LIST_PROJECTS)) as Array<{
      id: string
      name: string
      updatedAt: number
      path: string
    }>
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: projectFixture.id, name: projectFixture.name })
  })

  it('DELETE removes a project; a later LOAD rejects', async () => {
    const { ctx, invoke } = makeFakeContext()
    registerProjectHandlers(ctx)
    await invoke(IPCChannels.SAVE_PROJECT, { project: projectFixture })

    const del = (await invoke(IPCChannels.DELETE_PROJECT, { id: projectFixture.id })) as {
      deleted: boolean
    }
    expect(del).toEqual({ deleted: true })
    await expect(invoke(IPCChannels.LOAD_PROJECT, { id: projectFixture.id })).rejects.toThrow()
  })

  it('DELETE reclaims the project OWNED media dir but never a file outside mediaDir (Part H)', async () => {
    const { mkdir, writeFile, stat } = await import('node:fs/promises')
    const { ctx, invoke } = makeFakeContext()
    registerProjectHandlers(ctx)
    await invoke(IPCChannels.SAVE_PROJECT, { project: projectFixture })

    // Owned media for this project + a user's original OUTSIDE mediaDir.
    const owned = join(mediaRoot, projectFixture.id)
    await mkdir(owned, { recursive: true })
    await writeFile(join(owned, 'source.mp4'), 'video')
    const userOriginal = join(dir, 'my-original.mp4') // outside mediaRoot
    await writeFile(userOriginal, 'user file')

    await invoke(IPCChannels.DELETE_PROJECT, { id: projectFixture.id })

    await expect(stat(owned)).rejects.toThrow() // owned media reclaimed
    await expect(stat(userOriginal)).resolves.toBeTruthy() // user's original untouched
  })

  it('LOAD of a tampered/missing project rejects (typed error propagates over IPC)', async () => {
    const { ctx, invoke } = makeFakeContext()
    registerProjectHandlers(ctx)
    await expect(invoke(IPCChannels.LOAD_PROJECT, { id: 'ghost' })).rejects.toThrow()
  })
})
