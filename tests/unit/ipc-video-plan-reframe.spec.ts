/**
 * tests/unit/ipc-video-plan-reframe.spec.ts — PLAN_REFRAME cancellation
 * (BUG-44fgyv).
 *
 * `planReframe` (main/services/reframe-detect.ts) already threads an
 * `AbortSignal` all the way down to both ffmpeg passes (`runFfmpeg` /
 * `defaultRunFfmpegCaptureStdout` both SIGKILL the child on abort) — it was
 * simply never wired up from the IPC handler. This proves the handler now
 * aborts a superseded in-flight request for the same project, and never
 * caches/reports a plan produced by an aborted run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IPCChannels } from '@shared/channels'

let cacheRoot: string

vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: () => '2.0.0' },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn() }
}))
vi.mock('electron-updater', () => ({ autoUpdater: { on: vi.fn(), checkForUpdates: vi.fn() } }))
vi.mock('@main/services/jobs/export-runner', () => ({ exportRunner: vi.fn() }))
vi.mock('@main/services/jobs/url-download-runner', () => ({ urlDownloadRunner: vi.fn() }))
vi.mock('@main/utils/ffprobe', () => ({ probeVideo: vi.fn() }))
// Real cacheDirFor touches Electron's app.getPath('temp'), unavailable here —
// point it at a real temp dir per test (mirrors ipc-project.spec.ts's
// tempRootFor mock).
vi.mock('@main/utils/paths', () => ({
  cacheDirFor: (): string => cacheRoot,
  isPackagedApp: () => false
}))

const planReframe = vi.fn()
vi.mock('@main/services/reframe-detect', () => ({
  planReframe: (...args: unknown[]) => planReframe(...args),
  DEFAULT_SAMPLE_FPS: 2
}))

import { registerVideoHandlers } from '@main/ipc/video'
import type { IpcContext } from '@main/ipc/index'

type Handler = (event: unknown, req: unknown) => Promise<unknown>

function makeCtx(): { ctx: IpcContext; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>()
  const ctx = {
    ipcMain: { handle: (channel: string, h: Handler) => handlers.set(channel, h) },
    getMainWindow: () => null,
    sidecar: {} as never,
    keyVault: {} as never,
    mediaAccess: { grant: vi.fn(), isAllowed: vi.fn() } as never
  } as unknown as IpcContext
  return { ctx, handlers }
}

const BASE_REQ = {
  projectId: 'p1',
  clipId: 'c1',
  sourcePath: '/tmp/does-not-need-to-exist.mp4',
  startTime: 0,
  endTime: 10,
  sourceResolution: { width: 1920, height: 1080 },
  aspectRatio: '9:16' as const,
  mode: 'auto' as const
}

beforeEach(async () => {
  cacheRoot = await mkdtemp(join(tmpdir(), 'openclip-reframe-cache-'))
  planReframe.mockReset()
})
afterEach(async () => {
  await rm(cacheRoot, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('PLAN_REFRAME: a newer request for the same project aborts the previous one', () => {
  it('passes an AbortSignal, and aborts the SUPERSEDED request when a new one starts', async () => {
    let firstSignal: AbortSignal | undefined
    let resolveFirst!: (v: unknown) => void
    const firstCall = new Promise((r) => {
      resolveFirst = r
    })
    planReframe.mockImplementationOnce(async (opts: { signal?: AbortSignal }) => {
      firstSignal = opts.signal
      return firstCall
    })
    planReframe.mockImplementationOnce(async () => ({
      mode: 'static',
      cropW: 1,
      cropH: 1,
      cropX: 0
    }))

    const { ctx, handlers } = makeCtx()
    registerVideoHandlers(ctx)
    const handler = handlers.get(IPCChannels.PLAN_REFRAME)!

    const p1 = handler({}, { ...BASE_REQ, clipId: 'c1' })
    // Give the first call's microtask a turn to register its signal.
    await Promise.resolve()
    expect(firstSignal?.aborted).toBe(false)

    const p2 = handler({}, { ...BASE_REQ, clipId: 'c2' })
    expect(firstSignal?.aborted).toBe(true)

    resolveFirst({ mode: 'static', cropW: 1, cropH: 1, cropX: 999 })
    await Promise.all([p1, p2])
  })

  it('an aborted request is reported as detect-failed and never cached', async () => {
    let resolveFirst!: (v: unknown) => void
    const firstCall = new Promise((r) => {
      resolveFirst = r
    })
    planReframe.mockImplementationOnce(async () => firstCall)
    planReframe.mockImplementationOnce(async () => ({
      mode: 'static',
      cropW: 1,
      cropH: 1,
      cropX: 0
    }))

    const { ctx, handlers } = makeCtx()
    registerVideoHandlers(ctx)
    const handler = handlers.get(IPCChannels.PLAN_REFRAME)!

    const p1 = handler({}, { ...BASE_REQ, clipId: 'c1' })
    await Promise.resolve()
    handler({}, { ...BASE_REQ, clipId: 'c2' }) // supersedes c1's in-flight request

    // The motion pass's own catch (reframe-detect.ts) can swallow an abort
    // into a degraded face-only plan rather than throwing — planReframe
    // resolving normally here still must not be trusted or cached.
    resolveFirst({ mode: 'static', cropW: 608, cropH: 1080, cropX: 42 })
    const res = (await p1) as { plan: unknown; reason?: string }
    expect(res.plan).toBeNull()
    expect(res.reason).toBe('detect-failed')

    // Confirm nothing was written under c1's cache key.
    const { readReframePlan, reframeCacheKey } = await import('@main/services/reframe-cache')
    const key = reframeCacheKey({
      clipId: 'c1',
      startTime: BASE_REQ.startTime,
      endTime: BASE_REQ.endTime,
      sourceMtimeMs: 0,
      sampleFps: 2,
      aspect: BASE_REQ.aspectRatio,
      mode: BASE_REQ.mode
    })
    expect(readReframePlan(cacheRoot, key)).toBeUndefined()
  })

  it('a DIFFERENT project is never aborted by an unrelated one', async () => {
    let signalForP1: AbortSignal | undefined
    planReframe.mockImplementationOnce(async (opts: { signal?: AbortSignal }) => {
      signalForP1 = opts.signal
      return { mode: 'static', cropW: 1, cropH: 1, cropX: 0 }
    })
    planReframe.mockImplementationOnce(async () => ({
      mode: 'static',
      cropW: 1,
      cropH: 1,
      cropX: 1
    }))

    const { ctx, handlers } = makeCtx()
    registerVideoHandlers(ctx)
    const handler = handlers.get(IPCChannels.PLAN_REFRAME)!

    await handler({}, { ...BASE_REQ, projectId: 'project-A' })
    await handler({}, { ...BASE_REQ, projectId: 'project-B' })
    expect(signalForP1?.aborted).toBe(false)
  })
})
