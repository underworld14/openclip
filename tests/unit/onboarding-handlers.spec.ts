/**
 * tests/unit/onboarding-handlers.spec.ts — the two main-side handlers that back
 * the first-run experience (EPIC-xzzpty):
 *
 *   - SYSTEM_PREFLIGHT (FEAT-c5a15c) — report which sidecar binaries actually
 *     resolved. `utils/paths.ts` has always resolved them; the app just never
 *     told the renderer, so a missing binary surfaced as a raw spawn error in the
 *     middle of an import instead of a red chip before the user started.
 *   - MODEL_DELETE (FEAT-1k76hk) — reclaim GGML model disk.
 *
 * Both are pure glue over injectable services, so no binary and no userData
 * directory are touched here.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { IPCChannels } from '@shared/channels'
import type { PreflightResult, ModelDeleteResult } from '@shared/channels'

const paths = {
  ffmpegPath: vi.fn(),
  ffprobePath: vi.fn(),
  whisperCliPath: vi.fn(),
  ytDlpPath: vi.fn()
}
vi.mock('@main/utils/paths', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return {
    ...actual,
    ffmpegPath: () => paths.ffmpegPath(),
    ffprobePath: () => paths.ffprobePath(),
    whisperCliPath: () => paths.whisperCliPath(),
    ytDlpPath: () => paths.ytDlpPath()
  }
})

const deleteModelMock = vi.fn()
vi.mock('@main/services/model-manager', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, deleteModel: (...a: unknown[]) => deleteModelMock(...a) }
})

vi.mock('@main/services/jobs/model-download-runner', () => ({ modelDownloadRunner: vi.fn() }))

import { registerModelHandlers } from '@main/ipc/model'
import { registerSystemPreflightHandler } from '@main/ipc/system'
import type { IpcContext } from '@main/ipc/index'

type Handler = (event: unknown, req: unknown) => Promise<unknown> | unknown

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

describe('SYSTEM_PREFLIGHT (FEAT-c5a15c)', () => {
  beforeEach(() => {
    for (const fn of Object.values(paths)) fn.mockReset()
  })

  it('reports every resolved binary with its path', async () => {
    paths.ffmpegPath.mockReturnValue('/bin/ffmpeg')
    paths.ffprobePath.mockReturnValue('/bin/ffprobe')
    paths.whisperCliPath.mockReturnValue('/bin/whisper-cli')
    paths.ytDlpPath.mockReturnValue('/bin/yt-dlp')

    const { ctx, handlers } = makeCtx()
    registerSystemPreflightHandler(ctx)
    const res = (await handlers.get(IPCChannels.SYSTEM_PREFLIGHT)!(null, undefined)) as PreflightResult

    expect(res.ffmpeg).toEqual({ ok: true, path: '/bin/ffmpeg' })
    expect(res.whisperCli).toEqual({ ok: true, path: '/bin/whisper-cli' })
    expect(res.ytDlp.ok).toBe(true)
  })

  it('reports a THROWING resolver as not-ok instead of failing the whole probe', async () => {
    // paths.ts throws when a binary cannot be located. One missing sidecar must
    // not blank the entire readiness bar — the user needs to see which one.
    paths.ffmpegPath.mockReturnValue('/bin/ffmpeg')
    paths.ffprobePath.mockReturnValue('/bin/ffprobe')
    paths.whisperCliPath.mockImplementation(() => {
      throw new Error('whisper-cli not found on PATH')
    })
    paths.ytDlpPath.mockReturnValue('/bin/yt-dlp')

    const { ctx, handlers } = makeCtx()
    registerSystemPreflightHandler(ctx)
    const res = (await handlers.get(IPCChannels.SYSTEM_PREFLIGHT)!(null, undefined)) as PreflightResult

    expect(res.whisperCli).toEqual({ ok: false })
    expect(res.ffmpeg.ok).toBe(true) // the rest still reported
  })

  it('treats an empty resolved path as not-ok', async () => {
    paths.ffmpegPath.mockReturnValue('')
    paths.ffprobePath.mockReturnValue('/bin/ffprobe')
    paths.whisperCliPath.mockReturnValue('/bin/whisper-cli')
    paths.ytDlpPath.mockReturnValue('/bin/yt-dlp')

    const { ctx, handlers } = makeCtx()
    registerSystemPreflightHandler(ctx)
    const res = (await handlers.get(IPCChannels.SYSTEM_PREFLIGHT)!(null, undefined)) as PreflightResult
    expect(res.ffmpeg.ok).toBe(false)
  })
})

describe('MODEL_DELETE (FEAT-1k76hk)', () => {
  beforeEach(() => deleteModelMock.mockReset())

  it('delegates to model-manager and returns the bytes reclaimed', async () => {
    deleteModelMock.mockReturnValue({ model: 'small', deleted: true, freedBytes: 466_000_000 })
    const { ctx, handlers } = makeCtx()
    registerModelHandlers(ctx)
    const res = (await handlers.get(IPCChannels.MODEL_DELETE)!(null, {
      model: 'small'
    })) as ModelDeleteResult
    expect(deleteModelMock).toHaveBeenCalledWith('small')
    expect(res.freedBytes).toBe(466_000_000)
  })

  it('rejects a model id outside the known set rather than deleting an arbitrary path', async () => {
    const { ctx, handlers } = makeCtx()
    registerModelHandlers(ctx)
    // The handler is synchronous; `ipcMain.handle` converts a sync throw into a
    // rejected invoke for the renderer, so a sync throw is the correct shape here.
    expect(() => handlers.get(IPCChannels.MODEL_DELETE)!(null, { model: '../../etc/passwd' })).toThrow(
      /unknown whisper model/i
    )
    expect(deleteModelMock).not.toHaveBeenCalled()
  })
})
